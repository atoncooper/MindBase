import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ChatService } from "../../../services/chat.js";
import type { RAGService } from "../../../rag/service.js";
import type { SessionDocumentRepository } from "../../../repository/session-docs.js";
import type { SearchScope } from "../../../context/types.js";
import type { OcrClient } from "../../../doc-parser/ocr.js";
import { parseDocument, UnsupportedDocumentError } from "../../../doc-parser/index.js";
import { OcrError } from "../../../doc-parser/ocr.js";
import { SemanticChunker } from "../../../rag/chunking.js";
import { HEARTBEAT, HEARTBEAT_INTERVAL_MS } from "../../sse.js";
import { getRequestContext } from "../../../context/request-context.js";
import type { ChatImageStorage } from "../../../repository/chat-images.js";
import type { StoredChatImage } from "../../../repository/persistence.js";
import { toErrorPayload } from "../errors.js";
import { rateLimitHook, type SlidingWindowLimiter } from "../middleware/rate-limit.js";
import { createLogger } from "../../../logger.js";
import { MAX_UPLOAD_BYTES, MAX_IMAGES_PER_TURN, MAX_IMAGE_DATA_URL_CHARS, DATA_URL_PATTERN } from "././shared.js";
import { isVisionBlocked, type ModelCapabilityRegistry } from "../../../llm/model-capabilities.js";
import { config } from "../../../config/index.js";

const log = createLogger("HTTP");

/**
 * Chat routes: session document upload + the streaming ask endpoint (the frontend's
 * custom frame protocol lives here; third-party OpenAI clients use routes/openai.ts).
 * Parameter validation + delegation only — orchestration lives in ChatService.
 */
export function registerChatRoutes(
  app: FastifyInstance,
  deps: {
    chat: ChatService;
    sessionDocs: SessionDocumentRepository;
    /** durable attachment storage; absent or non-durable → original files not kept */
    chatImages?: ChatImageStorage;
    ocr: OcrClient;
    limiter: SlidingWindowLimiter;
    capabilities: ModelCapabilityRegistry;
    /** folder_ids → bvids via app-kg ResolveScope; absent/unavailable = unscoped (fail-open) */
    resolveFolderScope?: (uid: string, folderIds: number[]) => Promise<string[]>;
    /** RAG search for POST /chat/search; absent = route returns 503 */
    rag?: Pick<RAGService, "search">;
  },
): void {
  // ---- Session document upload: parse → chunk → store (strictly scoped to the current session) ----
  app.post("/chat/documents", async (req: FastifyRequest, reply: FastifyReply) => {
    let file;
    try {
      file = await req.file({ limits: { fileSize: MAX_UPLOAD_BYTES } });
    } catch {
      return reply.status(413).send({ detail: `文件过大（上限 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB）` });
    }
    if (!file) {
      return reply.status(400).send({ detail: "缺少文件（multipart 字段名 file）" });
    }
    const sessionField = file.fields.session_id as { value?: string } | undefined;
    const sessionId = sessionField?.value;
    if (!sessionId) {
      return reply.status(400).send({ detail: "缺少 session_id 字段（文档只对当前会话生效）" });
    }

    let buffer: Buffer;
    try {
      buffer = await file.toBuffer();
    } catch {
      return reply.status(413).send({ detail: `文件过大（上限 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB）` });
    }

    try {
      const parsed = await parseDocument(file.filename, buffer, deps.ocr);
      const chunker = new SemanticChunker();
      const chunks = chunker
        .chunk(parsed.text, file.filename)
        .map((c) => c.embeddingText)
        .filter((t) => t.length > 5);
      if (chunks.length === 0) {
        return reply.status(422).send({ detail: "文档解析后没有可用文本" });
      }
      // 原始文件二进制 → MinIO(可下载回看);解析/切块失败时不阻塞检索用途
      let stored: StoredChatImage | undefined;
      if (deps.chatImages?.durable) {
        try {
          stored = await deps.chatImages.putFile(sessionId, file.filename, buffer, file.mimetype || "application/octet-stream");
        } catch (err) {
          log.warn(`[HTTP] original file store failed (chunks still usable): ${err instanceof Error ? err.message : err}`);
        }
      }
      const meta = await deps.sessionDocs.save(sessionId, file.filename, chunks, buffer.length, stored);
      log.info(`[HTTP] session doc uploaded session=${sessionId} file=${file.filename} chunks=${meta.chunkCount} stored=${stored ? "minio" : "inline-only"}`);
      return {
        id: meta.id,
        filename: meta.filename,
        chunks: meta.chunkCount,
        size_bytes: meta.sizeBytes,
        session_id: sessionId,
        ...(stored ? { download_url: await deps.chatImages!.presignGet(stored.key) } : {}),
      };
    } catch (err) {
      if (err instanceof UnsupportedDocumentError) {
        return reply.status(415).send({ detail: err.message });
      }
      if (err instanceof OcrError) {
        const status = err.kind === "upstream" ? 503 : err.kind === "config" ? 500 : 415;
        return reply.status(status).send({ detail: err.message, code: `ocr_${err.kind}` });
      }
      throw err;
    }
  });

  // ---- Session document list / delete (per-session files panel in the chat UI).
  //      Same uri as the upload route (already covered by the APISIX chat_ts uri);
  //      sessionId scoping makes a guessed id cross-session-proof. ----
  app.get("/chat/documents", async (req: FastifyRequest, reply: FastifyReply) => {
    const query = (req.query ?? {}) as { session_id?: string };
    const sessionId = query.session_id?.trim();
    if (!sessionId) {
      return reply.status(400).send({ detail: "缺少 session_id" });
    }
    const docs = await deps.sessionDocs.list(sessionId);
    return {
      documents: await Promise.all(docs.map(async (d) => ({
        id: d.id,
        session_id: d.sessionId,
        filename: d.filename,
        size_bytes: d.sizeBytes,
        chunk_count: d.chunkCount,
        created_at: d.createdAt,
        // 原始文件可下载(MinIO 预签名,经 nginx /minio-proxy/);未存的旧文档无此字段
        ...(d.key && deps.chatImages ? { download_url: await deps.chatImages.presignGet(d.key) } : {}),
      }))),
    };
  });

  app.delete("/chat/documents", async (req: FastifyRequest, reply: FastifyReply) => {
    const query = (req.query ?? {}) as { session_id?: string; id?: string };
    const sessionId = query.session_id?.trim();
    const id = query.id?.trim();
    if (!sessionId || !id) {
      return reply.status(400).send({ detail: "缺少 session_id 或 id" });
    }
    // 行删除前取 key:连带清理 MinIO 里的原始文件对象
    const docs = await deps.sessionDocs.list(sessionId);
    const target = docs.find((d) => d.id === id);
    const deleted = await deps.sessionDocs.delete(sessionId, id);
    if (deleted && target?.key && deps.chatImages?.durable) {
      await deps.chatImages.remove(target.key).catch(() => undefined);
    }
    return { success: true, deleted };
  });

  // ---- Chat SSE (rate-limit preHandler: LLM endpoints are expensive) ----
  // /chat/ask/agent/stream is the frontend's path (Python contract); /chat/ask/stream
  // is app-ts's native name — same handler, one registration each.
  for (const path of ["/chat/ask/agent/stream", "/chat/ask/stream"] as const) {
    app.post(
      path,
      { preHandler: rateLimitHook(deps.limiter) },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = (req.body ?? {}) as {
        query?: string;
        question?: string;
        session_id?: string;
        chat_session_id?: string;
        uid?: string;
        agent_name?: string;
        scope?: SearchScope;
        folder_ids?: number[];
        images?: string[];
        skill_ids?: string[];
      };
      const query = (body.question ?? body.query)?.trim();
      if (!query) {
        return reply.status(400).send({ detail: "query 不能为空" });
      }
      // multimodal: validate attachments, then gate on the configured model's vision capability
      const images = Array.isArray(body.images) ? body.images : [];
      if (images.length > MAX_IMAGES_PER_TURN) {
        return reply.status(400).send({ detail: `图片数量超限（最多 ${MAX_IMAGES_PER_TURN} 张）` });
      }
      for (const image of images) {
        if (typeof image !== "string" || !DATA_URL_PATTERN.test(image)) {
          return reply.status(400).send({ detail: "图片格式无效：仅支持 data:image/(png|jpeg|webp|gif);base64 形式" });
        }
        if (image.length > MAX_IMAGE_DATA_URL_CHARS) {
          return reply.status(400).send({ detail: `单张图片过大（data URL 上限 ${Math.floor(MAX_IMAGE_DATA_URL_CHARS / 1024)}KB）` });
        }
      }
      if (images.length > 0 && isVisionBlocked(deps.capabilities.get(config.llm.model))) {
        return reply.status(400).send({
          detail: `当前模型 ${config.llm.model} 不支持视觉，无法识别图片。请切换支持视觉的模型（如 z-ai/glm-5.3-flash、qwen-vl 系列）后再发送图片。`,
        });
      }

      // Declare takeover of the raw response (SSE writes directly to reply.raw, Fastify no longer intervenes)
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      const heartbeat = setInterval(() => {
        reply.raw.write(HEARTBEAT);
      }, HEARTBEAT_INTERVAL_MS);

      // Note: must listen for close on the response (reply.raw), not on the request —
      // in Node 16+, IncomingMessage's close fires as soon as the request body is fully read, which would cut the stream off prematurely
      let closed = false;
      reply.raw.on("close", () => {
        closed = true;
      });

      // frontend contract: folder_ids resolve to a bvid scope via app-kg (MySQL
      // collection/favorite_folders); unavailable resolver → unscoped fail-open
      let scope = body.scope;
      const uid = body.uid ?? getRequestContext()?.uid;
      if (body.folder_ids && body.folder_ids.length > 0 && deps.resolveFolderScope && uid !== undefined) {
        const bvids = await deps.resolveFolderScope(uid, body.folder_ids).catch((err) => {
          log.warn(`[HTTP] folder scope resolution failed (unscoped): ${err instanceof Error ? err.message : err}`);
          return undefined;
        });
        if (bvids) scope = { ...scope, bvids };
      }

      try {
        for await (const frame of deps.chat.askStream({
          query,
          sessionId: body.chat_session_id ?? body.session_id,
          uid,
          agentName: body.agent_name,
          scope,
          images: images.length > 0 ? images : undefined,
          skillIds: Array.isArray(body.skill_ids) ? body.skill_ids.filter((s) => typeof s === 'string') : undefined,
        })) {
          if (closed) break;
          reply.raw.write(`data: ${JSON.stringify(frame)}\n\n`);
        }
      } catch (err) {
        const requestId = (req as unknown as { requestId?: string }).requestId ?? "-";
        log.error(
          `[HTTP] stream failed url=%s request_id=%s: %s`,
          req.url,
          requestId,
          err instanceof Error ? err.stack || err.message : String(err),
        );
        if (!closed) {
          // same sanitization as the JSON error handler: unknown errors → generic detail
          const { body } = toErrorPayload(err, requestId);
          reply.raw.write(`data: ${JSON.stringify({ type: "error", message: body.detail, code: body.code })}\n\n`);
          reply.raw.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
        }
      } finally {
        clearInterval(heartbeat);
        if (!reply.raw.writableEnded) {
          reply.raw.end();
        }
      }
    },
      );
    }

  // ---- Vector search (POST /chat/search) — mirrors the Python chat router's
  //      search contract: global video search, per-bvid dedup, preview cap ----
  app.post("/chat/search", async (req: FastifyRequest, reply: FastifyReply) => {
    const uid = getRequestContext()?.uid;
    // uid 已迁移为字符串（server.ts onRequest 钩子），只判存在性
    if (uid === undefined) {
      return reply.status(401).send({ detail: "缺少用户身份（X-Uid）" });
    }
    if (!deps.rag) {
      return reply.status(503).send({ detail: "检索服务不可用" });
    }
    const body = (req.body ?? {}) as { query?: string; k?: number };
    const query = (body.query ?? "").trim();
    if (!query) {
      return reply.status(400).send({ detail: "查询不能为空" });
    }
    const k = Math.min(Math.max(Number(body.k ?? 5) || 5, 1), 100);
    try {
      const docs = await deps.rag.search(query, k);
      const results: Array<{ bvid: string; title: string; url: string; content_preview: string }> = [];
      const seen = new Set<string>();
      for (const doc of docs) {
        const bvid = String(doc.metadata.bvid ?? "");
        if (!bvid || seen.has(bvid)) continue;
        seen.add(bvid);
        const preview = doc.text.length > 200 ? `${doc.text.slice(0, 200)}...` : doc.text;
        results.push({
          bvid,
          title: String(doc.metadata.title ?? ""),
          url: String(doc.metadata.url ?? ""),
          content_preview: preview,
        });
      }
      return { results };
    } catch (err) {
      log.error(`[HTTP] chat search failed: ${err instanceof Error ? err.message : err}`);
      return reply.status(500).send({ detail: "搜索失败，请稍后重试" });
    }
  });
}
