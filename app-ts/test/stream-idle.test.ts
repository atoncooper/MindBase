import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStreamIdleWatchdog } from "../src/services/stream-idle.js";
import type { SseFrame } from "../src/transport/sse.js";

const chunkFrame = (content = "x"): SseFrame => ({ type: "chunk", content });
const reasoningFrame = (content = "think"): SseFrame => ({ type: "reasoning", content });
const stepStart = (step = 1, action = "vector_search"): SseFrame => ({
  type: "step",
  step: { step, action, status: "start" },
});
const stepDone = (step = 1, action = "vector_search"): SseFrame => ({
  type: "step",
  step: { step, action, status: "done" },
});

describe("stream idle watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires exactly once when a silent stream exceeds the idle budget", () => {
    const onIdle = vi.fn();
    const watchdog = createStreamIdleWatchdog({ timeoutMs: 1_000, onIdle });

    vi.advanceTimersByTime(999);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(onIdle).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
    watchdog.dispose();
  });

  it("resets the budget on every frame (text / reasoning / non-step frames)", () => {
    const onIdle = vi.fn();
    const watchdog = createStreamIdleWatchdog({ timeoutMs: 1_000, onIdle });

    vi.advanceTimersByTime(900);
    watchdog.note(chunkFrame());
    vi.advanceTimersByTime(900);
    watchdog.note(reasoningFrame());
    vi.advanceTimersByTime(900);
    expect(onIdle).not.toHaveBeenCalled();

    watchdog.note({ type: "sources", sources: [] });
    vi.advanceTimersByTime(1_001);
    expect(onIdle).toHaveBeenCalledTimes(1);
    watchdog.dispose();
  });

  it("does not fire while a tool is in flight, then fires after it completes", () => {
    const onIdle = vi.fn();
    const watchdog = createStreamIdleWatchdog({ timeoutMs: 1_000, onIdle });

    watchdog.note(stepStart(1, "run_code"));
    // Long tool execution: several idle windows elapse with no frames.
    vi.advanceTimersByTime(5_000);
    expect(onIdle).not.toHaveBeenCalled();

    watchdog.note(stepDone(1, "run_code"));
    vi.advanceTimersByTime(999);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(onIdle).toHaveBeenCalledTimes(1);
    watchdog.dispose();
  });

  it("tracks multiple concurrent tools until every done frame arrives", () => {
    const onIdle = vi.fn();
    const watchdog = createStreamIdleWatchdog({ timeoutMs: 500, onIdle });

    watchdog.note(stepStart(1, "vector_search"));
    watchdog.note(stepStart(2, "web_search"));
    vi.advanceTimersByTime(2_000);
    expect(onIdle).not.toHaveBeenCalled();

    watchdog.note(stepDone(1, "vector_search"));
    vi.advanceTimersByTime(2_000);
    // web_search is still running → still exempt.
    expect(onIdle).not.toHaveBeenCalled();

    watchdog.note(stepDone(2, "web_search"));
    vi.advanceTimersByTime(501);
    expect(onIdle).toHaveBeenCalledTimes(1);
    watchdog.dispose();
  });

  it("dispose() cancels a pending idle fire (idempotent)", () => {
    const onIdle = vi.fn();
    const watchdog = createStreamIdleWatchdog({ timeoutMs: 1_000, onIdle });
    vi.advanceTimersByTime(500);
    watchdog.dispose();
    watchdog.dispose();
    vi.advanceTimersByTime(5_000);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("is disabled when timeoutMs <= 0", () => {
    const onIdle = vi.fn();
    const watchdog = createStreamIdleWatchdog({ timeoutMs: 0, onIdle });
    vi.advanceTimersByTime(60_000);
    expect(onIdle).not.toHaveBeenCalled();
    watchdog.dispose();
  });
});
