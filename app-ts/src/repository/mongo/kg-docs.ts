import { MongoClient, type Collection, type Db } from "mongodb";
import { config } from "../../config/index.js";
import { createLogger } from "../../logger.js";
import type { KgDocRecord, KgDocStatus } from "../../kg/types.js";
import type { KgDocRepository } from "../kg-docs.js";

const log = createLogger("KG_DOCS");

/**
 * Mongo adapter (database mind_base_ts, collection kg_docs) — see ../kg-docs.ts
 * for the contract. _id = `${uid}:${uploadUuid}` makes (uid, uploadUuid) the
 * natural idempotency key; the uid index backs per-user lookups.
 */

interface KgDocDoc {
  _id: string;
  uid: string;
  upload_uuid: string;
  title: string;
  content_hash: string;
  status: KgDocStatus;
  entity_count?: number;
  relation_count?: number;
  error?: string;
  updated_at: number;
}

function toRecord(doc: KgDocDoc): KgDocRecord {
  return {
    uid: doc.uid,
    uploadUuid: doc.upload_uuid,
    title: doc.title,
    contentHash: doc.content_hash,
    status: doc.status,
    entityCount: doc.entity_count,
    relationCount: doc.relation_count,
    error: doc.error,
    updatedAt: doc.updated_at,
  };
}

export class MongoKgDocStore implements KgDocRepository {
  private constructor(
    private readonly client: MongoClient,
    private readonly col: Collection<KgDocDoc>,
  ) {}

  static async connect(): Promise<MongoKgDocStore | null> {
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
      const store = new MongoKgDocStore(client, db.collection<KgDocDoc>("kg_docs"));
      await store.ensureIndexes();
      return store;
    } catch (err) {
      log.warn(`[MONGO] connect failed, kg doc ledger falls back to memory: ${err instanceof Error ? err.message : err}`);
      await client.close().catch(() => undefined);
      return null;
    }
  }

  private async ensureIndexes(): Promise<void> {
    await this.col.createIndex({ uid: 1 });
  }

  async get(uid: string, uploadUuid: string): Promise<KgDocRecord | undefined> {
    const doc = await this.col.findOne({ _id: `${uid}:${uploadUuid}` });
    return doc ? toRecord(doc) : undefined;
  }

  async save(record: KgDocRecord): Promise<void> {
    const id = `${record.uid}:${record.uploadUuid}`;
    const doc: KgDocDoc = {
      _id: id,
      uid: record.uid,
      upload_uuid: record.uploadUuid,
      title: record.title,
      content_hash: record.contentHash,
      status: record.status,
      ...(record.entityCount !== undefined ? { entity_count: record.entityCount } : {}),
      ...(record.relationCount !== undefined ? { relation_count: record.relationCount } : {}),
      ...(record.error ? { error: record.error } : {}),
      updated_at: record.updatedAt,
    };
    await this.col.replaceOne({ _id: id }, doc, { upsert: true });
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => undefined);
  }
}
