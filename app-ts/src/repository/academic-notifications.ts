/** 站内通知仓储契约（uid 隔离）。 */

/** Kinds of notification the workbench renders (persisted — never rename). */
export const ACADEMIC_NOTIFICATION_TYPES = [
  "approval",
  "experiment",
  "validation",
  "plan",
  "system",
] as const;
/** One notification kind (see ACADEMIC_NOTIFICATION_TYPES). */
export type AcademicNotificationType = (typeof ACADEMIC_NOTIFICATION_TYPES)[number];

/**
 * One durable in-app notification. `readAt` is stamped the first time the user
 * marks the row read (epoch ms); absent = unread. `link` is an optional
 * front-end route the bell can navigate to (e.g. "/research?project=...&tab=approval")
 * and is stored verbatim — it is a UI hint, not a security boundary.
 */
export interface AcademicNotification {
  id: string;
  uid: string;
  projectId: string;
  type: AcademicNotificationType;
  title: string;
  body?: string;
  link?: string;
  readAt?: number;
  createdAt: number;
}

/** Read options for listByUid: page size plus the unread-only filter. */
export interface AcademicNotificationListOptions {
  /** Page size; normalized by academicNotificationListLimit (default 20, max 100). */
  limit?: number;
  /** true = only rows with no readAt (the bell's "未读" filter). */
  unreadOnly?: boolean;
}

/**
 * Notification store contract. Newest-first everywhere; `markRead` only ever
 * touches the caller's own row and is idempotent (the first read timestamp is
 * preserved on repeated calls). Unknown/foreign ids answer false, never throw.
 */
export interface AcademicNotificationRepository {
  create(notification: AcademicNotification): Promise<void>;
  listByUid(uid: string, opts?: AcademicNotificationListOptions): Promise<AcademicNotification[]>;
  unreadCount(uid: string): Promise<number>;
  /** true when the row exists under uid (already-read rows included); false when missing or foreign. */
  markRead(uid: string, id: string): Promise<boolean>;
  /** 永久删除项目下所有通知（级联清理），返回删除条数。 */
  removeByProject(uid: string, projectId: string): Promise<number>;
}

/** Default page size of a notification list (contract: limit defaults to 20). */
export const ACADEMIC_NOTIFICATION_DEFAULT_LIMIT = 20;
/** Upper bound of a notification list page (contract: capped at 100). */
export const ACADEMIC_NOTIFICATION_MAX_LIMIT = 100;

/** Normalize a list limit: default 20, clamped to [1, 100] (out-of-range values never throw). */
export function academicNotificationListLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return ACADEMIC_NOTIFICATION_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), ACADEMIC_NOTIFICATION_MAX_LIMIT);
}

/** Runtime guard used by the service before persisting an untyped caller input. */
export function isAcademicNotificationType(value: unknown): value is AcademicNotificationType {
  return typeof value === "string" && (ACADEMIC_NOTIFICATION_TYPES as readonly string[]).includes(value);
}

/** True when the row is still unread (no readAt stamp yet). */
export function isUnreadAcademicNotification(
  notification: Pick<AcademicNotification, "readAt">,
): boolean {
  return notification.readAt === undefined;
}
