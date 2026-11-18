import { MongoClient, type Collection, type Db } from "mongodb";
import { config } from "../../config/index.js";
import { createLogger } from "../../logger.js";
import type { ResearchApproval, ResearchApprovalRepository } from "../research-approvals.js";

const log = createLogger("MONGO");

/**
 * MongoDB `mind_base_ts.research_approvals` adapter. Approval v2 fields are
 * optional and written only when present (`$set` of the whole small row), so
 * pre-v2 documents keep reading as legacy rows: no expiresAt = never expires,
 * no consumedAt = not consumed, no scope = project-level approval.
 */
export class MongoResearchApprovalRepository implements ResearchApprovalRepository {
  private constructor(
    private readonly client: MongoClient,
    private readonly db: Db,
    private readonly items: Collection<ResearchApproval>,
  ) {}

  static async connect(): Promise<MongoResearchApprovalRepository | null> {
    const { uri, database, timeoutMs } = config.mongo;
    if (!uri) return null;
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: timeoutMs, connectTimeoutMS: timeoutMs });
    try {
      await client.connect();
      const db = client.db(database);
      const items = db.collection<ResearchApproval>("research_approvals");
      await items.createIndex({ id: 1 }, { unique: true });
      await items.createIndex({ uid: 1, projectId: 1, requestedAt: -1 });
      await items.createIndex({ status: 1, requestedAt: 1 });
      // Approval v2 lookups: newest active decision per project/kind plus the
      // scope/consumption checks run by ResearchApprovalService.
      await items.createIndex({ uid: 1, projectId: 1, kind: 1, status: 1, requestedAt: -1 });
      await items.createIndex({ status: 1, expiresAt: 1 });
      return new MongoResearchApprovalRepository(client, db, items);
    } catch (err) {
      log.warn("[APPROVAL] Mongo research_approvals connect failed: " + (err instanceof Error ? err.message : err));
      await client.close().catch(() => {});
      return null;
    }
  }

  async create(approval: ResearchApproval): Promise<void> {
    await this.items.insertOne({ ...approval });
  }

  async get(id: string): Promise<ResearchApproval | undefined> {
    return (await this.items.findOne({ id })) ?? undefined;
  }

  async listByProject(uid: string, projectId: string): Promise<ResearchApproval[]> {
    return this.items.find({ uid, projectId }).sort({ requestedAt: -1 }).toArray();
  }

  async save(approval: ResearchApproval): Promise<void> {
    await this.items.updateOne({ id: approval.id }, { $set: approval }, { upsert: true });
  }

  async removeByProject(uid: string, projectId: string): Promise<number> {
    const result = await this.items.deleteMany({ uid, projectId });
    return result.deletedCount;
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
