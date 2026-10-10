import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ChatService } from "../src/services/chat.js";
import { WeightedAdmissionQueue } from "../src/services/admission.js";
import { MemoryChatSessionRepository, MemoryMessageRepository } from "../src/repository/memory/chat-store.js";
import type { AgentHarness } from "../src/harness/app.js";
import type { SseFrame } from "../src/transport/sse.js";
import { config } from "../src/config/index.js";

/**
 * Turn-level weighted admission, exercised end-to-end through ChatService:
 * immediate grant under the cap, queue progress frames at the cap, friendly
 * error + failed turn on timeout / queue-full, and slot hygiene on
 * disconnect (generator return).
 */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`test guard timeout: ${label}`)), ms)),
  ]);
}

async function drain(gen: AsyncGenerator<SseFrame>, guardMs = 5000): Promise<SseFrame[]> {
  const frames: SseFrame[] = [];
  const deadline = Date.now() + guardMs;
  // iterate to natural completion (NOT breaking on the done frame): the
  // generator keeps post-processing (persist/finally) after the last yield,
  // and skipping that would hide slot-release bugs from the assertions below
  while (Date.now() < deadline) {
    const r = await gen.next();
    if (r.done) break;
    frames.push(r.value);
  }
  return frames;
}

function makeQueue(over = {}): WeightedAdmissionQueue {
  return new WeightedAdmissionQueue({
    maxConcurrent: 1,
    queueMaxSize: 10,
    tierWeights: { free: 0, vip: 100, svip: 200 },
    agingWindowMs: 30_000,
    agingStep: 10,
    ...over,
  });
}

/** Streams route immediately, then parks at a gate before the content (holds the slot). */
function makeGateHarness() {
  const gate = { open: false, waiters: [] as Array<() => void> };
  const harness = {
    dispatchStream: async function* (): AsyncGenerator<SseFrame> {
      yield { type: "route", agent: "main" };
      if (!gate.open) await new Promise<void>((resolve) => gate.waiters.push(resolve));
      yield { type: "chunk", content: "ok" };
      yield { type: "done" };
    },
  } as unknown as AgentHarness;
  return { harness, open: () => { gate.open = true; for (const w of gate.waiters.splice(0)) w(); } };
}

/** Streams straight through with no gating. */
function passthroughHarness(): AgentHarness {
  return {
    dispatchStream: async function* (): AsyncGenerator<SseFrame> {
      yield { type: "route", agent: "main" };
      yield { type: "chunk", content: "ok" };
      yield { type: "done" };
    },
  } as unknown as AgentHarness;
}

function makeChat(harness: AgentHarness, admission: WeightedAdmissionQueue | null) {
  return new ChatService(harness, new MemoryChatSessionRepository(), new MemoryMessageRepository(), undefined, undefined, admission);
}

/** MemoryMessageRepository.recentMessages only returns done messages — a failed
 *  turn's assistant message is invisible there, so observe finalizeTurn instead. */
function spyFinalize(messages: MemoryMessageRepository) {
  const calls: Array<{ id: string; status: "done" | "failed" }> = [];
  const orig = messages.finalizeTurn.bind(messages);
  (messages as unknown as { finalizeTurn: unknown }).finalizeTurn = async (
    id: string,
    patch: { status: "done" | "failed" },
  ) => {
    calls.push({ id, status: patch.status });
    await orig(id, patch);
  };
  return calls;
}

describe("ChatService weighted admission", () => {
  const saved = { ...config.scheduling };
  beforeEach(() => {
    Object.assign(config.scheduling, {
      enabled: true,
      queueMaxSize: 10,
      queueTimeoutMs: 5000,
      queueFrameIntervalMs: 10,
    });
  });
  afterEach(() => {
    Object.assign(config.scheduling, saved);
  });

  it("streams directly when admission is disabled (null)", async () => {
    const chat = makeChat(passthroughHarness(), null);
    const frames = await drain(chat.askStream({ query: "hi", sessionId: "s1" }));
    expect(frames.map((f) => f.type)).toEqual(["route", "chunk", "done"]);
    expect(frames.some((f) => f.type === "queue")).toBe(false);
  });

  it("grants immediately under the cap and releases the slot when done", async () => {
    const queue = makeQueue();
    const chat = makeChat(passthroughHarness(), queue);
    const frames = await drain(chat.askStream({ query: "hi", sessionId: "s2" }));
    expect(frames.some((f) => f.type === "queue")).toBe(false);
    expect(frames[frames.length - 1].type).toBe("done");
    expect(queue.running).toBe(0);
    expect(queue.waiting).toBe(0);
  });

  it("queues at the cap: emits queue frames, then streams after the slot frees", async () => {
    const { harness, open } = makeGateHarness();
    const queue = makeQueue();
    const chat = makeChat(harness, queue);

    const genA = chat.askStream({ query: "first", sessionId: "s3" });
    const a1 = await withTimeout(genA.next(), 2000, "A route");
    expect(a1.value?.type).toBe("route"); // A holds the slot, parked at the gate

    const genB = chat.askStream({ query: "second", sessionId: "s4" });
    const b1 = await withTimeout(genB.next(), 2000, "B queue frame");
    expect(b1.value?.type).toBe("queue");
    if (b1.value?.type === "queue") {
      expect(b1.value.position).toBe(1);
      expect(b1.value.waitedMs).toBeGreaterThanOrEqual(0);
    }
    expect(queue.waiting).toBe(1);

    open();
    const restA = await drain(genA);
    expect(restA[restA.length - 1].type).toBe("done");

    const restB = await drain(genB);
    expect(restB.map((f) => f.type)).toEqual(["route", "chunk", "done"]);
    expect(queue.running).toBe(0);
    expect(queue.waiting).toBe(0);
  });

  it("times out while queued: friendly error frame, done, turn marked failed", async () => {
    config.scheduling.queueTimeoutMs = 80;
    const { harness, open } = makeGateHarness();
    const queue = makeQueue();
    const messages = new MemoryMessageRepository();
    const finalizeCalls = spyFinalize(messages);
    const chat = new ChatService(harness, new MemoryChatSessionRepository(), messages, undefined, undefined, queue);

    const genA = chat.askStream({ query: "first", sessionId: "s5" });
    await withTimeout(genA.next(), 2000, "A route");

    const genB = chat.askStream({ query: "second", sessionId: "s6" });
    const frames = await withTimeout(drain(genB, 3000), 5000, "B timeout flow");
    const types = frames.map((f) => f.type);
    expect(types).toContain("queue");
    const err = frames.find((f) => f.type === "error");
    expect(err).toBeDefined();
    if (err?.type === "error") expect(err.message).toContain("排队超时");
    expect(frames[frames.length - 1].type).toBe("done");
    expect(finalizeCalls.at(-1)?.status).toBe("failed");

    open();
    await drain(genA);
    expect(queue.running).toBe(0);
    expect(queue.waiting).toBe(0);
  });

  it("fails fast when the queue is full: friendly error frame, done, turn marked failed", async () => {
    const { harness, open } = makeGateHarness();
    const queue = makeQueue({ queueMaxSize: 0 });
    const messages = new MemoryMessageRepository();
    const finalizeCalls = spyFinalize(messages);
    const chat = new ChatService(harness, new MemoryChatSessionRepository(), messages, undefined, undefined, queue);

    const genA = chat.askStream({ query: "first", sessionId: "s7" });
    await withTimeout(genA.next(), 2000, "A route");

    const genB = chat.askStream({ query: "second", sessionId: "s8" });
    const frames = await withTimeout(drain(genB, 2000), 4000, "B queue full flow");
    const err = frames.find((f) => f.type === "error");
    expect(err).toBeDefined();
    if (err?.type === "error") expect(err.message).toContain("请稍后重试");
    expect(frames[frames.length - 1].type).toBe("done");
    expect(frames.some((f) => f.type === "queue")).toBe(false);
    expect(finalizeCalls.at(-1)?.status).toBe("failed");

    open();
    await drain(genA);
    expect(queue.running).toBe(0);
  });

  it("disconnect while queued cancels the ticket and leaks no slot", async () => {
    const { harness, open } = makeGateHarness();
    const queue = makeQueue();
    const chat = makeChat(harness, queue);

    const genA = chat.askStream({ query: "first", sessionId: "s9" });
    await withTimeout(genA.next(), 2000, "A route");

    const genB = chat.askStream({ query: "second", sessionId: "s10" });
    await withTimeout(genB.next(), 2000, "B queue frame"); // queued
    expect(queue.waiting).toBe(1);

    // client disconnects → server breaks the for-await → generator return
    await genB.return(undefined);
    await sleep(5);
    expect(queue.waiting).toBe(0);

    open();
    await drain(genA);
    expect(queue.running).toBe(0);
    expect(queue.waiting).toBe(0);
  });
});
