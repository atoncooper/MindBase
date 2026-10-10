import { describe, it, expect, vi, afterEach } from "vitest";
import { buildServer } from "../src/transport/http/server.js";
import type { AgentHarness } from "../src/harness/app.js";
import type { ChatService } from "../src/services/chat.js";
import type { RAGService } from "../src/rag/service.js";
import type { SessionDocumentRepository } from "../src/repository/session-docs.js";
import type { SseFrame } from "../src/transport/sse.js";
import type { AgentInvokeInput } from "../src/agent/types.js";

/**
 * POST /v1/chat/completions — OpenAI-compatible surface. The custom frame stream
 * is mapped lossily onto OpenAI chunks (content/reasoning_content/usage), stateless
 * (no session persistence, no agent-context binding), client system messages ride
 * below the agent prompt.
 */

function fakeHarness(frames: SseFrame[]) {
  const captured: AgentInvokeInput[] = [];
  const harness = {
    runtimeStatus: () => ({}),
    dispatchStream: async function* (input: AgentInvokeInput) {
      captured.push(input);
      yield* frames;
    },
  } as unknown as AgentHarness;
  return { harness, captured };
}

const baseDeps = () => ({
  chat: {} as ChatService,
  rag: {
    getCollectionStats: async () => ({ collectionName: "c", totalChunks: 0, totalVideos: 0, available: false }),
    addCloudContent: async () => 0,
    deleteCloudVectors: async () => {},
  } as unknown as RAGService,
  sessionDocs: {
    save: async () => ({ id: "1", sessionId: "s", filename: "f", sizeBytes: 0, chunkCount: 0, createdAt: 0 }),
    list: async () => [],
    search: async () => [],
    deleteBySession: async () => 0,
  } as SessionDocumentRepository,
});

const CHAT_MESSAGES = [
  { role: "system", content: "你是 cats-only 机器人" },
  { role: "user", content: "第一问" },
  { role: "assistant", content: "第一答" },
  { role: "user", content: "第二问" },
];

const parseSse = (body: string) =>
  body
    .split("\n\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.slice(6))
    .filter((l) => l !== "[DONE]")
    .map((l) => JSON.parse(l));

describe("/v1/chat/completions (OpenAI compat)", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it("stream=true: custom frames map to OpenAI deltas, finish + [DONE]", async () => {
    const { harness, captured } = fakeHarness([
      { type: "route", agent: "main" },
      { type: "chunk", content: "你好" },
      { type: "reasoning", content: "内部思考" },
      { type: "chunk", content: "，世界" },
      { type: "interact", interact: { kind: "confirm", question: "确认删除？", options: [{ label: "确认", value: "yes" }] } },
      { type: "usage", usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } },
      { type: "done" },
    ]);
    const app = await buildServer({
      chat: {} as ChatService,
      harness,
      rag: { getCollectionStats: async () => ({ collectionName: "c", totalChunks: 0, totalVideos: 0, available: false }) } as unknown as RAGService,
      sessionDocs: {
        save: async () => ({ id: "1", sessionId: "s", filename: "f", sizeBytes: 0, chunkCount: 0, createdAt: 0 }),
        list: async () => [],
        search: async () => [],
        deleteBySession: async () => 0,
      },
    } as Parameters<typeof buildServer>[0]);

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-uid": "42" },
      payload: { model: "whatever", messages: CHAT_MESSAGES, stream: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    const raw = res.body.split("\n\n").filter((l) => l.startsWith("data: "));
    expect(raw.at(-1)).toBe("data: [DONE]");
    const chunks = parseSse(res.body);

    expect(chunks[0].choices[0].delta).toEqual({ role: "assistant", content: "" });
    const contents = chunks.map((c) => c.choices[0].delta.content).filter(Boolean);
    expect(contents).toEqual(["你好", "，世界", "确认删除？\n- 确认\n"]);
    expect(chunks.some((c) => c.choices[0].delta.reasoning_content === "内部思考")).toBe(true);
    const final = chunks.at(-1)!;
    expect(final.choices[0].finish_reason).toBe("stop");
    expect(final.usage).toEqual({ prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 });
    expect(final.object).toBe("chat.completion.chunk");
    expect(final.model).toBe("whatever");

    // stateless mapping: history carries prior turns, query = last user msg,
    // extraSystem from client system message, no agent-context binding
    expect(captured[0].query).toBe("第二问");
    expect(captured[0].history).toEqual([
      { role: "user", content: "第一问" },
      { role: "assistant", content: "第一答" },
    ]);
    expect(captured[0].extraSystem).toBe("你是 cats-only 机器人");
    expect(captured[0].chatSessionId).toBeUndefined();
    expect(captured[0].uid).toBe(42);
    await app.close();
  });

  it("stream=false: frames aggregate into one chat.completion message", async () => {
    const { harness } = fakeHarness([
      { type: "chunk", content: "答案甲" },
      { type: "chunk", content: "答案乙" },
      { type: "usage", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } },
      { type: "done" },
    ]);
    const app = await buildServer({
      chat: {} as ChatService,
      harness,
      rag: { getCollectionStats: async () => ({ collectionName: "c", totalChunks: 0, totalVideos: 0, available: false }) } as unknown as RAGService,
      sessionDocs: {
        save: async () => ({ id: "1", sessionId: "s", filename: "f", sizeBytes: 0, chunkCount: 0, createdAt: 0 }),
        list: async () => [],
        search: async () => [],
        deleteBySession: async () => 0,
      },
    } as Parameters<typeof buildServer>[0]);

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { messages: [{ role: "user", content: "问" }] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message).toEqual({ role: "assistant", content: "答案甲答案乙" });
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.usage).toEqual({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
    await app.close();
  });

  it("error frame becomes a content delta but the stream still finishes cleanly", async () => {
    const { harness } = fakeHarness([
      { type: "chunk", content: "半截" },
      { type: "error", message: "milvus down" },
      { type: "done" },
    ]);
    const app = await buildServer({
      chat: {} as ChatService,
      harness,
      rag: { getCollectionStats: async () => ({ collectionName: "c", totalChunks: 0, totalVideos: 0, available: false }) } as unknown as RAGService,
      sessionDocs: {
        save: async () => ({ id: "1", sessionId: "s", filename: "f", sizeBytes: 0, chunkCount: 0, createdAt: 0 }),
        list: async () => [],
        search: async () => [],
        deleteBySession: async () => 0,
      },
    } as Parameters<typeof buildServer>[0]);

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { messages: [{ role: "user", content: "问" }], stream: true },
    });
    const chunks = parseSse(res.body);
    const text = chunks.map((c) => c.choices[0].delta.content ?? "").join("");
    expect(text).toContain("半截");
    expect(text).toContain("[处理失败] milvus down");
    expect(chunks.at(-1)!.choices[0].finish_reason).toBe("stop");
    await app.close();
  });

  it("400 in OpenAI error shape: empty messages / last message not user", async () => {
    const { harness } = fakeHarness([]);
    const app = await buildServer({
      chat: {} as ChatService,
      harness,
      rag: { getCollectionStats: async () => ({ collectionName: "c", totalChunks: 0, totalVideos: 0, available: false }) } as unknown as RAGService,
      sessionDocs: {
        save: async () => ({ id: "1", sessionId: "s", filename: "f", sizeBytes: 0, chunkCount: 0, createdAt: 0 }),
        list: async () => [],
        search: async () => [],
        deleteBySession: async () => 0,
      },
    } as Parameters<typeof buildServer>[0]);

    const empty = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: { messages: [] } });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error.type).toBe("invalid_request_error");

    const notUser = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { messages: [{ role: "user", content: "问" }, { role: "assistant", content: "答" }] },
    });
    expect(notUser.statusCode).toBe(400);
    await app.close();
  });
});
