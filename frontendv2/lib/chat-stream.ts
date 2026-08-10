// Shared SSE stream parser for chat responses.
// Centralizes chunk/sources/step/route/reset/artifact/error/done handling so the
// chat view stays free of the decode/parse loop. Mirrors the backend SSE frame
// shapes emitted by app/services/chat/agent_sse.py.

export interface ChatSource {
  title: string;
  url?: string;
  bvid?: string;
}

// One binary artifact (e.g. image) produced by a sub-agent such as the code
// agent. Mirrors the backend `artifact` SSE frame payload.
export interface ChatArtifact {
  name: string;
  url?: string;
  minio_key?: string;
  content_type?: string;
  size?: number;
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
}

export interface StreamCallbacks {
  onChunk: (accumulated: string, delta: string) => void;
  onSources?: (sources: ChatSource[]) => void;
  onError?: (message: string) => void;
  onComplete?: () => void;
  onStep?: (step: StreamStep) => void;
  onRoute?: (agent: string) => void;
  onReset?: () => void;
  onArtifact?: (artifact: ChatArtifact) => void;
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
  let buffer = "";
  let done = false;

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
          done = true;
          break;
        }

        try {
          const data = JSON.parse(dataStr);
          if (data.type === "chunk") {
            const delta = typeof data.content === "string" ? data.content : "";
            accumulated += delta;
            callbacks.onChunk(accumulated, delta);
          } else if (data.type === "sources") {
            callbacks.onSources?.(Array.isArray(data.sources) ? data.sources : []);
          } else if (data.type === "step") {
            callbacks.onStep?.(data.step as StreamStep);
          } else if (data.type === "route") {
            callbacks.onRoute?.(data.agent as string);
          } else if (data.type === "reset") {
            accumulated = "";
            callbacks.onReset?.();
          } else if (data.type === "artifact") {
            callbacks.onArtifact?.(data.artifact as ChatArtifact);
          } else if (data.type === "error") {
            callbacks.onError?.(data.message || data.error || "请求失败");
          } else if (data.type === "done") {
            done = true;
          }
        } catch {
          // Ignore malformed JSON frames; SSE may split across chunks.
        }
      }
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
