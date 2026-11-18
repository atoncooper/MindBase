import { MongoClient, type Collection, type Db, type Filter } from "mongodb";
import { config } from "../../config/index.js";
import { createLogger } from "../../logger.js";
import {
  academicNotificationListLimit,
  type AcademicNotification,
  type AcademicNotificationListOptions,
  type AcademicNotificationRepository,
} from "../academic-notifications.js";

const log = createLogger("MONGO");

/**
 * MongoDB adapter for the notification centre: database mind_base_ts,
 * collection academic_notifications .
 *
 * Unknown readAt is persisted as a missing field (not null) so the unread
 * filters use $exists:false and stay index-friendly; createdAt desc everywhere.
 */
export class MongoAcademicNotificationRepository implements AcademicNotificationRepository {
  private constructor(
    private readonly client: MongoClient,
    private readonly db: Db,
    private readonly items: Collection<AcademicNotification>,
  ) {}

  static async connect(): Promise<MongoAcademicNotificationRepository | null> {
    const { uri, database, timeoutMs } = config.mongo;
    if (!uri) return null;
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: timeoutMs,
      connectTimeoutMS: timeoutMs,
    });
    try {
      await client.connect();
      const db = client.db(database);
      const items = db.collection<AcademicNotification>("academic_notifications");
      await items.createIndex({ id: 1 }, { unique: true });
      // Bell badge ("unread count") + unread-only list, newest first.
      await items.createIndex({ uid: 1, readAt: 1, createdAt: -1 });
      // Full per-user list, newest first (documented index).
      await items.createIndex({ uid: 1, createdAt: -1 });
      return new MongoAcademicNotificationRepository(client, db, items);
    } catch (err) {
      log.warn(
        "[NOTIFICATION] Mongo academic_notifications connect failed: " +
          (err instanceof Error ? err.message : String(err)),
      );
      await client.close().catch(() => {});
      return null;
    }
  }

  async create(notification: AcademicNotification): Promise<void> {
    const doc: AcademicNotification = { ...notification };
    // Keep "unread" as a missing field so $exists:false filters work without
    // depending on how the driver serializes undefined values.
    if (doc.readAt === undefined) delete doc.readAt;
    await this.items.insertOne(doc);
  }

  async listByUid(
    uid: string,
    opts: AcademicNotificationListOptions = {},
  ): Promise<AcademicNotification[]> {
    const filter: Filter<AcademicNotification> = { uid };
    if (opts.unreadOnly === true) filter.readAt = { $exists: false };
    return this.items
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(academicNotificationListLimit(opts.limit))
      .toArray();
  }

  async unreadCount(uid: string): Promise<number> {
    return this.items.countDocuments({ uid, readAt: { $exists: false } });
  }

  async markRead(uid: string, id: string): Promise<boolean> {
    const stamp = await this.items.updateOne(
      { id, uid, readAt: { $exists: false } },
      { $set: { readAt: Date.now() } },
    );
    if (stamp.matchedCount > 0) return true;
    // Idempotent: an already-read row of the caller still answers true; a row
    // owned by someone else (or missing) answers false and is never modified.
    return (await this.items.countDocuments({ id, uid }, { limit: 1 })) > 0;
  }

  async removeByProject(uid: string, projectId: string): Promise<number> {
    const result = await this.items.deleteMany({ uid, projectId });
    return result.deletedCount;
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
