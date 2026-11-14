import { MongoClient, type Collection, type Db } from "mongodb";
import { config } from "../../config/index.js";
import { createLogger } from "../../logger.js";
import type { ResearchWorkspace, ResearchWorkspaceRepository } from "../research-workspaces.js";

const log = createLogger("MONGO");

/** MongoDB workspace store (mind_base_ts.research_workspaces). */
export class MongoResearchWorkspaceRepository implements ResearchWorkspaceRepository {
  private constructor(
    private readonly client: MongoClient,
    private readonly db: Db,
    private readonly workspaces: Collection<ResearchWorkspace>,
  ) {}

  static async connect(): Promise<MongoResearchWorkspaceRepository | null> {
    const { uri, database, timeoutMs } = config.mongo;
    if (!uri) return null;
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: timeoutMs,
      connectTimeoutMS: timeoutMs,
    });
    try {
      await client.connect();
      const db = client.db(database);
      const workspaces = db.collection<ResearchWorkspace>("research_workspaces");
      await workspaces.createIndex({ workspaceId: 1 }, { unique: true });
      await workspaces.createIndex({ uid: 1, updatedAt: -1 });
      await workspaces.createIndex({ uid: 1, "projects.projectId": 1 });
      return new MongoResearchWorkspaceRepository(client, db, workspaces);
    } catch (err) {
      log.warn("[WORKSPACE] Mongo research_workspaces connect failed: " + (err instanceof Error ? err.message : err));
      await client.close().catch(() => {});
      return null;
    }
  }

  async create(workspace: ResearchWorkspace): Promise<void> {
    await this.workspaces.insertOne({ ...workspace });
  }

  async get(workspaceId: string): Promise<ResearchWorkspace | undefined> {
    return (await this.workspaces.findOne({ workspaceId })) ?? undefined;
  }

  async getByProject(uid: string, projectId: string): Promise<ResearchWorkspace | undefined> {
    return (await this.workspaces.findOne({ uid, "projects.projectId": projectId })) ?? undefined;
  }

  async listByUid(uid: string): Promise<ResearchWorkspace[]> {
    return this.workspaces.find({ uid }).sort({ updatedAt: -1 }).toArray();
  }

  async listAll(): Promise<ResearchWorkspace[]> {
    return this.workspaces.find({}).toArray();
  }

  async save(workspace: ResearchWorkspace): Promise<void> {
    await this.workspaces.updateOne({ workspaceId: workspace.workspaceId }, { $set: workspace }, { upsert: true });
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
