import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ChatSessionRepository, MessageRepository } from "../../../repository/persistence.js";
import type { ChatImageStorage } from "../../../repository/chat-images.js";
import type { SessionDocumentRepository } from "../../../repository/session-docs.js";
import { ChatSessionsService, ChatSessionsError } from "../../../services/chat-sessions.js";
import { getRequestContext } from "../../../context/request-context.js";

/**
 * Chat sessions/history routes — the /chat/sessions* + /chat/history* slices
 * of the Python /chat surface (mirrored wire contract, snake_case fields).
 * /chat/ask/stream lives in routes/chat.ts (SSE); together they cover the
 * frontend chatApi after the chat-domain cutover to app-ts.
 */
export function registerChatSessionRoutes(
  app: FastifyInstance,
  deps: { sessions: ChatSessionRepository; messages: MessageRepository; chatImages?: ChatImageStorage; sessionDocs?: SessionDocumentRepository },
): void {
  const svc = new ChatSessionsService(deps.sessions, deps.messages, { chatImages: deps.chatImages, sessionDocs: deps.sessionDocs });

  const requireUid = (req: FastifyRequest): string | undefined => {
    // uid 在 onRequest 钩子里已按字符串承载（int64 精度安全）
    const uid = getRequestContext()?.uid;
    return typeof uid === "string" ? uid : undefined;
  };

  const respond = (reply: FastifyReply, err: unknown) => {
    if (err instanceof ChatSessionsError) {
      return reply.status(err.status).send({ detail: err.message });
    }
    throw err;
  };

  const intParam = (raw: string | undefined, def: number, min: number, max: number): number => {
    const n = Number(raw ?? "");
    if (!Number.isInteger(n) || n < min) return def;
    return Math.min(n, max);
  };

  app.post("/chat/sessions", async (req: FastifyRequest, reply: FastifyReply) => {
    const uid = requireUid(req);
    if (uid === undefined) return reply.status(401).send({ detail: "缺少用户身份（X-Uid）" });
    const body = (req.body ?? {}) as { title?: string };
    try {
      return await svc.create(uid, body.title);
    } catch (err) {
      return respond(reply, err);
    }
  });

  app.get("/chat/sessions", async (req: FastifyRequest, reply: FastifyReply) => {
    const uid = requireUid(req);
    if (uid === undefined) return reply.status(401).send({ detail: "缺少用户身份（X-Uid）" });
    try {
      return { sessions: await svc.list(uid) };
    } catch (err) {
      return respond(reply, err);
    }
  });

  app.get("/chat/sessions/:session_id", async (req: FastifyRequest, reply: FastifyReply) => {
    const uid = requireUid(req);
    if (uid === undefined) return reply.status(401).send({ detail: "缺少用户身份（X-Uid）" });
    const { session_id } = req.params as { session_id: string };
    try {
      return await svc.get(uid, session_id);
    } catch (err) {
      return respond(reply, err);
    }
  });

  app.patch("/chat/sessions/:session_id", async (req: FastifyRequest, reply: FastifyReply) => {
    const uid = requireUid(req);
    if (uid === undefined) return reply.status(401).send({ detail: "缺少用户身份（X-Uid）" });
    const { session_id } = req.params as { session_id: string };
    const body = (req.body ?? {}) as { title?: string };
    try {
      return await svc.rename(uid, session_id, body.title ?? "");
    } catch (err) {
      return respond(reply, err);
    }
  });

  app.delete("/chat/sessions/:session_id", async (req: FastifyRequest, reply: FastifyReply) => {
    const uid = requireUid(req);
    if (uid === undefined) return reply.status(401).send({ detail: "缺少用户身份（X-Uid）" });
    const { session_id } = req.params as { session_id: string };
    try {
      return await svc.delete(uid, session_id);
    } catch (err) {
      return respond(reply, err);
    }
  });

  app.get("/chat/history", async (req: FastifyRequest, reply: FastifyReply) => {
    const uid = requireUid(req);
    if (uid === undefined) return reply.status(401).send({ detail: "缺少用户身份（X-Uid）" });
    const query = req.query as { chat_session_id?: string; page?: string; page_size?: string };
    if (!query.chat_session_id) return reply.status(400).send({ detail: "chat_session_id 不能为空" });
    const page = intParam(query.page, 1, 1, Number.MAX_SAFE_INTEGER);
    const pageSize = intParam(query.page_size, 50, 1, 100);
    try {
      return await svc.history(uid, query.chat_session_id, page, pageSize);
    } catch (err) {
      return respond(reply, err);
    }
  });

  app.delete("/chat/history", async (req: FastifyRequest, reply: FastifyReply) => {
    const uid = requireUid(req);
    if (uid === undefined) return reply.status(401).send({ detail: "缺少用户身份（X-Uid）" });
    const query = req.query as { chat_session_id?: string };
    if (!query.chat_session_id) return reply.status(400).send({ detail: "chat_session_id 不能为空" });
    try {
      return await svc.clearHistory(uid, query.chat_session_id);
    } catch (err) {
      return respond(reply, err);
    }
  });

  app.delete("/chat/history/from/:msg_id", async (req: FastifyRequest, reply: FastifyReply) => {
    const uid = requireUid(req);
    if (uid === undefined) return reply.status(401).send({ detail: "缺少用户身份（X-Uid）" });
    const { msg_id } = req.params as { msg_id: string };
    const query = req.query as { chat_session_id?: string };
    if (!query.chat_session_id) return reply.status(400).send({ detail: "chat_session_id 不能为空" });
    try {
      return await svc.truncateFrom(uid, query.chat_session_id, msg_id);
    } catch (err) {
      return respond(reply, err);
    }
  });
}
