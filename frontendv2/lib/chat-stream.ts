// Shared SSE stream parser for chat responses.
// Centralizes chunk/sources/step/route/reset/artifact/error/done handling so the
// chat view stays free of the decode/parse loop. Mirrors the backend SSE frame
// shapes emitted by app/services/chat/agent_sse.py.

export interface ChatSource {
  title: string;
  url?: string;
  bvid?: string;
}

// File-style artifact (image / downloadable file) produced by a sub-agent or a
// tool (e.g. run_code). This is the legacy/history shape: identity is `name`.
export interface ChatFileArtifact {
  kind?: undefined;
  name: string;
  url?: string;
  minio_key?: string;
  content_type?: string;
  size?: number;
}

// Structured artifact: the app-ts agent emits `{kind, data}` (quiz /
// quiz_grading today — see tools/quiz/index.ts → ResultCollector.pushArtifacts
// → agent/react.ts tail frame). `data` is the domain payload the UI summarizes;
// it is never rendered as free-form HTML.
export interface ChatTypedArtifact {
  kind: string;
  data: unknown;
  /** file-ish fields tolerated on a structured artifact (union ergonomics) */
  name?: string;
  url?: string;
  content_type?: string;
  size?: number;
}

// One artifact carried by an `artifact` SSE frame. The backend sends
// `{ type: "artifact", artifacts: [...] }` (array); older payloads sent a single
// `{ type: "artifact", artifact: {...} }`. Both are normalized here.
export type ChatArtifact = ChatFileArtifact | ChatTypedArtifact;

/** True for the structured `{kind, data}` shape (quiz / quiz_grading / future kinds). */
export function isTypedArtifact(artifact: ChatArtifact): artifact is ChatTypedArtifact {
  return typeof (artifact as ChatTypedArtifact).kind === "string";
}

/** Stable identity per artifact, used to de-duplicate within one turn. */
export function artifactKey(artifact: ChatArtifact): string {
  if (!isTypedArtifact(artifact)) return artifact.url || artifact.name || "";
  let payload = "";
  try {
    payload = JSON.stringify(artifact.data) ?? "";
  } catch {
    payload = "";
  }
  return `${artifact.kind}:${payload.slice(0, 512)}`;
}

// Normalize an `artifact` frame payload: array form (current backend) or the
// legacy single-artifact form. Unknown/non-object entries are dropped.
function artifactsFromFrame(data: Record<string, unknown>): ChatArtifact[] {
  const raw = Array.isArray(data.artifacts)
    ? data.artifacts
    : data.artifact && typeof data.artifact === "object"
      ? [data.artifact]
      : [];
  return raw.filter(
    (a): a is ChatArtifact => !!a && typeof a === "object" && !Array.isArray(a)
  );
}

// One retrieval/tool step emitted by the agent stream.
// Mirrors the backend `step` SSE frame payload (agent_sse.py).
export interface StreamStep {
  step: number;
  action: string;
  query?: string;
  reasoning?: string;
  sources?: ChatSource[];
  content_preview?: string;
  /** compact JSON args preview (truncated; done frames omit it) */
  args?: string;
  /** tool execution duration in ms (done frames only) */
  durationMs?: number;
}

// Turn is waiting in the backend admission queue (load at the concurrency cap).
// Mirrors the backend `queue` SSE frame payload (app-ts services/admission.ts).
export interface QueueStatus {
  position: number;
  waitedMs: number;
}

// Sub-agent delegation bracket (app-ts `delegate` SSE frame): status start/done,
// `active` = how many sub-agents are currently running, `index` = 1-based ordinal.
export interface DelegateStatus {
  agent: string;
  status: "start" | "done";
  active: number;
  index: number;
}

// Structured AI→user interaction (app-ts `interact` SSE frame, ask_user tool):
// clarify option chips / confirm card / multi-field form. Mirrors the backend
// InteractionPayload (app-ts src/context/types.ts). The user's normalized
// answer is sent back as the next ordinary user message — the backend is
// round-based (the ReAct loop stops on ask_user; no resume protocol).
export interface ChatInteractionOption {
  label: string;
  value: string;
}

export interface ChatInteractionField {
  name: string;
  label: string;
  type?: "text" | "email" | "datetime" | "select";
  required?: boolean;
  options?: ChatInteractionOption[];
}

export interface ChatInteraction {
  kind: "clarify" | "confirm" | "form";
  question: string;
  options?: ChatInteractionOption[];
  fields?: ChatInteractionField[];
  context?: string;
}

// Agent task plan: one step of the plan tool snapshot. Known statuses are
// pending | in_progress | done | failed | skipped; unknown values render as "·"
// so an older/newer backend never breaks the panel.
export interface ChatPlanStep {
  desc: string;
  status: string;
  note: string;
}

// Read-only task plan carried by the `plan` SSE frame (plan tool). The version
// bumps on every mutation, so the same version is never appended twice. The plan
// is display-only: the chat view keeps it in memory on the streaming assistant
// message and a history reload loses it (same nature as the reasoning stream).
export interface ChatPlan {
  version: number;
  steps: ChatPlanStep[];
  /** done + skipped steps */
  done: number;
  total: number;
}

// Normalize a `plan` frame payload; drops malformed steps so the panel never
// renders a half-parsed plan. Returns null when the frame carries no usable plan.
function planFromFrame(data: Record<string, unknown>): ChatPlan | null {
  const raw = data.plan;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const payload = raw as Record<string, unknown>;
  const steps: ChatPlanStep[] = (Array.isArray(payload.steps) ? payload.steps : [])
    .filter(
      (step): step is Record<string, unknown> =>
        !!step && typeof step === "object" && !Array.isArray(step)
    )
    .map((step) => ({
      desc: typeof step.desc === "string" ? step.desc : "",
      status: typeof step.status === "string" ? step.status : "pending",
      note: typeof step.note === "string" ? step.note : "",
    }))
    .filter((step) => step.desc.trim().length > 0);
  if (steps.length === 0) return null;
  const rawTotal = typeof payload.total === "number" ? payload.total : steps.length;
  const total = rawTotal > 0 ? rawTotal : steps.length;
  const rawDone =
    typeof payload.done === "number"
      ? payload.done
      : steps.filter((step) => step.status === "done" || step.status === "skipped").length;
  return {
    version: typeof payload.version === "number" ? payload.version : 0,
    steps,
    done: Math.min(Math.max(rawDone, 0), total),
    total,
  };
}

export interface StreamCallbacks {
  onChunk: (accumulated: string, delta: string) => void;
  onSources?: (sources: ChatSource[]) => void;
  // `meta` carries the structured error code ("QUOTA_EXCEEDED" | "COST_GUARD")
  // + detail {kind, used, limit, resetAt, tier, upgradeSku} — the chat view
  // renders an upgrade banner off it. Undefined for plain
  // server errors.
  onError?: (message: string, meta?: { code?: string; detail?: Record<string, unknown> }) => void;
  onComplete?: () => void;
  onStep?: (step: StreamStep) => void;
  onRoute?: (agent: string) => void;
  onReset?: () => void;
  onArtifact?: (artifact: ChatArtifact) => void;
  // Turn queued at the backend (load control); delivered periodically until a
  // slot is granted. The route/chunk frames that follow clear the state.
  onQueueStatus?: (status: QueueStatus) => void;
  // Sub-agent delegation bracket (delegate_to_agent start/done). `active` counts
  // currently-running sub-agents; the done frame with active=0 clears the state.
  onDelegate?: (status: DelegateStatus) => void;
  // Reasoning deltas from thinking models (backend `reasoning` SSE frame).
  // Accumulated here like text. NOT cleared on `reset` frames — the backend
  // does not replay reasoning after reset, so clearing would lose the
  // thinking during ReAct loops.
  onReasoning?: (accumulated: string, delta: string) => void;
  // Structured AI→user interaction (`interact` SSE frame): renders the
  // confirm card / option chips / form. One per turn (ask_user stops the loop).
  onInteract?: (interaction: ChatInteraction) => void;
  // Task plan snapshot (`plan` SSE frame): the plan tool advances it at each
  // mutating step boundary, so the panel updates live while the turn streams.
  onPlan?: (plan: ChatPlan) => void;
}

/**
 * Consume a ReadableStream of SSE `data: {...}` frames and dispatch typed
 * callbacks. Frames are split on blank lines; a trailing partial frame is held
 * in a buffer until the next chunk so JSON is never cut mid-parse.
 *
 * Pass an AbortSignal to support "stop generation": when aborted, the loop
 * breaks cleanly, the reader is cancelled, and onComplete fires - no error is
 * surfaced to the caller (the abort is a user action, not a failure).
 */
export async function streamChat(
  stream: ReadableStream<Uint8Array>,
  callbacks: StreamCallbacks,
  signal?: AbortSignal
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let accumulated = "";
  let reasoningAccumulated = "";
  let buffer = "";
  let done = false;
  // Set when the server's terminal frames arrived (`done` / `[DONE]`). If
  // the loop exits without them the stream was cut mid-answer (proxy idle
  // timeout, network drop, server crash) — that must surface as an error,
  // otherwise a dead connection looks exactly like a finished-but-empty
  // reply.
  let completed = false;
  let errored = false;

  try {
    while (!done) {
      if (signal?.aborted) break;
      const { value, done: isDone } = await reader.read();
      done = isDone;
      if (!value) continue;

      buffer += decoder.decode(value, { stream: !done });
      const frames = buffer.split("\n\n");
      // Keep the trailing partial frame in the buffer for the next iteration.
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        const line = frame.trim();
        if (!line.startsWith("data: ")) continue;
        const dataStr = line.slice(6);
        if (dataStr === "[DONE]") {
          completed = true;
          done = true;
          break;
        }

        try {
          const data = JSON.parse(dataStr);
          if (data.type === "chunk") {
            const delta = typeof data.content === "string" ? data.content : "";
            accumulated += delta;
            callbacks.onChunk(accumulated, delta);
          } else if (data.type === "reasoning") {
            const delta = typeof data.content === "string" ? data.content : "";
            reasoningAccumulated += delta;
            callbacks.onReasoning?.(reasoningAccumulated, delta);
          } else if (data.type === "sources") {
            callbacks.onSources?.(Array.isArray(data.sources) ? data.sources : []);
          } else if (data.type === "step") {
            callbacks.onStep?.(data.step as StreamStep);
          } else if (data.type === "route") {
            callbacks.onRoute?.(data.agent as string);
          } else if (data.type === "reset") {
            // A retried LLM run begins: clear text (backend replays pre-run
            // content as chunks) but preserve reasoning — the backend does
            // NOT replay reasoning after reset, so clearing it would make
            // the thinking "disappear" during ReAct loops.
            accumulated = "";
            callbacks.onReset?.();
          } else if (data.type === "artifact") {
            // Backend frame: { type: "artifact", artifacts: [...] } (one frame per
            // turn, emitted at the stream tail). Legacy: a single data.artifact.
            for (const artifact of artifactsFromFrame(data)) {
              callbacks.onArtifact?.(artifact);
            }
          } else if (data.type === "queue") {
            callbacks.onQueueStatus?.({
              position: typeof data.position === "number" ? data.position : 0,
              waitedMs: typeof data.waitedMs === "number" ? data.waitedMs : 0,
            });
          } else if (data.type === "delegate") {
            callbacks.onDelegate?.({
              agent: typeof data.agent === "string" ? data.agent : "",
              status: data.status === "done" ? "done" : "start",
              active: typeof data.active === "number" ? data.active : 0,
              index: typeof data.index === "number" ? data.index : 0,
            });
          } else if (data.type === "interact") {
            if (data.interact && typeof data.interact === "object") {
              callbacks.onInteract?.(data.interact as ChatInteraction);
            }
          } else if (data.type === "plan") {
            const plan = planFromFrame(data);
            if (plan) callbacks.onPlan?.(plan);
          } else if (data.type === "error") {
            errored = true;
            callbacks.onError?.(data.message || data.error || "请求失败", {
              code: typeof data.code === "string" ? data.code : undefined,
              detail: (data.detail && typeof data.detail === "object" ? data.detail : undefined) as Record<string, unknown> | undefined,
            });
          } else if (data.type === "done") {
            completed = true;
            done = true;
          }
        } catch {
          // Ignore malformed JSON frames; SSE may split across chunks.
        }
      }
    }

    if (!completed && !errored && !signal?.aborted) {
      callbacks.onError?.("回复流中断（连接提前断开），请重试");
    }
  } catch (e) {
    // Aborting the fetch rejects the pending reader.read() with an AbortError.
    // That's an expected stop, not a failure - swallow it. Anything else
    // propagates so the caller can surface a real error.
    if (!signal?.aborted) throw e;
  } finally {
    if (signal?.aborted) {
      try {
        await reader.cancel();
      } catch {
        /* already released or aborted */
      }
    }
    reader.releaseLock();
    callbacks.onComplete?.();
  }
}
