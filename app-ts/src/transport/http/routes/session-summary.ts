import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getRequestContext } from "../../../context/request-context.js";
import {
  SessionSummaryError,
  type SessionSummaryService,
} from "../../../services/session-summary.js";
import { createLogger } from "../../../logger.js";

const log = createLogger("HTTP");

/**
 * Session summary routes — POST /chat/sessions/:id/summary (SSE) + GET (latest
 * persisted). Port of app/routers/session_summary.py; mounted under /chat so
 * the existing nginx /chat/ + APISIX chat_ts SSE chain carries them.
 *
 * Validation runs before the stream opens (404 session / 400 empty session);
 * frames mirror the Python protocol: chunk / done / error.
 */
export function registerSessionSummaryRoutes(
  app: FastifyInstance,
  deps: { summaries: SessionSummaryService },
): void {
  const requireUid = (req: FastifyRequest): string | undefined => {
    // uid 在 onRequest 钩子里已按字符串承载（int64 精度安全）
    const uid = getRequestContext()?.uid;
    return typeof uid === "string" ? uid : undefined;
  };

  const respond = (reply: FastifyReply, err: unknown) => {
    if (err instanceof SessionSummaryError) {
      return reply.status(err.status).send({ detail: err.message });
    }
    throw err;
  };

  app.get("/chat/sessions/:session_id/summary", async (req: FastifyRequest, reply: FastifyReply) => {
    const uid = requireUid(req);
    if (uid === undefined) return reply.status(401).send({ detail: "缺少用户身份（X-Uid）" });
    const { session_id } = req.params as { session_id: string };
    try {
      const doc = await deps.summaries.latest(uid, session_id);
      return deps.summaries.toWire(doc);
    } catch (err) {
      return respond(reply, err);
    }
  });

  app.post("/chat/sessions/:session_id/summary", async (req: FastifyRequest, reply: FastifyReply) => {
    const uid = requireUid(req);
    if (uid === undefined) return reply.status(401).send({ detail: "缺少用户身份（X-Uid）" });
    const { session_id } = req.params as { session_id: string };

    let prepared;
    try {
      prepared = await deps.summaries.prepare(uid, session_id);
    } catch (err) {
      return respond(reply, err);
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    try {
      for await (const frame of deps.summaries.streamFrames(uid, session_id, prepared)) {
        reply.raw.write("data: " + JSON.stringify(frame) + "\n\n");
      }
    } catch (err) {
      const requestId = (req as unknown as { requestId?: string }).requestId ?? "-";
      log.error(
        "[HTTP] summary stream failed url=" + req.url + " request_id=" + requestId + ": " +
          (err instanceof Error ? err.stack || err.message : String(err)),
      );
      if (!reply.raw.writableEnded) {
        reply.raw.write("data: " + JSON.stringify({ type: "error", message: "总结生成失败" }) + "\n\n");
      }
    } finally {
      if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
    }
  });
}
