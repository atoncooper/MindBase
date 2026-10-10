import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentHarness } from "../../../harness/app.js";
import type { SseFrame } from "../../sse.js";
import { HEARTBEAT, HEARTBEAT_INTERVAL_MS } from "../../sse.js";
import { getRequestContext } from "../../../context/request-context.js";
import { rateLimitHook, type SlidingWindowLimiter } from "../middleware/rate-limit.js";
import { MAX_IMAGES_PER_TURN, MAX_IMAGE_DATA_URL_CHARS, DATA_URL_PATTERN } from "././shared.js";

/**
 * OpenAI-compatible endpoint: `POST /v1/chat/completions` (stream + non-stream).
 *
 * Lets standard OpenAI-protocol clients (Cherry Studio / LobeChat / Dify / any SDK)
 * talk to the same agent stack the frontend uses. Deliberately a SEPARATE surface —
 * the frontend keeps its rich custom frame protocol (sources/step/artifact/interact).
 *
 * Stateful mapping decisions (v1):
 * - **Stateless**: the client's `messages` ARE the context (standard OpenAI shape) —
 *   the server neither persists a session nor reads history. Session-scoped
 *   enhancements (conversation summary, agent context) are skipped; uid-scoped
 *   ones (memory recall, cloud/document RAG) still apply via the X-Uid header.
 * - Client `system` messages are joined and appended below the agent's own
 *   system prompt (`extraSystem`) — the agent's red lines always win.
 * - Frame mapping: chunk → `delta.content`; reasoning → `delta.reasoning_content`
 *   (DeepSeek-style); ask_user interactions → plain-text question; error → content
 *   delta with the reason; route/step/queue/sources/artifact frames are dropped
 *   (no OpenAI slot — this endpoint is lossy by design).
 * - `usage` is emitted when the agent reports it (final chunk / response field).
 * - Auth: X-Uid via the gateway, as everywhere else; no Bearer-key mapping yet.
 */

const contentPartSchema = z
  .object({ type: z.string(), text: z.string().optional() })
  .passthrough();

const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(contentPartSchema), z.null()]).optional(),
});

const chatRequestSchema = z.object({
  model: z.string().optional(),
  messages: z.array(messageSchema).min(1),
  stream: z.boolean().optional(),
});

type OpenAiMessage = z.infer<typeof messageSchema>;

interface OpenAiChunkOptions {
  id: string;
  created: number;
  model: string;
  delta: Record<string, unknown>;
  finishReason: string | null;
  usage?: Record<string, unknown>;
}

function chunkBody(opts: OpenAiChunkOptions): string {
  return JSON.stringify({
    id: opts.id,
    object: "chat.completion.chunk",
    created: opts.created,
    model: opts.model,
    choices: [{ index: 0, delta: opts.delta, finish_reason: opts.finishReason }],
    ...(opts.usage ? { usage: opts.usage } : {}),
  });
}

/** Split OpenAI message content into text + data-URL images. Non-data image URLs throw (no outbound image fetches). */
function splitContent(content: OpenAiMessage["content"]): { text: string; images: string[] } {
  if (typeof content === "string") return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: "", images: [] };
  const textParts: string[] = [];
  const images: string[] = [];
  for (const part of content) {
    if (part.type === "text" && typeof part.text === "string") {
      textParts.push(part.text);
    } else if (part.type === "image_url") {
      const url = (part as { image_url?: { url?: string } }).image_url?.url ?? "";
      if (!url) continue;
      if (!DATA_URL_PATTERN.test(url)) {
        throw new Error("仅支持 data:image/...;base64 形式的图片（不接受外链图片 URL）");
      }
      if (url.length > MAX_IMAGE_DATA_URL_CHARS) {
        throw new Error(`单张图片过大（data URL 上限 ${Math.floor(MAX_IMAGE_DATA_URL_CHARS / 1024)}KB）`);
      }
      images.push(url);
    }
  }
  return { text: textParts.join("\n"), images };
}

/** ask_user interaction → plain text the client can render (OpenAI has no interaction slot). */
function interactToText(frame: Extract<SseFrame, { type: "interact" }>): string {
  const { interact } = frame;
  const lines = [interact.question ?? "请确认："];
  for (const option of interact.options ?? []) {
    lines.push(`- ${option.label ?? option.value}`);
  }
  return lines.join("\n");
}

export function registerOpenAiCompat(
  app: FastifyInstance,
  opts: { harness: AgentHarness; model: string; limiter: SlidingWindowLimiter },
) {
  app.post(
    "/v1/chat/completions",
    { preHandler: rateLimitHook(opts.limiter) },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = chatRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({
          error: { message: "messages 不能为空且格式须为 OpenAI Chat Completions", type: "invalid_request_error" },
        });
      }
      const body = parsed.data;
      const chatMessages = body.messages.filter((m) => m.role !== "tool");
      const extraSystem = chatMessages
        .filter((m) => m.role === "system")
        .map((m) => splitContent(m.content).text)
        .filter(Boolean)
        .join("\n\n");
      const conversation = chatMessages.filter((m) => m.role !== "system");
      const last = conversation.at(-1);
      if (!last || last.role !== "user") {
        return reply.status(400).send({
          error: { message: "最后一条消息必须是 user 角色", type: "invalid_request_error" },
        });
      }
      let query = "";
      let turnImages: string[] | undefined;
      let history: Array<{ role: "user" | "assistant"; content: string; images?: string[] }>;
      try {
        history = conversation.slice(0, -1).map((m) => {
          const { text, images } = splitContent(m.content);
          if (images.length > MAX_IMAGES_PER_TURN) {
            throw new Error(`单条消息图片数量超限（最多 ${MAX_IMAGES_PER_TURN} 张）`);
          }
          return {
            role: m.role as "user" | "assistant",
            content: text,
            ...(images.length ? { images } : {}),
          };
        });
        const lastSplit = splitContent(last.content);
        query = lastSplit.text.trim();
        turnImages = lastSplit.images.length > 0 ? lastSplit.images : undefined;
        if (turnImages && turnImages.length > MAX_IMAGES_PER_TURN) {
          throw new Error(`单条消息图片数量超限（最多 ${MAX_IMAGES_PER_TURN} 张）`);
        }
      } catch (err) {
        return reply.status(400).send({
          error: { message: err instanceof Error ? err.message : String(err), type: "invalid_request_error" },
        });
      }
      if (!query && !(turnImages && turnImages.length > 0)) {
        return reply.status(400).send({
          error: { message: "最后一条 user 消息不能为空", type: "invalid_request_error" },
        });
      }

      const completionId = `chatcmpl-${randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);
      const model = body.model ?? opts.model;
      const uid = getRequestContext()?.uid;
      // stateless: fresh session id each request (per-session lock only); explicit
      // chatSessionId=undefined skips agent-context persistence entirely
      const input = {
        sessionId: randomUUID(),
        chatSessionId: undefined,
        query: query || "（请看图回答）",
        uid,
        scope: {},
        history,
        ...(turnImages?.length ? { images: turnImages } : {}),
        ...(extraSystem ? { extraSystem } : {}),
      };

      if (body.stream) {
        reply.hijack();
        reply.raw.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        const heartbeat = setInterval(() => reply.raw.write(HEARTBEAT), HEARTBEAT_INTERVAL_MS);
        let closed = false;
        reply.raw.on("close", () => {
          closed = true;
        });

        const send = (delta: Record<string, unknown>, finishReason: string | null = null, usage?: Record<string, unknown>) => {
          if (!closed) {
            reply.raw.write(`data: ${chunkBody({ id: completionId, created, model, delta, finishReason, usage })}\n\n`);
          }
        };

        try {
          send({ role: "assistant", content: "" });
          let usage: Record<string, unknown> | undefined;
          for await (const frame of opts.harness.dispatchStream(input)) {
            if (closed) break;
            switch (frame.type) {
              case "chunk":
                send({ content: frame.content });
                break;
              case "reasoning":
                send({ reasoning_content: frame.content });
                break;
              case "interact":
                send({ content: `${interactToText(frame)}\n` });
                break;
              case "error":
                send({ content: `\n[处理失败] ${frame.message}\n` });
                break;
              case "usage":
                usage = {
                  prompt_tokens: frame.usage.inputTokens ?? 0,
                  completion_tokens: frame.usage.outputTokens ?? 0,
                  total_tokens: frame.usage.totalTokens ?? 0,
                };
                break; // internal frame, never forwarded verbatim
              default:
                break; // route/step/queue/sources/artifact/reset: no OpenAI slot
            }
          }
          send({}, "stop", usage);
          if (!closed) reply.raw.write("data: [DONE]\n\n");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          send({ content: `\n[处理失败] ${message}\n` });
          send({}, "stop");
          if (!closed) reply.raw.write("data: [DONE]\n\n");
        } finally {
          clearInterval(heartbeat);
          if (!reply.raw.writableEnded) reply.raw.end();
        }
        return;
      }

      // ---- non-stream: aggregate the same frame stream into one message ----
      let content = "";
      let usage: Record<string, unknown> | undefined;
      let failed = false;
      for await (const frame of opts.harness.dispatchStream(input)) {
        switch (frame.type) {
          case "chunk":
            content += frame.content;
            break;
          case "interact":
            content += `${interactToText(frame)}\n`;
            break;
          case "error":
            failed = true;
            content += `\n[处理失败] ${frame.message}`;
            break;
          case "usage":
            usage = {
              prompt_tokens: frame.usage.inputTokens ?? 0,
              completion_tokens: frame.usage.outputTokens ?? 0,
              total_tokens: frame.usage.totalTokens ?? 0,
            };
            break;
          default:
            break;
        }
      }
      return {
        id: completionId,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          },
        ],
        ...(usage ? { usage } : {}),
        ...(failed ? { mindbase_error: true } : {}),
      };
    },
  );
}
