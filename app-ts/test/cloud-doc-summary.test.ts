import { afterEach, describe, expect, it, vi } from "vitest";
import { AppCloudClient, AppCloudError, type CloudSummaryResponse } from "../src/auth/app-cloud-client.js";
import { createCloudDocSummaryTool, formatCloudSummary } from "../src/tools/cloud/index.js";
import { ResultCollector } from "../src/context/types.js";
import type { ToolRunContext } from "../src/context/types.js";

/**
 * Offline tests: the app-cloud HTTP face is stubbed, and the tool is exercised
 * with a fake client so formatting/identity rules are verified without a
 * running Go service.
 */

const UUID = "1f2e3d4c-5b6a-4789-8abc-def012345678"; // 36 chars, inside 16-128
const BASE = "http://cloud.test:8007/";

function stubFetch(status: number, body: unknown) {
  const fn = vi.fn(async () =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeCtx(uid: string | undefined): ToolRunContext {
  return { uid, scope: {}, collector: new ResultCollector() };
}

function summaryBody(overrides: Record<string, unknown> = {}) {
  return {
    upload_uuid: UUID,
    available: true,
    stale: false,
    model: "z-ai/glm-5.3-flash",
    summary: {
      overview: "介绍云盘上传与摘要闭环。",
      topics: ["云盘", "摘要"],
      entities: ["app-cloud", "Milvus"],
      key_points: ["上传后异步生成摘要", "摘要写入 Mongo"],
      todos: ["补充 OCR 用例", "回归语义检索"],
      answers_questions: ["摘要怎么生成？", "支持哪些文件类型？"],
      language: "zh",
      size_chars: 1234,
    },
    ...overrides,
  };
}

const fullResponse: CloudSummaryResponse = {
  upload_uuid: UUID,
  available: true,
  stale: false,
  model: "z-ai/glm-5.3-flash",
  title: "云盘架构说明.pdf",
  summary: {
    overview: "介绍云盘上传与摘要闭环。",
    topics: ["云盘", "摘要"],
    entities: ["app-cloud", "Milvus"],
    key_points: ["上传后异步生成摘要", "摘要写入 Mongo"],
    todos: ["补充 OCR 用例", "回归语义检索"],
    answers_questions: ["摘要怎么生成？", "支持哪些文件类型？"],
    language: "zh",
    size_chars: 1234,
  },
};

/** Fake client: records calls, returns a fixed response or throws a fixed error. */
function fakeClient(
  result: CloudSummaryResponse | Error,
  opts: { configured?: boolean } = {},
): {
  configured: boolean;
  calls: Array<{ uid: string; uploadUuid: string }>;
  getSummary(uid: string, uploadUuid: string): Promise<CloudSummaryResponse>;
} {
  const calls: Array<{ uid: string; uploadUuid: string }> = [];
  return {
    configured: opts.configured ?? true,
    calls,
    async getSummary(uid: string, uploadUuid: string) {
      calls.push({ uid, uploadUuid });
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Client transport
// ---------------------------------------------------------------------------

describe("AppCloudClient.getSummary", () => {
  it("calls the internal summary face with apikey + X-Uid + query identity and normalizes the payload", async () => {
    const fetchMock = stubFetch(200, summaryBody({ summary: { ...summaryBody().summary, todos: undefined } }));
    const client = new AppCloudClient({ baseUrl: BASE, apiKey: "internal-key", timeoutMs: 800 });
    const out = await client.getSummary("42", UUID);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://cloud.test:8007/internal/cloud/summary?uid=42&upload_uuid=${UUID}`);
    const headers = new Headers(init.headers);
    expect(headers.get("apikey")).toBe("internal-key");
    expect(headers.get("X-Uid")).toBe("42");

    expect(out.upload_uuid).toBe(UUID);
    expect(out.available).toBe(true);
    expect(out.summary?.todos).toEqual([]); // legacy summary documents have no todos
    expect(out.title).toBeUndefined();
  });

  it("does not cache: every call hits the service", async () => {
    const fetchMock = stubFetch(200, summaryBody());
    const client = new AppCloudClient({ baseUrl: BASE, apiKey: "internal-key", timeoutMs: 800 });
    await client.getSummary("42", UUID);
    await client.getSummary("42", UUID);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("maps a service error to AppCloudError with status and detail", async () => {
    stubFetch(503, { detail: "摘要服务未配置" });
    const client = new AppCloudClient({ baseUrl: BASE, apiKey: "internal-key", timeoutMs: 800 });
    const err = await client.getSummary("42", UUID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppCloudError);
    expect((err as AppCloudError).status).toBe(503);
    expect((err as AppCloudError).message).toContain("摘要服务未配置");
  });

  it("wraps network failures in AppCloudError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")));
    const client = new AppCloudClient({ baseUrl: BASE, apiKey: "internal-key", timeoutMs: 800 });
    const err = await client.getSummary("42", UUID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppCloudError);
    expect((err as AppCloudError).message).toContain("ECONNREFUSED");
  });

  it("reports itself unconfigured unless both baseUrl and apiKey are present", () => {
    expect(new AppCloudClient({ baseUrl: "", apiKey: "k", timeoutMs: 800 }).configured).toBe(false);
    expect(new AppCloudClient({ baseUrl: BASE, apiKey: "", timeoutMs: 800 }).configured).toBe(false);
    expect(new AppCloudClient({ baseUrl: BASE, apiKey: "k", timeoutMs: 800 }).configured).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

describe("cloud_doc_summary tool", () => {
  it("formats every summary section and emits the document as a source", async () => {
    const client = fakeClient(fullResponse);
    const tool = createCloudDocSummaryTool(client);
    const out = await tool.execute({ uploadUuid: UUID }, makeCtx("42"));
    const content = typeof out === "string" ? out : out.content;

    expect(content).toContain("【云盘文档摘要】云盘架构说明.pdf");
    expect(content).toContain("介绍云盘上传与摘要闭环。");
    expect(content).toContain("主题：云盘、摘要");
    expect(content).toContain("实体：app-cloud、Milvus");
    expect(content).toContain("1. 上传后异步生成摘要");
    expect(content).toContain("1. 补充 OCR 用例");
    expect(content).toContain("1. 摘要怎么生成？");
    expect(content).not.toContain("较早版本");

    const sources = typeof out === "string" ? undefined : out.sources;
    expect(sources).toEqual([{ uploadUuid: UUID, title: "云盘架构说明.pdf" }]);
    expect(client.calls).toEqual([{ uid: "42", uploadUuid: UUID }]);
  });

  it("marks a stale summary as generated from an older revision", async () => {
    const client = fakeClient({ ...fullResponse, stale: true });
    const tool = createCloudDocSummaryTool(client);
    const out = await tool.execute({ uploadUuid: UUID }, makeCtx("42"));
    const content = typeof out === "string" ? out : out.content;
    expect(content).toContain("较早版本");
    expect(content).toContain("重新入库");
  });

  it("returns a plain notice when no summary has been generated yet", async () => {
    const client = fakeClient({
      upload_uuid: UUID,
      available: false,
      stale: false,
      model: "",
      summary: null,
      original_name: "旧文档.docx",
    });
    const tool = createCloudDocSummaryTool(client);
    const out = await tool.execute({ uploadUuid: UUID }, makeCtx("42"));
    const content = typeof out === "string" ? out : out.content;
    expect(content).toContain("摘要尚未生成");
    expect(content).not.toContain("工具执行失败");
    const sources = typeof out === "string" ? undefined : out.sources;
    expect(sources).toEqual([{ uploadUuid: UUID, title: "旧文档.docx" }]);
  });

  it("turns a service failure into a readable message instead of throwing", async () => {
    const client = fakeClient(new AppCloudError("云盘摘要服务不可用", 503));
    const tool = createCloudDocSummaryTool(client);
    const out = await tool.execute({ uploadUuid: UUID }, makeCtx("42"));
    const content = typeof out === "string" ? out : out.content;
    expect(content).toContain("暂不可用");
    expect(content).toContain("云盘摘要服务不可用");
  });

  it("answers with a not-configured notice and skips the call when app-cloud is unconfigured", async () => {
    const client = fakeClient(fullResponse, { configured: false });
    const tool = createCloudDocSummaryTool(client);
    const out = await tool.execute({ uploadUuid: UUID }, makeCtx("42"));
    const content = typeof out === "string" ? out : out.content;
    expect(content).toContain("未配置");
    expect(client.calls).toEqual([]);
  });

  it("refuses to read without a user identity (uid is never model-supplied)", async () => {
    const client = fakeClient(fullResponse);
    const tool = createCloudDocSummaryTool(client);
    const out = await tool.execute({ uploadUuid: UUID }, makeCtx(undefined));
    const content = typeof out === "string" ? out : out.content;
    expect(content).toContain("没有用户身份");
    expect(client.calls).toEqual([]);
  });

  it("validates uploadUuid length (16-128) and accepts no uid field", () => {
    const tool = createCloudDocSummaryTool(fakeClient(fullResponse));
    const schema = tool.inputSchema as { safeParse(value: unknown): { success: boolean; data?: Record<string, unknown> } };

    expect(schema.safeParse({ uploadUuid: "a".repeat(15) }).success).toBe(false);
    expect(schema.safeParse({ uploadUuid: "a".repeat(16) }).success).toBe(true);
    expect(schema.safeParse({ uploadUuid: "a".repeat(128) }).success).toBe(true);
    expect(schema.safeParse({ uploadUuid: "a".repeat(129) }).success).toBe(false);
    expect(schema.safeParse({ uploadUuid: 42 }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);

    const parsed = schema.safeParse({ uploadUuid: UUID, uid: "999" });
    expect(parsed.success).toBe(true);
    expect(parsed.data).not.toHaveProperty("uid");
  });

  it("formats an empty (but generated) summary with explicit placeholders", () => {
    const text = formatCloudSummary({
      overview: "",
      topics: [],
      entities: [],
      key_points: [],
      todos: [],
      answers_questions: [],
      language: "",
      size_chars: 0,
    });
    expect(text).toContain("概览：\n（无）");
    expect(text).toContain("主题：（无）");
    expect(text).toContain("关键点：\n（无）");
  });
});
