import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppCloudClient,
  AppCloudError,
  type CloudSemanticHit,
  type CloudSemanticSearchResponse,
  type CloudSimilarResponse,
} from "../src/clients/app-cloud-client.js";
import {
  createCloudSemanticSearchTool,
  createCloudSimilarFilesTool,
} from "../src/tools/cloud/index.js";
import { ResultCollector } from "../src/context/types.js";
import type { ToolRunContext } from "../src/context/types.js";

/**
 * Offline tests for the cloud-drive retrieval tools: the app-cloud transport is
 * stubbed and the tools run against a fake client, so URL/header shape,
 * formatting, identity rules and degradation paths are covered without a Go
 * service.
 */

const UUID = "1f2e3d4c-5b6a-4789-8abc-def012345678";
const UUID2 = "2a3b4c5d-6e7f-4809-9abc-def012345679";
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

function hitBody(overrides: Partial<CloudSemanticHit> = {}): CloudSemanticHit {
  return {
    upload_uuid: UUID,
    original_name: "云盘架构说明.pdf",
    title: "云盘架构",
    mime_type: "application/pdf",
    file_size: 2048,
    score: 0.87,
    snippets: ["上传后异步生成摘要", "向量写入 Milvus"],
    ...overrides,
  };
}

const searchBody: CloudSemanticSearchResponse = {
  mode: "semantic",
  total: 2,
  results: [
    hitBody({ snippets: ["片段一", "片段二", "片段三", "片段四", "片段五"] }),
    hitBody({
      upload_uuid: UUID2,
      original_name: "会议纪要.md",
      title: "",
      mime_type: "text/markdown",
      score: 0.42,
      snippets: [],
    }),
  ],
};

type SemanticCall = { uid: string; query: string; opts?: { folderId?: number; limit?: number } };
type SimilarCall = { uid: string; uploadUuid: string; limit?: number };

/** Fake client: records calls, returns fixed payloads or throws fixed errors. */
function fakeSearchClient(
  semantic: CloudSemanticSearchResponse | Error,
  similar: CloudSimilarResponse | Error = { items: [] },
  opts: { configured?: boolean } = {},
) {
  const semanticCalls: SemanticCall[] = [];
  const similarCalls: SimilarCall[] = [];
  return {
    configured: opts.configured ?? true,
    semanticCalls,
    similarCalls,
    async searchSemantic(uid: string, query: string, callOpts?: { folderId?: number; limit?: number }) {
      semanticCalls.push({ uid, query, opts: callOpts });
      if (semantic instanceof Error) throw semantic;
      return semantic;
    },
    async getSimilar(uid: string, uploadUuid: string, limit?: number) {
      similarCalls.push({ uid, uploadUuid, limit });
      if (similar instanceof Error) throw similar;
      return similar;
    },
  };
}

function toolText(out: { content: string } | string): string {
  return typeof out === "string" ? out : out.content;
}

function toolSources(out: { sources?: Array<{ uploadUuid?: string; title?: string }> } | string) {
  return typeof out === "string" ? undefined : out.sources;
}

// ---------------------------------------------------------------------------
// Client transport
// ---------------------------------------------------------------------------

describe("AppCloudClient.searchSemantic", () => {
  it("calls /cloud/search/semantic with encoded query + folder/limit and the identity header", async () => {
    const fetchMock = stubFetch(200, searchBody);
    const client = new AppCloudClient({ baseUrl: BASE, apiKey: "internal-key", timeoutMs: 800 });
    const out = await client.searchSemantic("42", "云盘 架构", { folderId: 7, limit: 5 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/cloud/search/semantic");
    expect(parsed.searchParams.get("q")).toBe("云盘 架构");
    expect(parsed.searchParams.get("folderId")).toBe("7");
    expect(parsed.searchParams.get("limit")).toBe("5");
    const headers = new Headers(init.headers);
    expect(headers.get("X-Uid")).toBe("42");
    expect(headers.get("apikey")).toBe("internal-key");

    expect(out.mode).toBe("semantic");
    expect(out.total).toBe(2);
    expect(out.results).toHaveLength(2);
    expect(out.results[0]).toMatchObject({
      upload_uuid: UUID,
      original_name: "云盘架构说明.pdf",
      title: "云盘架构",
      mime_type: "application/pdf",
      file_size: 2048,
      score: 0.87,
    });
    expect(out.results[0]?.snippets).toEqual(["片段一", "片段二", "片段三", "片段四", "片段五"]);
    expect(out.results[1]?.title).toBe("");
  });

  it("omits optional query parameters and defaults total to the result count", async () => {
    const fetchMock = stubFetch(200, { mode: "semantic", results: [hitBody()] });
    const client = new AppCloudClient({ baseUrl: BASE, apiKey: "internal-key", timeoutMs: 800 });
    const out = await client.searchSemantic("42", "milvus");

    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.searchParams.has("folderId")).toBe(false);
    expect(parsed.searchParams.has("limit")).toBe(false);
    expect(out.total).toBe(1);
    expect(out.mode).toBe("semantic");
  });

  it("drops malformed result entries instead of failing the whole response", async () => {
    stubFetch(200, { mode: "semantic", total: 2, results: [hitBody(), { upload_uuid: "" }, null] });
    const client = new AppCloudClient({ baseUrl: BASE, apiKey: "internal-key", timeoutMs: 800 });
    const out = await client.searchSemantic("42", "milvus");
    expect(out.results).toHaveLength(1);
  });

  it("maps service failures to AppCloudError with status and detail", async () => {
    stubFetch(503, { detail: "语义检索暂不可用" });
    const client = new AppCloudClient({ baseUrl: BASE, apiKey: "internal-key", timeoutMs: 800 });
    const err = await client.searchSemantic("42", "milvus").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppCloudError);
    expect((err as AppCloudError).status).toBe(503);
    expect((err as AppCloudError).message).toContain("语义检索暂不可用");
  });

  it("wraps network failures in AppCloudError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")));
    const client = new AppCloudClient({ baseUrl: BASE, apiKey: "internal-key", timeoutMs: 800 });
    const err = await client.searchSemantic("42", "milvus").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppCloudError);
    expect((err as AppCloudError).message).toContain("ECONNREFUSED");
  });
});

describe("AppCloudClient.getSimilar", () => {
  it("calls /internal/cloud/similar with apikey + X-Uid + query identity and parses items", async () => {
    const fetchMock = stubFetch(200, { items: [hitBody({ score: 0.77 })] });
    const client = new AppCloudClient({ baseUrl: BASE, apiKey: "internal-key", timeoutMs: 800 });
    const out = await client.getSimilar("42", UUID, 3);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/internal/cloud/similar");
    expect(parsed.searchParams.get("uid")).toBe("42");
    expect(parsed.searchParams.get("upload_uuid")).toBe(UUID);
    expect(parsed.searchParams.get("limit")).toBe("3");
    const headers = new Headers(init.headers);
    expect(headers.get("apikey")).toBe("internal-key");
    expect(headers.get("X-Uid")).toBe("42");

    expect(out.items).toHaveLength(1);
    expect(out.items[0]?.score).toBe(0.77);
  });

  it("leaves the limit to the service when omitted and maps a 404 body", async () => {
    const fetchMock = stubFetch(200, { items: [] });
    const client = new AppCloudClient({ baseUrl: BASE, apiKey: "internal-key", timeoutMs: 800 });
    await client.getSimilar("42", UUID);
    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).searchParams.has("limit")).toBe(false);

    stubFetch(404, { detail: "File not found" });
    const err = await client.getSimilar("42", UUID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppCloudError);
    expect((err as AppCloudError).status).toBe(404);
    expect((err as AppCloudError).message).toContain("File not found");
  });
});

// ---------------------------------------------------------------------------
// cloud_semantic_search
// ---------------------------------------------------------------------------

describe("cloud_semantic_search tool", () => {
  it("formats file-level results (name, score, up to 3 snippets, uploadUuid) and emits sources", async () => {
    const client = fakeSearchClient(searchBody);
    const tool = createCloudSemanticSearchTool(client);
    const out = await tool.execute({ query: "云盘架构" }, makeCtx("42"));
    const content = toolText(out);

    expect(content).toContain("【云盘语义检索】");
    expect(content).toContain("云盘架构");
    expect(content).toContain("1. 云盘架构（score=0.8700）");
    expect(content).toContain(`uploadUuid：${UUID}`);
    expect(content).toContain("片段一");
    expect(content).toContain("片段三");
    expect(content).not.toContain("片段四"); // only the first 3 snippets reach the model
    expect(content).toContain("2. 会议纪要.md（score=0.4200）");

    expect(toolSources(out)).toEqual([
      { uploadUuid: UUID, title: "云盘架构" },
      { uploadUuid: UUID2, title: "会议纪要.md" }, // title falls back to the file name
    ]);
    expect(client.semanticCalls).toEqual([{ uid: "42", query: "云盘架构", opts: {} }]);
  });

  it("reports the service-side total when more files matched than were returned", async () => {
    const client = fakeSearchClient({ mode: "semantic", total: 7, results: searchBody.results });
    const tool = createCloudSemanticSearchTool(client);
    const out = await tool.execute({ query: "架构" }, makeCtx("42"));
    expect(toolText(out)).toContain("共 7 个，展示前 2 个");
  });

  it("forwards the folder scope and limit from validated arguments", async () => {
    const client = fakeSearchClient(searchBody);
    const tool = createCloudSemanticSearchTool(client);
    await tool.execute({ query: "架构", folderId: 7, limit: 5 }, makeCtx("42"));
    expect(client.semanticCalls).toEqual([{ uid: "42", query: "架构", opts: { folderId: 7, limit: 5 } }]);
  });

  it("answers with a clear notice when nothing matches", async () => {
    const client = fakeSearchClient({ mode: "semantic", results: [], total: 0 });
    const tool = createCloudSemanticSearchTool(client);
    const out = await tool.execute({ query: "不存在的内容" }, makeCtx("42"));
    const content = toolText(out);
    expect(content).toContain("没有找到");
    expect(content).toContain("vector_search");
    expect(toolSources(out)).toEqual([]);
  });

  it("turns a degraded search service into readable text instead of throwing", async () => {
    const client = fakeSearchClient(new AppCloudError("语义检索暂不可用", 503));
    const tool = createCloudSemanticSearchTool(client);
    const out = await tool.execute({ query: "架构" }, makeCtx("42"));
    expect(toolText(out)).toContain("暂不可用");
    expect(toolText(out)).toContain("语义检索暂不可用");
  });

  it("skips the call when app-cloud is unconfigured", async () => {
    const client = fakeSearchClient(searchBody, { items: [] }, { configured: false });
    const tool = createCloudSemanticSearchTool(client);
    const out = await tool.execute({ query: "架构" }, makeCtx("42"));
    expect(toolText(out)).toContain("未配置");
    expect(client.semanticCalls).toEqual([]);
  });

  it("refuses to search without a user identity", async () => {
    const client = fakeSearchClient(searchBody);
    const tool = createCloudSemanticSearchTool(client);
    const out = await tool.execute({ query: "架构" }, makeCtx(undefined));
    expect(toolText(out)).toContain("没有用户身份");
    expect(client.semanticCalls).toEqual([]);
  });

  it("validates query/folderId/limit and never accepts a uid argument", () => {
    const tool = createCloudSemanticSearchTool(fakeSearchClient(searchBody));
    const schema = tool.inputSchema as { safeParse(value: unknown): { success: boolean; data?: Record<string, unknown> } };

    expect(schema.safeParse({ query: "" }).success).toBe(false);
    expect(schema.safeParse({ query: "a".repeat(500) }).success).toBe(true);
    expect(schema.safeParse({ query: "a".repeat(501) }).success).toBe(false);
    expect(schema.safeParse({ query: "a", folderId: 0 }).success).toBe(false);
    expect(schema.safeParse({ query: "a", folderId: -1 }).success).toBe(false);
    expect(schema.safeParse({ query: "a", folderId: 1.5 }).success).toBe(false);
    expect(schema.safeParse({ query: "a", folderId: 1 }).success).toBe(true);
    expect(schema.safeParse({ query: "a", limit: 0 }).success).toBe(false);
    expect(schema.safeParse({ query: "a", limit: 21 }).success).toBe(false);
    expect(schema.safeParse({ query: "a", limit: 1 }).success).toBe(true);
    expect(schema.safeParse({ query: "a", limit: 20 }).success).toBe(true);

    const parsed = schema.safeParse({ query: "架构", uid: "999" });
    expect(parsed.success).toBe(true);
    expect(parsed.data).not.toHaveProperty("uid");
  });
});

// ---------------------------------------------------------------------------
// cloud_similar_files
// ---------------------------------------------------------------------------

describe("cloud_similar_files tool", () => {
  it("lists similar files with score/snippets/uploadUuid and emits sources", async () => {
    const client = fakeSearchClient(searchBody, {
      items: [
        hitBody({ upload_uuid: UUID2, original_name: "同类资料.pdf", title: "", score: 0.66, snippets: ["相近内容"] }),
      ],
    });
    const tool = createCloudSimilarFilesTool(client);
    const out = await tool.execute({ uploadUuid: UUID, limit: 3 }, makeCtx("42"));
    const content = toolText(out);

    expect(content).toContain("【相似云盘文件】");
    expect(content).toContain("1. 同类资料.pdf（score=0.6600）");
    expect(content).toContain(`uploadUuid：${UUID2}`);
    expect(content).toContain("相近内容");
    expect(toolSources(out)).toEqual([{ uploadUuid: UUID2, title: "同类资料.pdf" }]);
    expect(client.similarCalls).toEqual([{ uid: "42", uploadUuid: UUID, limit: 3 }]);
  });

  it("answers with a clear notice when no similar file exists", async () => {
    const client = fakeSearchClient(searchBody, { items: [] });
    const tool = createCloudSimilarFilesTool(client);
    const out = await tool.execute({ uploadUuid: UUID }, makeCtx("42"));
    expect(toolText(out)).toContain("没有找到");
    expect(toolSources(out)).toEqual([]);
  });

  it("turns a degraded service into readable text and never leaks uid into arguments", async () => {
    const client = fakeSearchClient(searchBody, new AppCloudError("语义检索暂不可用", 503));
    const tool = createCloudSimilarFilesTool(client);
    const out = await tool.execute({ uploadUuid: UUID }, makeCtx("42"));
    expect(toolText(out)).toContain("暂不可用");
    expect(client.similarCalls).toEqual([{ uid: "42", uploadUuid: UUID, limit: undefined }]);
  });

  it("skips the call when app-cloud is unconfigured", async () => {
    const client = fakeSearchClient(searchBody, { items: [] }, { configured: false });
    const tool = createCloudSimilarFilesTool(client);
    const out = await tool.execute({ uploadUuid: UUID }, makeCtx("42"));
    expect(toolText(out)).toContain("未配置");
    expect(client.similarCalls).toEqual([]);
  });

  it("refuses to look up similar files without a user identity", async () => {
    const client = fakeSearchClient(searchBody, { items: [] });
    const tool = createCloudSimilarFilesTool(client);
    const out = await tool.execute({ uploadUuid: UUID }, makeCtx(undefined));
    expect(toolText(out)).toContain("没有用户身份");
    expect(client.similarCalls).toEqual([]);
  });

  it("validates uploadUuid/limit and never accepts a uid argument", () => {
    const tool = createCloudSimilarFilesTool(fakeSearchClient(searchBody, { items: [] }));
    const schema = tool.inputSchema as { safeParse(value: unknown): { success: boolean; data?: Record<string, unknown> } };

    expect(schema.safeParse({ uploadUuid: "a".repeat(15) }).success).toBe(false);
    expect(schema.safeParse({ uploadUuid: "a".repeat(16) }).success).toBe(true);
    expect(schema.safeParse({ uploadUuid: "a".repeat(128) }).success).toBe(true);
    expect(schema.safeParse({ uploadUuid: "a".repeat(129) }).success).toBe(false);
    expect(schema.safeParse({ uploadUuid: UUID, limit: 0 }).success).toBe(false);
    expect(schema.safeParse({ uploadUuid: UUID, limit: 11 }).success).toBe(false);
    expect(schema.safeParse({ uploadUuid: UUID, limit: 1 }).success).toBe(true);
    expect(schema.safeParse({ uploadUuid: UUID, limit: 10 }).success).toBe(true);

    const parsed = schema.safeParse({ uploadUuid: UUID, uid: "999" });
    expect(parsed.success).toBe(true);
    expect(parsed.data).not.toHaveProperty("uid");
  });
});
