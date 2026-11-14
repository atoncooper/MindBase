import { MongoClient, type Collection, type Db } from "mongodb";
import { config } from "../../config/index.js";
import { createLogger } from "../../logger.js";
import type { ResearchExperiment, ResearchExperimentRepository } from "../research-experiments.js";

const log = createLogger("MONGO");

/** MongoDB research experiment store (mind_base_ts.research_experiments). */
export class MongoResearchExperimentRepository implements ResearchExperimentRepository {
  private constructor(
    private readonly client: MongoClient,
    private readonly db: Db,
    private readonly runs: Collection<ResearchExperiment>,
  ) {}

  static async connect(): Promise<MongoResearchExperimentRepository | null> {
    const { uri, database, timeoutMs } = config.mongo;
    if (!uri) return null;
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: timeoutMs,
      connectTimeoutMS: timeoutMs,
    });
    try {
      await client.connect();
      const db = client.db(database);
      const runs = db.collection<ResearchExperiment>("research_experiments");
      await runs.createIndex({ id: 1 }, { unique: true });
      await runs.createIndex({ uid: 1, projectId: 1, createdAt: -1 });
      await runs.createIndex({ status: 1, createdAt: 1 });
      return new MongoResearchExperimentRepository(client, db, runs);
    } catch (err) {
      log.warn("[EXPERIMENT] Mongo research_experiments connect failed: " + (err instanceof Error ? err.message : err));
      await client.close().catch(() => {});
      return null;
    }
  }

  async create(exp: ResearchExperiment): Promise<void> {
    await this.runs.insertOne({ ...exp });
  }

  async get(id: string): Promise<ResearchExperiment | undefined> {
    return (await this.runs.findOne({ id })) ?? undefined;
  }

  async listByUid(uid: string, projectId?: string, limit = 20): Promise<ResearchExperiment[]> {
    return this.runs
      .find(projectId ? { uid, projectId } : { uid })
      .sort({ createdAt: -1 })
      .limit(Math.min(Math.max(limit, 1), 100))
      .toArray();
  }

  async listUnfinished(): Promise<ResearchExperiment[]> {
    return this.runs.find({ status: { $in: ["queued", "running"] } }).toArray();
  }

  async save(exp: ResearchExperiment): Promise<void> {
    await this.runs.updateOne({ id: exp.id }, { $set: exp }, { upsert: true });
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
