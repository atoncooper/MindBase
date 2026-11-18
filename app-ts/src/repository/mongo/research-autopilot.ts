import { MongoClient, type Collection, type Db } from "mongodb";
import { config } from "../../config/index.js";
import { createLogger } from "../../logger.js";
import type { ResearchAutopilotRepository, ResearchAutopilotSetting } from "../research-autopilot.js";

const log = createLogger("MONGO");

/**
 * MongoDB adapter for autopilot settings: database mind_base_ts, collection
 * research_autopilot, exactly one row per (uid, projectId) enforced by a unique
 * index. Optional fields are $unset when absent so resume() really clears the
 * emergency-stop stamp instead of leaving the old value behind.
 */
export class MongoResearchAutopilotRepository implements ResearchAutopilotRepository {
  private constructor(
    private readonly client: MongoClient,
    private readonly db: Db,
    private readonly items: Collection<ResearchAutopilotSetting>,
  ) {}

  static async connect(): Promise<MongoResearchAutopilotRepository | null> {
    const { uri, database, timeoutMs } = config.mongo;
    if (!uri) return null;
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: timeoutMs,
      connectTimeoutMS: timeoutMs,
    });
    try {
      await client.connect();
      const db = client.db(database);
      const items = db.collection<ResearchAutopilotSetting>("research_autopilot");
      await items.createIndex({ uid: 1, projectId: 1 }, { unique: true });
      return new MongoResearchAutopilotRepository(client, db, items);
    } catch (err) {
      log.warn(
        "[AUTOPILOT] Mongo research_autopilot connect failed: " +
          (err instanceof Error ? err.message : String(err)),
      );
      await client.close().catch(() => {});
      return null;
    }
  }

  async get(uid: string, projectId: string): Promise<ResearchAutopilotSetting | undefined> {
    return (await this.items.findOne({ uid, projectId })) ?? undefined;
  }

  async save(setting: ResearchAutopilotSetting): Promise<void> {
    const doc: ResearchAutopilotSetting = { ...setting };
    const unset: Record<string, ""> = {};
    for (const field of ["stoppedAt", "lastTickAt", "lastResult"] as const) {
      if (doc[field] === undefined) {
        delete doc[field];
        unset[field] = "";
      }
    }
    await this.items.updateOne(
      { uid: setting.uid, projectId: setting.projectId },
      { $set: doc, ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}) },
      { upsert: true },
    );
  }

  /** Scheduler enumeration: configured, not-off and not emergency-stopped rows. */
  async listActive(): Promise<ResearchAutopilotSetting[]> {
    return this.items.find({ mode: { $ne: "off" }, stoppedAt: { $exists: false } }).toArray();
  }

  async removeByProject(uid: string, projectId: string): Promise<number> {
    const result = await this.items.deleteMany({ uid, projectId });
    return result.deletedCount;
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
