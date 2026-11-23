import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LanguageModel } from "ai";
import { config } from "../src/config/index.js";
import {
  CHAT_MODEL_ID_MAX_CHARS,
  CHAT_MODELS_FILE,
  loadChatModels,
  parseChatModelCatalog,
  type ChatModelCatalog,
} from "../src/config/chat-models.js";
import { buildServer } from "../src/transport/http/server.js";
import { ChatService } from "../src/services/chat.js";
import { MemoryChatSessionRepository, MemoryMessageRepository } from "../src/repository/memory/chat-store.js";
import type { AgentHarness } from "../src/harness/app.js";
import type { RAGService } from "../src/rag/service.js";
import type { SessionDocumentRepository } from "../src/repository/session-docs.js";
import type { ModelCapabilityRegistry } from "../src/llm/model-capabilities.js";
import type { SseFrame } from "../src/transport/sse.js";
import type { QuotaService } from "../src/services/quota.js";
import type { UsageLedgerRepository, UsageTurnRecord } from "../src/repository/usage-ledger.js";

/**
 * Chat model catalog (config/model.json) + per-turn model selection:
 * loader validation/fallback, GET /chat/models, body validation (unknown id /
 * image-incompatible model), ChatService precedence (catalog > Coding Plan >
 * default), the dispatchStream LanguageModel bug fix and model-aware accounting.
 * Offline: gateway model objects are never invoked by the fake harness.
 */

const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

const fallbackDefault = "fallback/model";

let tmpDir = "";

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mindbase-chat-models-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
});

async function writeCatalog(name: string, value: unknown): Promise<string> {
  const file = path.join(tmpDir, name);
  await fs.writeFile(file, typeof value === "string" ? value : JSON.stringify(value), "utf8");
  return file;
}

describe("chat model catalog · loader", () => {
  it("loads the committed app-ts/config/model.json (default + picker entries)", () => {
    const catalog = loadChatModels(config.llm.model);
    expect(catalog.default).toBe("z-ai/glm-5.3-flash");
    expect(catalog.models.length).toBeGreaterThanOrEqual(8);
    const ids = catalog.models.map((entry) => entry.id);
    expect(ids).toContain("z-ai/glm-5.3-flash");
    expect(ids).toContain("z-ai/glm-5.3");
    expect(ids).toContain("openai/gpt-6.1-terra");
    const first = catalog.models.find((entry) => entry.id === "z-ai/glm-5.3-flash");
    expect(first?.label).toBeTruthy();
    expect(first?.vision).toBe(true);
    // the catalog file really is resolved from the module URL, not the cwd
    expect(CHAT_MODELS_FILE.endsWith(path.join("config", "model.json"))).toBe(true);
  });

  it("accepts a valid catalog file with optional description/vision", async () => {
    const file = await writeCatalog("valid.json", {
      default: "m-a",
      models: [
        { id: "m-a", label: "模型 A", description: "  快速  ", vision: true },
        { id: "m-b", label: "模型 B", vision: false },
      ],
    });
    const catalog = loadChatModels(fallbackDefault, { filePath: file });
    expect(catalog.default).toBe("m-a");
    expect(catalog.models).toEqual([
      { id: "m-a", label: "模型 A", description: "快速", vision: true },
      { id: "m-b", label: "模型 B", vision: false },
    ]);
  });

  it("falls back to a single default model when the file is missing or not JSON", async () => {
    const missing = loadChatModels(fallbackDefault, { filePath: path.join(tmpDir, "nope.json") });
    expect(missing).toEqual({ default: fallbackDefault, models: [{ id: fallbackDefault, label: fallbackDefault }] });

    const broken = loadChatModels(fallbackDefault, { filePath: await writeCatalog("broken.json", "{ not json") });
    expect(broken.default).toBe(fallbackDefault);
    expect(broken.models).toHaveLength(1);
  });

  it("falls back when default is missing or not present in models", async () => {
    const noDefault = loadChatModels(fallbackDefault, {
      filePath: await writeCatalog("no-default.json", { models: [{ id: "m-a", label: "A" }] }),
    });
    expect(noDefault.default).toBe(fallbackDefault);

    const defaultElsewhere = loadChatModels(fallbackDefault, {
      filePath: await writeCatalog("default-elsewhere.json", { default: "m-z", models: [{ id: "m-a", label: "A" }] }),
    });
    expect(defaultElsewhere.models.map((entry) => entry.id)).toEqual([fallbackDefault]);
  });

  it("falls back on duplicate ids/labels, empty models and invalid field types", async () => {
    const duplicateId = loadChatModels(fallbackDefault, {
      filePath: await writeCatalog("dup-id.json", {
        default: "m-a",
        models: [{ id: "m-a", label: "A" }, { id: "m-a", label: "B" }],
      }),
    });
    expect(duplicateId.models).toHaveLength(1);

    const duplicateLabel = loadChatModels(fallbackDefault, {
      filePath: await writeCatalog("dup-label.json", {
        default: "m-a",
        models: [{ id: "m-a", label: "同名" }, { id: "m-b", label: "同名" }],
      }),
    });
    expect(duplicateLabel.models).toHaveLength(1);

    const emptyModels = await writeCatalog("empty.json", { default: "m-a", models: [] });
    expect(loadChatModels(fallbackDefault, { filePath: emptyModels }).models).toHaveLength(1);

    const badVision = await writeCatalog("bad-vision.json", {
      default: "m-a",
      models: [{ id: "m-a", label: "A", vision: "yes" }],
    });
    expect(loadChatModels(fallbackDefault, { filePath: badVision }).models).toHaveLength(1);
  });

  it("parseChatModelCatalog rejects a non-object payload", () => {
    expect(parseChatModelCatalog("nope", fallbackDefault).default).toBe(fallbackDefault);
    expect(parseChatModelCatalog(null, fallbackDefault).models).toEqual([
      { id: fallbackDefault, label: fallbackDefault },
    ]);
  });
});

// ---------------------------------------------------------------------------
// HTTP surface: GET /chat/models + ask-body validation
// ---------------------------------------------------------------------------

interface CapturedChat {
  chatCalls: Array<Record<string, unknown>>;
}

const fakeSessionDocs: SessionDocumentRepository = {
  save: async () => ({ id: "1", sessionId: "s", filename: "f", sizeBytes: 0, chunkCount: 0, createdAt: 0 }),
  list: async () => [],
  search: async () => [],
  delete: async () => false,
  deleteBySession: async () => 0,
};

const fakeRag = { getCollectionStats: async () => ({}) } as unknown as RAGService;

function makeCapabilities(vision: boolean, source: "override" | "openrouter" | "default" = "default"): ModelCapabilityRegistry {
  return { get: () => ({ vision, toolCalls: true, source }) } as unknown as ModelCapabilityRegistry;
}

async function buildApp(options: { catalog?: ChatModelCatalog; capabilities?: ModelCapabilityRegistry } = {}) {
  const chatCalls: Array<Record<string, unknown>> = [];
  const chat = {
    askStream: async function* (req: Record<string, unknown>) {
      chatCalls.push(req);
      yield { type: "done" } as SseFrame;
    },
  } as unknown as ChatService;
  const app = await buildServer({
    chat,
    harness: { runtimeStatus: () => ({}) } as unknown as AgentHarness,
    rag: fakeRag,
    sessionDocs: fakeSessionDocs,
    capabilities: options.capabilities ?? makeCapabilities(true),
    ocr: { enabled: false } as never,
    ...(options.catalog ? { chatModels: options.catalog } : {}),
  } as Parameters<typeof buildServer>[0]);
  return { app, chatCalls };
}

describe("GET /chat/models", () => {
  let app: Awaited<ReturnType<typeof buildApp>>["app"] | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("serves the default catalog (default + selectable models, no secrets)", async () => {
    const built = await buildApp();
    app = built.app;
    const res = await app.inject({ method: "GET", url: "/chat/models" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { default: string; models: Array<Record<string, unknown>> };
    expect(body.default).toBe("z-ai/glm-5.3-flash");
    const ids = body.models.map((entry) => entry.id);
    expect(ids).toContain("z-ai/glm-5.3-flash");
    expect(ids).toContain("z-ai/glm-5.3");
    expect(ids).toContain("openai/gpt-6.1-terra");
    expect(ids.length).toBeGreaterThanOrEqual(8);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.keys(body).sort()).toEqual(["default", "models"]);
    for (const entry of body.models) {
      expect(Object.keys(entry)).toContain("id");
      expect(Object.keys(entry)).toContain("label");
    }
  });

  it("serves an injected catalog verbatim (tests / future config sources)", async () => {
    const catalog: ChatModelCatalog = { default: "m-a", models: [{ id: "m-a", label: "A", vision: false }] };
    const built = await buildApp({ catalog });
    app = built.app;
    const res = await app.inject({ method: "GET", url: "/chat/models" });
    expect(res.json()).toEqual(catalog);
  });
});

describe("POST /chat/ask/stream model selection", () => {
  let app: Awaited<ReturnType<typeof buildApp>>["app"] | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("passes a valid catalog model to ChatService as chatModel (never as the Coding Plan id)", async () => {
    const built = await buildApp();
    app = built.app;
    const res = await app.inject({
      method: "POST",
      url: "/chat/ask/stream",
      headers: { "x-uid": "42" },
      payload: { query: "hi", model: "  z-ai/glm-5.3  " },
    });
    expect(res.statusCode).toBe(200);
    expect(built.chatCalls[0]?.chatModel).toBe("z-ai/glm-5.3");
    expect(built.chatCalls[0]?.model).toBeUndefined();
  });

  it("omits chatModel when the body carries none (service default applies)", async () => {
    const built = await buildApp();
    app = built.app;
    const res = await app.inject({
      method: "POST",
      url: "/chat/ask/stream",
      payload: { query: "hi" },
    });
    expect(res.statusCode).toBe(200);
    expect(built.chatCalls[0]?.chatModel).toBeUndefined();
  });

  it("rejects an unknown model with 400 instead of silently using the default", async () => {
    const built = await buildApp();
    app = built.app;
    const res = await app.inject({
      method: "POST",
      url: "/chat/ask/stream",
      payload: { query: "hi", model: "no-such-model" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toContain("不支持的聊天模型");
    expect(res.json().detail).toContain("z-ai/glm-5.3-flash");
    expect(built.chatCalls).toHaveLength(0);
  });

  it("rejects an over-long model id with 400", async () => {
    const built = await buildApp();
    app = built.app;
    const res = await app.inject({
      method: "POST",
      url: "/chat/ask/stream",
      payload: { query: "hi", model: "x".repeat(CHAT_MODEL_ID_MAX_CHARS + 1) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toContain("model 过长");
  });

  it("rejects images when the selected catalog entry declares vision=false", async () => {
    const catalog: ChatModelCatalog = {
      default: "text-only/model",
      models: [{ id: "text-only/model", label: "纯文本", vision: false }],
    };
    const built = await buildApp({ catalog, capabilities: makeCapabilities(true) });
    app = built.app;
    const res = await app.inject({
      method: "POST",
      url: "/chat/ask/stream",
      payload: { query: "看图", images: [PNG_DATA_URL] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toContain("不支持图片");
    expect(built.chatCalls).toHaveLength(0);
  });

  it("keeps the capability-registry gate for catalog entries with unknown vision", async () => {
    const catalog: ChatModelCatalog = { default: "m-unknown", models: [{ id: "m-unknown", label: "U" }] };
    const built = await buildApp({ catalog, capabilities: makeCapabilities(false, "openrouter") });
    app = built.app;
    const res = await app.inject({
      method: "POST",
      url: "/chat/ask/stream",
      payload: { query: "看图", images: [PNG_DATA_URL] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toContain("不支持视觉");
  });
});

// ---------------------------------------------------------------------------
// ChatService: model precedence, LanguageModel pass-through, accounting
// ---------------------------------------------------------------------------

function makeHarness(frames: SseFrame[]) {
  const captured: Array<Record<string, unknown>> = [];
  const harness = {
    dispatchStream: async function* (input: Record<string, unknown>) {
      captured.push(input);
      for (const frame of frames) yield frame;
    },
  } as unknown as AgentHarness;
  return { harness, captured };
}

function makeLedger() {
  const rows: UsageTurnRecord[] = [];
  const ledger = {
    recordTurn: async (rec: UsageTurnRecord) => {
      rows.push(rec);
    },
  } as unknown as UsageLedgerRepository;
  return { ledger, rows };
}

function makeQuota() {
  const completeCalls: Array<{ model: string }> = [];
  const quota = {
    beginChatTurn: async () => null,
    canConsume: async () => true,
    completeChatTurn: async (_uid: string | undefined, _clientKey: string | undefined, _usage: unknown, model: string) => {
      completeCalls.push({ model });
    },
  } as unknown as QuotaService;
  return { quota, completeCalls };
}

async function drain(gen: AsyncGenerator<SseFrame>, guardMs = 4000): Promise<SseFrame[]> {
  const frames: SseFrame[] = [];
  const deadline = Date.now() + guardMs;
  while (Date.now() < deadline) {
    const next = await gen.next();
    if (next.done) break;
    frames.push(next.value);
  }
  return frames;
}

function modelIdOf(model: unknown): string | undefined {
  return typeof model === "object" && model !== null ? (model as { modelId?: string }).modelId : undefined;
}

const USAGE_FRAME: SseFrame = { type: "usage", usage: { inputTokens: 1000, outputTokens: 1000 } };

describe("ChatService · per-turn model", () => {
  it("turns a chat-catalog pick into a gateway LanguageModel with that model id", async () => {
    const { harness, captured } = makeHarness([USAGE_FRAME, { type: "done" }]);
    const chat = new ChatService(harness, new MemoryChatSessionRepository(), new MemoryMessageRepository());
    await drain(chat.askStream({ query: "hi", sessionId: "s-model-1", uid: "1", chatModel: "z-ai/glm-5.3" }));
    expect(typeof captured[0]?.model).toBe("object");
    expect(modelIdOf(captured[0]?.model)).toBe("z-ai/glm-5.3");
  });

  it("passes no model at all when the turn has no pick (service default path)", async () => {
    const { harness, captured } = makeHarness([{ type: "done" }]);
    const chat = new ChatService(harness, new MemoryChatSessionRepository(), new MemoryMessageRepository());
    await drain(chat.askStream({ query: "hi", sessionId: "s-model-2", uid: "1" }));
    expect(captured[0]).not.toHaveProperty("model");
  });

  it("keeps the Coding Plan branch working with a LanguageModel (dispatchStream overwrite bug fixed)", async () => {
    const planModel = { modelId: "plan/model", provider: "mock" } as unknown as LanguageModel;
    let resolverCalls = 0;
    const { harness, captured } = makeHarness([{ type: "done" }]);
    const chat = new ChatService(
      harness,
      new MemoryChatSessionRepository(),
      new MemoryMessageRepository(),
      undefined,
      undefined,
      null,
      undefined,
      null,
      null,
      undefined,
      undefined,
      async () => {
        resolverCalls += 1;
        return planModel;
      },
    );
    await drain(chat.askStream({ query: "hi", sessionId: "s-model-3", uid: "1", model: "plan/model" }));
    expect(resolverCalls).toBe(1);
    // the resolved object reaches the harness — the old code spread the raw id
    // string after it and react.ts received a non-model value
    expect(captured[0]?.model).toBe(planModel);
    expect(typeof captured[0]?.model).not.toBe("string");
  });

  it("prefers the chat-catalog pick over the Coding Plan pick", async () => {
    let resolverCalls = 0;
    const { harness, captured } = makeHarness([{ type: "done" }]);
    const chat = new ChatService(
      harness,
      new MemoryChatSessionRepository(),
      new MemoryMessageRepository(),
      undefined,
      undefined,
      null,
      undefined,
      null,
      null,
      undefined,
      undefined,
      async () => {
        resolverCalls += 1;
        return { modelId: "plan/model", provider: "mock" } as unknown as LanguageModel;
      },
    );
    await drain(
      chat.askStream({
        query: "hi",
        sessionId: "s-model-4",
        uid: "1",
        chatModel: "z-ai/glm-5.3",
        model: "plan/model",
      }),
    );
    expect(resolverCalls).toBe(0);
    expect(modelIdOf(captured[0]?.model)).toBe("z-ai/glm-5.3");
  });

  it("records an unpriced model in the ledger and prices it with the default fallback", async () => {
    const { harness } = makeHarness([USAGE_FRAME, { type: "done" }]);
    const { ledger, rows } = makeLedger();
    const { quota, completeCalls } = makeQuota();
    const chat = new ChatService(
      harness,
      new MemoryChatSessionRepository(),
      new MemoryMessageRepository(),
      undefined,
      undefined,
      null,
      undefined,
      quota,
      ledger,
    );
    await drain(chat.askStream({ query: "hi", sessionId: "s-model-5", uid: "1", chatModel: "test/unpriced-model" }));
    expect(rows).toHaveLength(1);
    expect(rows[0].model).toBe("test/unpriced-model");
    // unpriced model → the default model's price snapshot keeps the cost real
    // (1000 in × 0.188 + 1000 out × 6.48 = 6668 micro-Yuan), not 0/undefined
    expect(rows[0].costMicroYuan).toBe(6668);
    expect(completeCalls[0]?.model).toBe("test/unpriced-model");
  });

  it("records the service default when no model was picked", async () => {
    const { harness } = makeHarness([USAGE_FRAME, { type: "done" }]);
    const { ledger, rows } = makeLedger();
    const chat = new ChatService(
      harness,
      new MemoryChatSessionRepository(),
      new MemoryMessageRepository(),
      undefined,
      undefined,
      null,
      undefined,
      null,
      ledger,
    );
    await drain(chat.askStream({ query: "hi", sessionId: "s-model-6", uid: "1" }));
    expect(rows[0].model).toBe(config.llm.model);
    expect(rows[0].costMicroYuan).toBe(6668);
  });
});
