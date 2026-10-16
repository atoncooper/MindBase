import { describe, it, expect, afterEach } from "vitest";
import { ChatService } from "../src/services/chat.js";
import { QuotaService } from "../src/services/quota.js";
import { MemoryQuotaCounter } from "../src/repository/memory/quota-counter.js";
import { MemoryUsageLedger } from "../src/repository/memory/usage-ledger.js";
import { MemoryChatSessionRepository, MemoryMessageRepository } from "../src/repository/memory/chat-store.js";
import type { AgentHarness } from "../src/harness/app.js";
import type { SseFrame } from "../src/transport/sse.js";
import { config } from "../src/config/index.js";

/**
 * ChatService × QuotaService integration: the gate fires
 * BEFORE admission/persistence/harness; consume-on-success; failed turns
 * never consume; anonymous flows keyed by the hashed client IP.
 */

const savedQuota = structuredClone(config.quota);
afterEach(() => {
  config.quota = savedQuota;
});

async function drain(gen: AsyncGenerator<SseFrame>, guardMs = 4000): Promise<SseFrame[]> {
  const frames: SseFrame[] = [];
  const deadline = Date.now() + guardMs;
  while (Date.now() < deadline) {
    const r = await gen.next();
    if (r.done) break;
    frames.push(r.value);
  }
  return frames;
}

function passthroughHarness(): AgentHarness {
  return {
    dispatchStream: async function* (): AsyncGenerator<SseFrame> {
      yield { type: "route", agent: "main" };
      yield { type: "chunk", content: "ok" };
      yield { type: "done" };
    },
  } as unknown as AgentHarness;
}

function errorHarness(): AgentHarness {
  return {
    dispatchStream: async function* (): AsyncGenerator<SseFrame> {
      yield { type: "route", agent: "main" };
      yield { type: "error", message: "boom" };
      yield { type: "done" };
    },
  } as unknown as AgentHarness;
}

function makeChat(opts: { harness?: AgentHarness; quota?: QuotaService | null; ledger?: MemoryUsageLedger } = {}) {
  const dispatchSpy = { calls: 0 };
  const raw = opts.harness ?? passthroughHarness();
  const harness = {
    dispatchStream: async function* (req: Parameters<AgentHarness["dispatchStream"]>[0]) {
      dispatchSpy.calls += 1;
      yield* raw.dispatchStream(req);
    },
  } as unknown as AgentHarness;
  const chat = new ChatService(
    harness,
    new MemoryChatSessionRepository(),
    new MemoryMessageRepository(),
    undefined,
    undefined,
    null,
    undefined,
    opts.quota ?? null,
    opts.ledger ?? null,
  );
  return { chat, dispatchSpy };
}

function makeQuota(tier: string): QuotaService {
  return new QuotaService({ counter: new MemoryQuotaCounter(), resolveTier: async () => tier });
}

describe("ChatService × quota", () => {
  it("admits under the limit, consumes on success, records the ledger row", async () => {
    const ledger = new MemoryUsageLedger();
    const { chat } = makeChat({ quota: makeQuota("vip"), ledger });
    const frames = await drain(chat.askStream({ query: "hi", sessionId: "s1", uid: "u1" }));
    expect(frames.map((f) => f.type)).toEqual(["route", "chunk", "done"]);
    expect(frames.some((f) => f.type === "error")).toBe(false);
    const rows = ledger.snapshot();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ uid: "u1", purpose: "chat", model: config.llm.model, calls: 1 });
  });

  it("rejects the turn over the limit BEFORE admission with QUOTA_EXCEEDED", async () => {
    config.quota.limits.chat = { free: 1, vip: 1, svip: 1 };
    const { chat, dispatchSpy } = makeChat({ quota: makeQuota("vip") });
    await drain(chat.askStream({ query: "first", sessionId: "s2", uid: "u1" }));
    const frames = await drain(chat.askStream({ query: "second", sessionId: "s3", uid: "u1" }));
    expect(dispatchSpy.calls).toBe(1); // the rejected turn never reached the harness
    expect(frames).toHaveLength(2);
    const err = frames[0];
    expect(err.type).toBe("error");
    if (err.type === "error") {
      expect(err.code).toBe("QUOTA_EXCEEDED");
      expect((err.detail as Record<string, unknown>).kind).toBe("chat");
      expect((err.detail as Record<string, unknown>).upgradeSku).toBe("SVIP_MONTHLY");
    }
    expect(frames[1].type).toBe("done");
  });

  it("a FAILED turn never consumes (P3)", async () => {
    config.quota.limits.chat = { free: 1, vip: 1, svip: 1 };
    const { chat } = makeChat({ harness: errorHarness(), quota: makeQuota("vip") });
    await drain(chat.askStream({ query: "first", sessionId: "s4", uid: "u1" }));
    const frames = await drain(chat.askStream({ query: "second", sessionId: "s5", uid: "u1" }));
    // still allowed: the failed turn consumed nothing
    expect(frames.some((f) => f.type === "error" && f.code === "QUOTA_EXCEEDED")).toBe(false);
  });

  it("free tier over L0 count keeps flowing at L1 until the hard cap (admission unaffected)", async () => {
    config.quota.limits.chat = { free: 2, vip: 100, svip: 300 };
    config.quota.freeLadder.l0Turns = 1;
    const { chat } = makeChat({ quota: makeQuota("free") });
    await drain(chat.askStream({ query: "a", sessionId: "s6", uid: "u1" }));
    const frames = await drain(chat.askStream({ query: "b", sessionId: "s7", uid: "u1" }));
    expect(frames.some((f) => f.type === "error" && f.code === "QUOTA_EXCEEDED")).toBe(false);
    const over = await drain(chat.askStream({ query: "c", sessionId: "s8", uid: "u1" }));
    expect(over[0].type).toBe("error");
    if (over[0].type === "error") expect(over[0].code).toBe("QUOTA_EXCEEDED");
  });

  it("unattributable requests (no uid, no clientKey) are not gated", async () => {
    const { chat } = makeChat({ quota: makeQuota("free") });
    for (let i = 0; i < 3; i++) {
      const frames = await drain(chat.askStream({ query: "x", sessionId: `anon-${i}` }));
      expect(frames[frames.length - 1].type).toBe("done");
      expect(frames.some((f) => f.type === "error")).toBe(false);
    }
  });

  it("image attachments over the daily budget reject before storage", async () => {
    config.quota.limits.chat_images = { free: 1, vip: 100, svip: 300 };
    const { chat } = makeChat({ quota: makeQuota("free") });
    const images = ["data:image/png;base64,aGVsbG8="];
    const first = await drain(chat.askStream({ query: "pic", sessionId: "s9", uid: "u1", images }));
    expect(first.some((f) => f.type === "error")).toBe(false);
    const second = await drain(chat.askStream({ query: "pic2", sessionId: "s10", uid: "u1", images }));
    const err = second[0];
    expect(err.type).toBe("error");
    if (err.type === "error") {
      expect(err.code).toBe("QUOTA_EXCEEDED");
      expect((err.detail as Record<string, unknown>).kind).toBe("chat_images");
    }
  });
});
