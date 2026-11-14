import { MongoClient, type Collection, type Db } from "mongodb";
import { config } from "../../config/index.js";
import { createLogger } from "../../logger.js";
import { planRunListLimit, type PlanRunRecord, type PlanRunRepository } from "../plan-runs.js";

const log = createLogger("MONGO");

/** MongoDB plan-run store (database mind_base_ts, collection plan_runs). */
export class MongoPlanRunRepository implements PlanRunRepository {
  private constructor(
    private readonly client: MongoClient,
    private readonly db: Db,
    private readonly runs: Collection<PlanRunRecord>,
  ) {}

  static async connect(): Promise<MongoPlanRunRepository | null> {
    const { uri, database, timeoutMs } = config.mongo;
    if (!uri) return null;
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: timeoutMs,
      connectTimeoutMS: timeoutMs,
    });
    try {
      await client.connect();
      const db = client.db(database);
      const runs = db.collection<PlanRunRecord>("plan_runs");
      await runs.createIndex({ runId: 1 }, { unique: true });
      await runs.createIndex({ chatSessionId: 1, updatedAt: -1 });
      // uid-scoped plan history: GET /chat/plans sorts by updatedAt, newest first.
      await runs.createIndex({ uid: 1, updatedAt: -1 });
      // project-scoped history: research workbench "计划" Tab (GET /chat/plans?project_id=).
      await runs.createIndex({ uid: 1, projectId: 1, updatedAt: -1 });
      await runs.createIndex({ status: 1, updatedAt: -1 });
      return new MongoPlanRunRepository(client, db, runs);
    } catch (err) {
      log.warn("[PLAN] Mongo plan_runs connect failed: " + (err instanceof Error ? err.message : err));
      await client.close().catch(() => {});
      return null;
    }
  }

  async create(run: PlanRunRecord): Promise<void> {
    await this.runs.insertOne({ ...run });
  }

  async get(runId: string): Promise<PlanRunRecord | undefined> {
    const doc = await this.runs.findOne({ runId });
    return doc ?? undefined;
  }

  async getLatestBySession(chatSessionId: string): Promise<PlanRunRecord | undefined> {
    const doc = await this.runs.find({ chatSessionId }).sort({ updatedAt: -1 }).limit(1).next();
    return doc ?? undefined;
  }

  async listByUid(uid: string, limit?: number, chatSessionId?: string, projectId?: string): Promise<PlanRunRecord[]> {
    const filter: Record<string, string> = { uid };
    if (chatSessionId !== undefined) filter.chatSessionId = chatSessionId;
    if (projectId !== undefined) filter.projectId = projectId;
    return this.runs
      .find(filter)
      .sort({ updatedAt: -1 })
      .limit(planRunListLimit(limit))
      .toArray();
  }

  async save(run: PlanRunRecord): Promise<void> {
    const current = await this.runs.findOne({ runId: run.runId });
    if (current && current.version >= run.version) {
      throw new Error("plan run version conflict: " + run.runId);
    }
    // Version was read immediately before this write; only the run owner
    // (one PlanRunner per run) writes, so a plain replace is sufficient here.
    await this.runs.updateOne({ runId: run.runId }, { $set: run }, { upsert: true });
  }
}
