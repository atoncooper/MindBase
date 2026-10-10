import { describe, it, expect } from "vitest";
import { AppError, toErrorPayload, badRequest, internal } from "../src/transport/http/errors.js";
import { buildServer } from "../src/transport/http/server.js";
import type { ChatService } from "../src/services/chat.js";
import type { AgentHarness } from "../src/harness/app.js";
import type { RAGService } from "../src/rag/service.js";
import type { SessionDocumentRepository } from "../src/repository/session-docs.js";

describe("toErrorPayload mapping", () => {
  const rid = "req-1";

  it("AppError exposes its status/code/message", () => {
    const { status, body } = toErrorPayload(badRequest("参数不对"), rid);
    expect(status).toBe(400);
    expect(body).toMatchObject({ detail: "参数不对", code: "bad_request" });
    expect(body.error_id).toBeUndefined();
  });

  it("AppError with expose=false is sanitized", () => {
    const { status, body } = toErrorPayload(internal(), rid);
    expect(status).toBe(500);
    expect(body.detail).toBe("内部错误");
    expect(body.code).toBe("internal_error");
    expect(body.error_id).toBe(rid); // 5xx carries correlation id
  });

  it("framework 4xx passes message + code through", () => {
    const err = Object.assign(new Error("body must be json"), { statusCode: 400, code: "FST_ERR_CTP" });
    const { status, body } = toErrorPayload(err, rid);
    expect(status).toBe(400);
    expect(body).toMatchObject({ detail: "body must be json", code: "FST_ERR_CTP" });
  });

  it("unknown error → sanitized 500 with error_id", () => {
    const { status, body } = toErrorPayload(new Error("密码是 hunter2"), rid);
    expect(status).toBe(500);
    expect(body.detail).toBe("内部错误");
    expect(JSON.stringify(body)).not.toContain("hunter2");
    expect(body.error_id).toBe(rid);
  });

  it("upstream connectivity failure → sanitized 503 with actionable message", () => {
    const err = Object.assign(new Error("Failed after 3 attempts. Cannot connect to API: ECONNREFUSED 127.0.0.1:18080"), {
      name: "AI_RetryError",
    });
    const { status, body } = toErrorPayload(err, rid);
    expect(status).toBe(503);
    expect(body.detail).toBe("上游服务暂不可用，请稍后重试");
    expect(body.code).toBe("upstream_unavailable");
    expect(JSON.stringify(body)).not.toContain("18080");
  });
});

// ---- integration via app.inject (fake services) ----

function fakeRag(healthBehavior: "ok" | "throw"): RAGService {
  return {
    getCollectionStats: async () => {
      if (healthBehavior === "throw") throw new Error("db connection lost with secret info");
      return { collectionName: "c", totalChunks: 0, totalVideos: 0, available: false };
    },
  } as unknown as RAGService;
}

const fakeHarness = { runtimeStatus: () => ({}) } as unknown as AgentHarness;
const fakeDocs: SessionDocumentRepository = {
  save: async () => ({ id: "1", sessionId: "s", filename: "f", sizeBytes: 0, chunkCount: 0, createdAt: 0 }),
  list: async () => [],
  search: async () => [],
  deleteBySession: async () => 0,
};

describe("global error handler (integration)", () => {
  it("unexpected 5xx is sanitized and carries error_id + request id header", async () => {
    const app = await buildServer({
      chat: {} as ChatService,
      harness: fakeHarness,
      rag: fakeRag("throw"),
      sessionDocs: fakeDocs,
    });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.detail).toBe("内部错误");
    expect(JSON.stringify(body)).not.toContain("secret info");
    expect(body.error_id).toBeTruthy();
    expect(res.headers["x-request-id"]).toBeTruthy();
    await app.close();
  });

  it("404 handler returns structured body", async () => {
    const app = await buildServer({
      chat: {} as ChatService,
      harness: fakeHarness,
      rag: fakeRag("ok"),
      sessionDocs: fakeDocs,
    });
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "not_found" });
    await app.close();
  });

  it("SSE: exception thrown by the stream is converted into error + done frames", async () => {
    const brokenChat = {
      async *askStream() {
        yield { type: "route", agent: "main" };
        throw new Error("内部组件崩溃：secret-token-123");
      },
    } as unknown as ChatService;
    const app = await buildServer({
      chat: brokenChat,
      harness: fakeHarness,
      rag: fakeRag("ok"),
      sessionDocs: fakeDocs,
    });
    const res = await app.inject({ method: "POST", url: "/chat/ask/stream", payload: { query: "hi" } });
    const lines = res.body.split("\n").filter((l) => l.startsWith("data:"));
    const frames = lines.map((l) => JSON.parse(l.slice(5)));
    expect(frames[0].type).toBe("route");
    const errFrame = frames.find((f) => f.type === "error");
    expect(errFrame).toBeDefined();
    // the raw internal error must not leak into the SSE stream
    expect(errFrame.message).not.toContain("secret-token-123");
    expect(frames[frames.length - 1].type).toBe("done");
    await app.close();
  });
});
