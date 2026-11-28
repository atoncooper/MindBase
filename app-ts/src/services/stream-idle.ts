import type { SseFrame } from "../transport/sse.js";

/**
 * Streaming idle watchdog.
 *
 * A stalled upstream (gateway hang, model that never emits the first token,
 * dropped proxy response) leaves the SSE turn silent while the frontend keeps
 * showing「思考中」forever. This watchdog fires `onIdle` when the turn has been
 * silent for `timeoutMs` — but only while **no tool is executing**:
 *
 *  - every frame (chunk / reasoning / step / queue / ...) resets the timer;
 *  - a `step` frame with status "start" marks a tool in flight and suppresses
 *    idle aborts (long-running tools are bounded by the whole-turn timeout);
 *  - its matching "done" frame re-enables the watchdog;
 *  - `timeoutMs <= 0` disables it entirely.
 *
 * Callers abort the turn in `onIdle` (the same AbortController used for the
 * whole-turn deadline) and must call `dispose()` when the stream ends.
 */

export interface StreamIdleWatchdog {
  /** Observe one SSE frame (resets the idle timer, tracks tool lifecycle). */
  note(frame: SseFrame): void;
  /** Stop the timer (idempotent; always call when the turn ends). */
  dispose(): void;
}

export interface StreamIdleWatchdogOptions {
  /** Idle budget in milliseconds; <= 0 disables the watchdog. */
  timeoutMs: number;
  /** Called once when the turn has been silent with no tool in flight. */
  onIdle: () => void;
}

/** Stable key for a step frame (step number + action; done pairs with start). */
function stepKey(frame: Extract<SseFrame, { type: "step" }>): string {
  return `${frame.step.step}:${frame.step.action}`;
}

export function createStreamIdleWatchdog({
  timeoutMs,
  onIdle,
}: StreamIdleWatchdogOptions): StreamIdleWatchdog {
  if (!(timeoutMs > 0)) {
    return { note: () => undefined, dispose: () => undefined };
  }

  const activeTools = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  // When a tool is still running at the deadline, re-arm for another window
  // instead of firing: tool execution time is explicitly excluded.
  const arm = () => {
    clear();
    if (disposed) return;
    timer = setTimeout(() => {
      timer = null;
      if (disposed) return;
      if (activeTools.size > 0) {
        arm();
        return;
      }
      disposed = true;
      onIdle();
    }, timeoutMs);
    // Never keep the process alive just for the watchdog.
    const maybeUnref = (timer as { unref?: () => void }).unref;
    if (typeof maybeUnref === "function") maybeUnref.call(timer);
  };

  arm();

  return {
    note(frame: SseFrame) {
      if (disposed) return;
      if (frame.type === "step") {
        const key = stepKey(frame);
        if (frame.step.status === "start") activeTools.add(key);
        else activeTools.delete(key);
      }
      arm();
    },
    dispose() {
      disposed = true;
      clear();
    },
  };
}
