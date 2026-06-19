// Shared SSE stream parser for chat responses.
// Centralizes chunk/sources/done/error handling so ChatPanel and ChatDockPanel
// stay in sync without duplicating the decode/parse loop.

export interface ChatSource {
  title: string;
  url?: string;
  bvid?: string;
}

export interface StreamCallbacks {
  onChunk: (accumulated: string, delta: string) => void;
  onSources?: (sources: ChatSource[]) => void;
  onError?: (message: string) => void;
  onComplete?: () => void;
}

export interface StreamRequestParams {
  question: string;
  session_id?: string;
  chat_session_id?: string;
  folder_ids?: string[];
}

export async function streamChat(
  stream: ReadableStream<Uint8Array>,
  callbacks: StreamCallbacks
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let accumulated = "";
  let buffer = "";
  let done = false;

  try {
    while (!done) {
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
  } finally {
    reader.releaseLock();
    callbacks.onComplete?.();
  }
}
