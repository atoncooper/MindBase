import { MongoClient, type Collection, type Db } from "mongodb";
import { config } from "../../config/index.js";
import { createLogger } from "../../logger.js";
import type { KgBuildRecord } from "../../kg/types.js";
import type { KgBuildRepository } from "../kg-builds.js";

const log = createLogger("KG_BUILDS");

/**
 * Mongo adapter (database mind_base_ts, collection kg_builds) — see
 * ../kg-builds.ts for the contract and the storage story:
 * app-ts's OWN task store, deliberately NOT the Python async_tasks table
 * (the MySQL task rows belong to the Python stack's vec/kg bookkeeping;
 * the /knowledge/kg/status contract is served from here once app-ts owns
 * the routes). Records are uid-scoped; status is the single-active guard.
 */

interface KgBuildDoc {
  _id: string;
  uid: string;
  folder_ids: number[];
  bvid_count: number;
  status: "processing" | "done" | "failed";
  progress: number;
  current_step: string;
  steps: { name: string; status: string; progress: number; at: number }[];
  result?: KgBuildRecord["result"];
  error?: string;
  created_at: number;
  updated_at: number;
}

function toRecord(doc: KgBuildDoc): KgBuildRecord {
  return {
    taskId: doc._id,
    uid: doc.uid,
    folderIds: doc.folder_ids,
    bvidCount: doc.bvid_count,
    status: doc.status,
    progress: doc.progress,
    currentStep: doc.current_step,
    steps: doc.steps,
    result: doc.result,
    error: doc.error,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

export class MongoKgBuildStore implements KgBuildRepository {
  private constructor(
    private readonly client: MongoClient,
    private readonly col: Collection<KgBuildDoc>,
  ) {}

  static async connect(): Promise<MongoKgBuildStore | null> {
    const { uri, database, timeoutMs } = config.mongo;
    if (!uri) return null;
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: timeoutMs,
      connectTimeoutMS: timeoutMs,
    });
    try {
      await client.connect();
      await client.db("admin").command({ ping: 1 });
      const db = client.db(database) as Db;
      const store = new MongoKgBuildStore(client, db.collection<KgBuildDoc>("kg_builds"));
      await store.ensureIndexes();
      return store;
    } catch (err) {
      log.warn(`[MONGO] connect failed, kg build records fall back to memory: ${err instanceof Error ? err.message : err}`);
      await client.close().catch(() => undefined);
      return null;
    }
  }

  private async ensureIndexes(): Promise<void> {
    await this.col.createIndex({ uid: 1, status: 1 });
    await this.col.createIndex({ uid: 1, updated_at: -1 });
  }

  async save(record: KgBuildRecord): Promise<void> {
    const doc: KgBuildDoc = {
      _id: record.taskId,
      uid: record.uid,
      folder_ids: record.folderIds,
      bvid_count: record.bvidCount,
      status: record.status,
      progress: record.progress,
      current_step: record.currentStep,
      steps: record.steps.slice(-50),
      ...(record.result ? { result: record.result } : {}),
      ...(record.error ? { error: record.error } : {}),
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    };
    await this.col.replaceOne({ _id: record.taskId }, doc, { upsert: true });
  }

  async get(taskId: string, uid: string): Promise<KgBuildRecord | undefined> {
    const doc = await this.col.findOne({ _id: taskId, uid });
    return doc ? toRecord(doc) : undefined;
  }

  async findActive(uid: string): Promise<KgBuildRecord | undefined> {
    const doc = await this.col.findOne({ uid, status: "processing" }, { sort: { updated_at: -1 } });
    return doc ? toRecord(doc) : undefined;
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => undefined);
  }
}
