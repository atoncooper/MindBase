import { describe, it, expect, afterEach } from "vitest";
import { simulateReadableStream, type LanguageModelV2StreamPart } from "ai";
import { MockLanguageModelV2 } from "ai/test";
import { buildServer } from "../src/transport/http/server.js";
import { MemoryChatSessionRepository, MemoryMessageRepository } from "../src/repository/memory/chat-store.js";
import type { AgentHarness } from "../src/harness/app.js";
import type { RAGService } from "../src/rag/service.js";
import type { SessionDocumentRepository } from "../src/repository/session-docs.js";
import type { ModelCapabilityRegistry } from "../src/llm/model-capabilities.js";
import type { ChatService } from "../src/services/chat.js";
import type { SseFrame } from "../src/transport/sse.js";

/**
 * 多模态聊天链路：/chat/ask/stream 的图片校验与视觉门控、ChatService 落库透传、
 * react 把图片组装为 AI SDK image part、/v1 的 image_url 抽取（data URL only）。
 */

const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
const JPG_DATA_URL = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";

const fakeSessionDocs: SessionDocumentRepository = {
  save: async () => ({ id: "1", sessionId: "s", filename: "f", sizeBytes: 0, chunkCount: 0, createdAt: 0 }),
  list: async () => [],
  search: async () => [],
  deleteBySession: async () => 0,
};

const fakeRag = {
  getCollectionStats: async () => ({ collectionName: "c", totalChunks: 0, totalVideos: 0, available: false }),
  addCloudContent: async () => 0,
  deleteCloudVectors: async () => {},
} as unknown as RAGService;

function makeHarness() {
  const captured: Array<Record<string, unknown>> = [];
  const harness = {
    runtimeStatus: () => ({}),
    dispatchStream: async function* (input: Record<string, unknown>) {
      captured.push(input);
      yield { type: "done" } as SseFrame;
    },
  } as unknown as AgentHarness;
  return { harness, captured };
}

function makeChat() {
  const captured: Array<Record<string, unknown>> = [];
  const chat = {
    askStream: async function* (req: Record<string, unknown>) {
      captured.push(req);
      yield { type: "done" };
    },
  } as unknown as ChatService;
  return { chat, captured };
}

function makeCapabilities(vision: boolean, source: "override" | "openrouter" | "default" = "openrouter"): ModelCapabilityRegistry {
  return { get: () => ({ vision, toolCalls: true, source }) } as unknown as ModelCapabilityRegistry;
}

async function build(vision: boolean, source: "override" | "openrouter" | "default" = "openrouter") {
  const { chat, captured: chatCaptured } = makeChat();
  const app = await buildServer({
    chat: chat as unknown as ChatService,
    harness: makeHarness().harness,
    rag: fakeRag,
    sessionDocs: fakeSessionDocs,
    capabilities: makeCapabilities(vision, source),
    ocr: { enabled: false } as never,
  } as Parameters<typeof buildServer>[0]);
  return { app, chatCaptured };
}

describe("POST /chat/ask/stream 多模态", () => {
  let app: Awaited<ReturnType<typeof build>> | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("vision 模型：images 校验通过并透传到 ChatService", async () => {
    const built = await build(true);
    app = built.app;
    const res = await app.inject({
      method: "POST",
      url: "/chat/ask/stream",
      headers: { "x-uid": "42" },
      payload: { query: "看这张图", images: [PNG_DATA_URL, JPG_DATA_URL] },
    });
    expect(res.statusCode).toBe(200);
    expect(built.chatCaptured[0]).toMatchObject({ query: "看这张图", images: [PNG_DATA_URL, JPG_DATA_URL], uid: "42" });
  });

  it("vision=false（有据）：400 且明确提示配置视觉模型", async () => {
    const built = await build(false, "openrouter");
    app = built.app;
    const res = await app.inject({
      method: "POST",
      url: "/chat/ask/stream",
      payload: { query: "看图", images: [PNG_DATA_URL] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toContain("不支持视觉");
  });

  it("未知模型（registry 默认 text-only 猜测）放行——Higress 独有视觉模型不被误拦", async () => {
    const built = await build(false, "default");
    app = built.app;
    const res = await app.inject({
      method: "POST",
      url: "/chat/ask/stream",
      payload: { query: "看图", images: [PNG_DATA_URL] },
    });
    expect(res.statusCode).toBe(200);
    expect(built.chatCaptured[0]?.images).toEqual([PNG_DATA_URL]);
  });

  it("图片数量超限（>4）→ 400", async () => {
    const built = await build(true);
    app = built.app;
    const res = await app.inject({
      method: "POST",
      url: "/chat/ask/stream",
      payload: { query: "看图", images: Array.from({ length: 5 }, () => PNG_DATA_URL) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toContain("最多 4 张");
  });

  it("非 data URL 的图片 → 400（拒绝外链，防 SSRF 面）", async () => {
    const built = await build(true);
    app = built.app;
    const res = await app.inject({
      method: "POST",
      url: "/chat/ask/stream",
      payload: { query: "看图", images: ["https://evil.example.com/x.png"] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toContain("data:image");
  });

  it("单张超大数据 URL → 400", async () => {
    const built = await build(true);
    app = built.app;
    const big = PNG_DATA_URL.slice(0, 30) + "A".repeat(3 * 1024 * 1024);
    const res = await app.inject({
      method: "POST",
      url: "/chat/ask/stream",
      payload: { query: "看图", images: [big] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toContain("过大");
  });

  it("无 images 时零校验开销（普通文本路径不受影响）", async () => {
    const built = await build(false);
    app = built.app;
    const res = await app.inject({
      method: "POST",
      url: "/chat/ask/stream",
      payload: { query: "普通文本问" },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("/v1/chat/completions image_url", () => {
  it("data URL 图片抽取进 input.images；外链图片 URL → 400", async () => {
    const { harness, captured } = makeHarness();
    const app = await buildServer({
      chat: {} as ChatService,
      harness,
      rag: fakeRag,
      sessionDocs: fakeSessionDocs,
      capabilities: makeCapabilities(true),
      ocr: { enabled: false } as never,
    } as Parameters<typeof buildServer>[0]);

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { "x-uid": "42" },
      payload: {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "看图" },
              { type: "image_url", image_url: { url: PNG_DATA_URL } },
            ],
          },
        ],
        stream: false,
      },
    });
    expect(res.statusCode).toBe(200);
    expect((captured[0] as { images?: string[] }).images).toEqual([PNG_DATA_URL]);

    const bad = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "看图" },
              { type: "image_url", image_url: { url: "https://evil.example.com/x.png" } },
            ],
          },
        ],
      },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toContain("data:image");
    await app.close();
  });
});

describe("react 多模态消息构建", () => {
  it("images → user content 数组含 image part；历史带图重放", async () => {
    const { createReactAgent } = await import("../src/agent/react.js");
    const model = new MockLanguageModelV2({
      doStream: async () => ({
        stream: simulateReadableStream({
          initialDelayInMs: 10,
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "response-metadata", id: "r1", modelId: "mock", timestamp: new Date() },
            { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
          ] as LanguageModelV2StreamPart[],
        }),
      }),
    });
    const runtime = { buildSdkTools: () => ({}) } as unknown as import("../src/tools/runtime.js").AgentRuntime;
    const agent = createReactAgent({
      name: "main",
      description: "main",
      runtime,
      toolNames: [],
      purpose: "chat",
      buildSystemPrompt: async () => "sys",
      model,
    });
    for await (const _ of agent.run({
      query: "看图",
      scope: {},
      history: [{ role: "user", content: "上一条", images: [JPG_DATA_URL] }],
      images: [PNG_DATA_URL],
    })) {
      void _;
    }
    // AI SDK decodes data-URL images into file parts at the model layer:
    // { type: "file", mediaType: "image/png", data: Uint8Array }
    const messages = model.doStreamCalls[0].prompt as unknown as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    const user = messages.at(-1)!;
    expect(user.role).toBe("user");
    expect(user.content.some((p) => p.type === "text" && p.text === "看图")).toBe(true);
    const filePart = user.content.find((p) => p.type === "file");
    expect(filePart).toBeDefined();
    if (filePart) {
      expect(filePart.mediaType).toBe("image/png");
      // SDK v5 keeps the data-URL payload as latin1 bytes (no base64 decode at
      // this layer) — the decoded binary equals the original base64 text
      expect(Buffer.from(filePart.data as Uint8Array).toString("latin1")).toBe("iVBORw0KGgoAAAANSUhEUg==");
    }
    const prior = messages.at(-2)!;
    const priorFile = prior.content.find((p) => p.type === "file");
    expect(priorFile).toBeDefined();
    if (priorFile) {
      expect(priorFile.mediaType).toBe("image/jpeg");
      expect(Buffer.from(priorFile.data as Uint8Array).toString("latin1")).toBe("/9j/4AAQSkZJRg==");
    }
  });
});

describe("persistence: user message images", () => {
  it("memory beginTurn 存储 images 并在 recentMessages 返回", async () => {
    const sessions = new MemoryChatSessionRepository();
    const messages = new MemoryMessageRepository();
    await sessions.getOrCreate("s1", 1);
    await messages.beginTurn("s1", "看图", [PNG_DATA_URL]);
    const history = await messages.recentMessages("s1", 10);
    const user = history.find((m) => m.role === "user")!;
    expect(user.images).toEqual([PNG_DATA_URL]);
  });
});
