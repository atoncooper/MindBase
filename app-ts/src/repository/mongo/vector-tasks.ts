import { MongoClient, type Collection, type Db } from "mongodb";
import { config } from "../../config/index.js";
import { createLogger } from "../../logger.js";
import {
  type VecPageRecord,
  type VecTaskRecord,
  type VecTaskStep,
  type VectorTaskRepository,
} from "../vector-tasks.js";

const log = createLogger("VEC_TASKS");

/**
 * Mongo-backed vectorization bookkeeping (database mind_base_ts):
 *  - collection `vec_pages` — per-page vector state, keyed `${bvid}:${cid}`
 *  - collection `vec_tasks` — pipeline task records, keyed by task id
 * Mongo unreachable at connect → null (caller falls back to memory).
 */

interface VecPageDoc extends VecPageRecord {
  _id: string;
}

interface VecTaskDoc {
  _id: string;
  uid: string;
  bvid: string;
  cid: number;
  page_index: number;
  page_title: string;
  status: VecTaskRecord["status"];
  progress: number;
  steps: VecTaskStep[];
  result?: Record<string, unknown>;
  error?: string;
  created_at: number;
  updated_at: number;
}

function toPage(doc: VecPageDoc): VecPageRecord {
  const { _id, ...rest } = doc;
  return rest;
}

function toTask(doc: VecTaskDoc): VecTaskRecord {
  return {
    taskId: doc._id,
    uid: doc.uid,
    bvid: doc.bvid,
    cid: doc.cid,
    pageIndex: doc.page_index,
    pageTitle: doc.page_title,
    status: doc.status,
    progress: doc.progress,
    steps: doc.steps ?? [],
    result: doc.result,
    error: doc.error,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

export class MongoVectorTaskStore implements VectorTaskRepository {
  private constructor(
    private readonly client: MongoClient,
    private readonly pagesCol: Collection<VecPageDoc>,
    private readonly tasksCol: Collection<VecTaskDoc>,
  ) {}

  static async connect(): Promise<MongoVectorTaskStore | null> {
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
      const store = new MongoVectorTaskStore(
        client,
        db.collection<VecPageDoc>("vec_pages"),
        db.collection<VecTaskDoc>("vec_tasks"),
      );
      await store.ensureIndexes();
      return store;
    } catch (err) {
      log.warn(`[MONGO] connect failed, vector bookkeeping falls back to memory: ${err instanceof Error ? err.message : err}`);
      await client.close().catch(() => undefined);
      return null;
    }
  }

  private async ensureIndexes(): Promise<void> {
    await this.pagesCol.createIndex({ bvid: 1, cid: 1 }, { unique: true });
    await this.pagesCol.createIndex({ status: 1 });
    await this.tasksCol.createIndex({ uid: 1, updated_at: -1 });
  }

  async upsertPage(record: VecPageRecord): Promise<void> {
    const doc: VecPageDoc = { ...record, _id: `${record.bvid}:${record.cid}` };
    await this.pagesCol.replaceOne({ _id: doc._id }, doc, { upsert: true });
  }

  async getPage(bvid: string, cid: number): Promise<VecPageRecord | undefined> {
    const doc = await this.pagesCol.findOne({ _id: `${bvid}:${cid}` });
    return doc ? toPage(doc) : undefined;
  }

  async listPagesByBvid(bvid: string): Promise<VecPageRecord[]> {
    const docs = await this.pagesCol.find({ bvid }).sort({ page_index: 1 }).toArray();
    return docs.map(toPage);
  }

  async listAllPages(): Promise<VecPageRecord[]> {
    const docs = await this.pagesCol.find({}).toArray();
    return docs.map(toPage);
  }

  async deletePagesByBvid(bvid: string): Promise<void> {
    await this.pagesCol.deleteMany({ bvid });
  }

  async deleteAllPages(): Promise<void> {
    await this.pagesCol.deleteMany({});
  }

  async saveTask(record: VecTaskRecord): Promise<void> {
    const doc: VecTaskDoc = {
      _id: record.taskId,
      uid: record.uid,
      bvid: record.bvid,
      cid: record.cid,
      page_index: record.pageIndex,
      page_title: record.pageTitle,
      status: record.status,
      progress: record.progress,
      steps: record.steps.slice(-50),
      ...(record.result ? { result: record.result } : {}),
      ...(record.error ? { error: record.error } : {}),
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    };
    await this.tasksCol.replaceOne({ _id: doc._id }, doc, { upsert: true });
  }

  async getTask(taskId: string): Promise<VecTaskRecord | undefined> {
    const doc = await this.tasksCol.findOne({ _id: taskId });
    return doc ? toTask(doc) : undefined;
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => undefined);
  }
}
