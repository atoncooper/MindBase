import { randomUUID } from "node:crypto";
import { createLogger } from "../../logger.js";
import {
  academicNotificationListLimit,
  isAcademicNotificationType,
  type AcademicNotification,
  type AcademicNotificationListOptions,
  type AcademicNotificationRepository,
  type AcademicNotificationType,
} from "../../repository/academic-notifications.js";

const log = createLogger("NOTIFICATION");

/** Max title length kept on a stored notification (longer titles are clipped). */
export const NOTIFICATION_TITLE_MAX = 200;
/** Max body length kept on a stored notification (longer bodies are clipped). */
export const NOTIFICATION_BODY_MAX = 1000;

/**
 * Create payload. `createdAt` is optional so an event replay can back-date the
 * row to the event time; normally the service stamps Date.now().
 */
export interface ResearchNotificationCreateInput {
  uid: string;
  projectId: string;
  type: AcademicNotificationType;
  title: string;
  body?: string;
  /** Optional front-end link ("/research?project=...&tab=approval"). */
  link?: string;
  /** Optional epoch-ms creation stamp (event replay/backfill); defaults to now. */
  createdAt?: number;
}

/** 站内通知服务：创建、列表、未读数、标记已读。 */
export class ResearchNotificationService {
  constructor(private readonly repo: AcademicNotificationRepository) {}

  /**
   * Persist one notification and return the created row.
   * Never throws: unusable input (blank identity/title, unknown type) and
   * storage failures are logged and answered with undefined, so event handlers
   * can fire-and-forget without a try/catch.
   */
  async create(input: ResearchNotificationCreateInput): Promise<AcademicNotification | undefined> {
    try {
      if (!input || typeof input !== "object") return undefined;
      const uid = typeof input.uid === "string" ? input.uid.trim() : "";
      const projectId = typeof input.projectId === "string" ? input.projectId.trim() : "";
      if (uid === "" || projectId === "") return undefined;
      if (!isAcademicNotificationType(input.type)) {
        log.warn("[NOTIFICATION] create skipped: unknown type=" + String(input.type));
        return undefined;
      }
      const title = typeof input.title === "string" ? clip(input.title.trim(), NOTIFICATION_TITLE_MAX) : "";
      if (title === "") return undefined;
      const body =
        typeof input.body === "string" && input.body.trim() !== ""
          ? clip(input.body.trim(), NOTIFICATION_BODY_MAX)
          : undefined;
      const notification: AcademicNotification = {
        id: randomUUID(),
        uid,
        projectId,
        type: input.type,
        title,
        ...(body !== undefined ? { body } : {}),
        ...(typeof input.link === "string" && input.link.trim() !== ""
          ? { link: input.link.trim() }
          : {}),
        createdAt:
          typeof input.createdAt === "number" && Number.isFinite(input.createdAt)
            ? Math.trunc(input.createdAt)
            : Date.now(),
      };
      await this.repo.create(notification);
      return notification;
    } catch (err) {
      log.warn(
        "[NOTIFICATION] create failed (best-effort, swallowed): " +
          (err instanceof Error ? err.message : String(err)),
      );
      return undefined;
    }
  }

  /**
   * Newest-first notifications of the caller, optionally unread-only.
   * Limit is normalized by academicNotificationListLimit (default 20, max 100).
   */
  async list(
    uid: string,
    opts: AcademicNotificationListOptions = {},
  ): Promise<AcademicNotification[]> {
    if (typeof uid !== "string" || uid.trim() === "") return [];
    return this.repo.listByUid(uid, {
      limit: academicNotificationListLimit(opts.limit),
      unreadOnly: opts.unreadOnly === true,
    });
  }

  /** Number of unread notifications of the caller (bell badge). */
  async unreadCount(uid: string): Promise<number> {
    if (typeof uid !== "string" || uid.trim() === "") return 0;
    return this.repo.unreadCount(uid);
  }

  /** Mark one of the caller's rows read; false when missing/foreign (REST 404). */
  async markRead(uid: string, id: string): Promise<boolean> {
    if (typeof uid !== "string" || uid.trim() === "") return false;
    if (typeof id !== "string" || id.trim() === "") return false;
    return this.repo.markRead(uid, id);
  }
}

/** Clip to a maximum length (by UTF-16 code units, matching the size contract). */
function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}
