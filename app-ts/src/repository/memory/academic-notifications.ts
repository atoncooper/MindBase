import {
  academicNotificationListLimit,
  isUnreadAcademicNotification,
  type AcademicNotification,
  type AcademicNotificationListOptions,
  type AcademicNotificationRepository,
} from "../academic-notifications.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * In-process notification store (unit tests + MongoDB-unreachable fallback).
 *
 * Rows are stored verbatim and returned as clones, so callers can never mutate
 * the store through a list result. Ordering is createdAt desc (stable for equal
 * timestamps: insertion order), unread = no readAt stamp.
 */
export class MemoryAcademicNotificationRepository implements AcademicNotificationRepository {
  private readonly items = new Map<string, AcademicNotification>();

  async create(notification: AcademicNotification): Promise<void> {
    this.items.set(notification.id, clone(notification));
  }

  async listByUid(
    uid: string,
    opts: AcademicNotificationListOptions = {},
  ): Promise<AcademicNotification[]> {
    const limit = academicNotificationListLimit(opts.limit);
    return [...this.items.values()]
      .filter((n) => n.uid === uid && (opts.unreadOnly !== true || isUnreadAcademicNotification(n)))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map(clone);
  }

  async unreadCount(uid: string): Promise<number> {
    let count = 0;
    for (const n of this.items.values()) {
      if (n.uid === uid && isUnreadAcademicNotification(n)) count += 1;
    }
    return count;
  }

  async markRead(uid: string, id: string): Promise<boolean> {
    const found = this.items.get(id);
    if (!found || found.uid !== uid) return false;
    // Idempotent: the first read timestamp wins, a repeated click keeps it.
    if (isUnreadAcademicNotification(found)) found.readAt = Date.now();
    return true;
  }

  async removeByProject(uid: string, projectId: string): Promise<number> {
    let removed = 0;
    for (const [id, notification] of [...this.items]) {
      if (notification.uid !== uid || notification.projectId !== projectId) continue;
      this.items.delete(id);
      removed += 1;
    }
    return removed;
  }
}
