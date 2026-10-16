import type { Artifact, InteractionPayload, Source } from "../context/types.js";

/**
 * SSE frame protocol: semantics aligned with Python agent_sse.py.
 * route/chunk/reasoning/step/sources/artifact/interact/error/done + reset.
 *
 * reset: sent when a retryable failure aborts a turn attempt mid-stream — the frontend
 * must clear accumulated text/reasoning; the retried attempt streams fresh content.
 *
 * queue frame: emitted while the turn waits in the admission queue (load at the
 * concurrency cap; see services/admission.ts). `position` is 1-based, delivered
 * periodically (scheduling.queueFrameIntervalMs) until a slot is granted — then the
 * normal stream starts. If the wait exceeds scheduling.queueTimeoutMs an error frame
 * is sent instead and the turn ends. Old frontends that ignore unknown frame types
 * degrade to a silent wait (protocol is additive).
 *
 * delegate frame: brackets a sub-agent execution triggered by delegate_to_agent —
 * `status: "start"` when the sub-agent begins, `"done"` when it finishes. `active`
 * is how many sub-agents are currently running within the turn (starts minus
 * dones) and `index` is the 1-based ordinal of this delegation, so the frontend
 * can show live sub-task status ("子任务执行中：note（1 个）") without polling.
 * The sub-agent's own frames are NOT forwarded — only this bracket.
 *
 * interact frame: a structured interaction produced by the ask_user tool; the frontend
 * renders it as a confirm card / option chips / form. The user's normalized answer
 * (button click → canonical text) is sent as the next ordinary message — the execution
 * model stays round-based (no suspended state, no resume protocol).
 *
 * usage frame: INTERNAL ONLY — consumed by the chat service for persistence, never
 * forwarded to the HTTP layer.
 *
 * error frame: may carry `code` ("QUOTA_EXCEEDED" | "COST_GUARD") + `detail`
 * {kind, used, limit, resetAt, tier, upgradeSku} — the frontend renders an
 * upgrade card off the code; older clients ignore them.
 */
export type SseFrame =
  | { type: "route"; agent: string }
  | { type: "chunk"; content: string }
  | { type: "reasoning"; content: string }
  | {
      type: "step";
      step: {
        step: number;
        action: string;
        status: "start" | "done";
        query?: string;
        /** compact JSON args preview (truncated; LLM-emitted, safe to display) */
        args?: string;
        /** tool execution duration on the done frame */
        durationMs?: number;
      };
    }
  | { type: "sources"; sources: Source[] }
  | { type: "artifact"; artifacts: Artifact[] }
  | { type: "interact"; interact: InteractionPayload }
  | { type: "delegate"; agent: string; status: "start" | "done"; active: number; index: number }
  | { type: "queue"; position: number; waitedMs: number }
  | { type: "reset" }
  | { type: "usage"; usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } }
  | { type: "error"; message: string; code?: string; detail?: Record<string, unknown> }
  | { type: "done" };

export const HEARTBEAT = ": ping\n\n";

/** SSE keepalive cadence — all hijacked SSE routes share it (protocol-level constant) */
export const HEARTBEAT_INTERVAL_MS = 15_000;

export function encodeFrame(frame: SseFrame): string {
  return `data: ${JSON.stringify(frame)}\n\n`;
}
