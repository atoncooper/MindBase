import type { FastifyInstance, FastifyReply } from "fastify";
import { getRequestContext } from "../../../context/request-context.js";
import type { AcademicNotification } from "../../../repository/academic-notifications.js";
import { academicNotificationListLimit } from "../../../repository/academic-notifications.js";
import type { ResearchNotificationService } from "../../../services/research/notifications.js";

/** 站内通知 REST：列表 + 未读数、标记已读。 */
export interface NotificationRouteDeps {
  /** Only the read side of the service is needed by the HTTP surface. */
  notifications: Pick<ResearchNotificationService, "list" | "unreadCount" | "markRead">;
}

export function registerNotificationRoutes(app: FastifyInstance, deps: NotificationRouteDeps): void {
  const uidOf = (): string | undefined => {
    const uid = getRequestContext()?.uid;
    return typeof uid === "string" ? uid : undefined;
  };

  const requireUid = (reply: FastifyReply): string | undefined => {
    const uid = uidOf();
    if (uid === undefined) {
      void reply.status(401).send({ detail: "缺少用户身份（X-Uid）" });
      return undefined;
    }
    return uid;
  };

  // ---- list + badge (contract: newest-first, limit default 20 / max 100) ----

  app.get("/academic/notifications", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const query = req.query as { limit?: unknown; unread?: unknown };
    const opts = {
      limit: academicNotificationListLimit(queryLimit(query.limit)),
      unreadOnly: flagEnabled(query.unread),
    };
    const [notifications, unreadCount] = await Promise.all([
      deps.notifications.list(uid, opts),
      deps.notifications.unreadCount(uid),
    ]);
    return { notifications: notifications.map(notificationPayload), unreadCount };
  });

  // ---- mark one row read (404 for missing/foreign, idempotent for own rows) --

  app.post("/academic/notifications/:id/read", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { id } = req.params as { id: string };
    const read = await deps.notifications.markRead(uid, id);
    if (!read) return reply.status(404).send({ detail: "通知不存在或无权访问" });
    return { read: true };
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Explicit projection: no Mongo _id, no uid (see the module comment). */
function notificationPayload(notification: AcademicNotification) {
  return {
    id: notification.id,
    projectId: notification.projectId,
    type: notification.type,
    title: notification.title,
    ...(notification.body !== undefined ? { body: notification.body } : {}),
    ...(notification.link !== undefined ? { link: notification.link } : {}),
    ...(notification.readAt !== undefined ? { readAt: notification.readAt } : {}),
    createdAt: notification.createdAt,
  };
}

/** Query values arrive as strings; a non-numeric/blank limit falls back to the default. */
function queryLimit(raw: unknown): number | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** ?unread=1 / ?unread=true means "unread only". */
function flagEnabled(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  const value = raw.trim().toLowerCase();
  return value === "1" || value === "true";
}
