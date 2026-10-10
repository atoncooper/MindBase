import { MongoClient, type Collection, type Db } from "mongodb";
import { config } from "../../config/index.js";
import { createLogger } from "../../logger.js";
import type { SkillMetaRepository, SkillRecord } from "../../skills/manager.js";

const log = createLogger("SKILLS_META");

/**
 * Skill metadata (database mind_base_ts, collection skills_meta) — app-ts's
 * OWN store (storage redesign vs the Python MySQL installed_skills rows; the
 * zip content lives in MinIO under skills/{uid}/{skill_id}.zip). Records are
 * uid-scoped with a (uid, skill_id) unique index.
 */

interface SkillDoc {
  _id: string;
  uid: string;
  skill_id: string;
  name: string;
  description: string | null;
  version: string | null;
  source_store: string | null;
  has_code_tools: boolean;
  enabled: boolean;
  minio_key: string;
  installed_at: number;
  updated_at: number;
}

function toRecord(doc: SkillDoc): SkillRecord {
  return {
    skillId: doc.skill_id,
    name: doc.name,
    description: doc.description,
    version: doc.version,
    sourceStore: doc.source_store,
    hasCodeTools: doc.has_code_tools,
    enabled: doc.enabled,
    minioKey: doc.minio_key,
  };
}

export class MongoSkillMetaStore implements SkillMetaRepository {
  private constructor(
    private readonly client: MongoClient,
    private readonly col: Collection<SkillDoc>,
  ) {}

  static async connect(): Promise<MongoSkillMetaStore | null> {
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
      const store = new MongoSkillMetaStore(client, db.collection<SkillDoc>("skills_meta"));
      await store.col.createIndex({ uid: 1, skill_id: 1 }, { unique: true });
      return store;
    } catch (err) {
      log.warn(`[MONGO] connect failed: ${err instanceof Error ? err.message : err}`);
      await client.close().catch(() => undefined);
      return null;
    }
  }

  async list(uid: string): Promise<SkillRecord[]> {
    const docs = await this.col.find({ uid }).sort({ skill_id: 1 }).toArray();
    return docs.map(toRecord);
  }

  async get(uid: string, skillId: string): Promise<SkillRecord | undefined> {
    const doc = await this.col.findOne({ _id: `${uid}:${skillId}` });
    return doc ? toRecord(doc) : undefined;
  }

  async save(uid: string, record: SkillRecord): Promise<void> {
    const now = Date.now();
    const existing = await this.col.findOne({ _id: `${uid}:${record.skillId}` }, { projection: { installed_at: 1 } });
    const doc: SkillDoc = {
      _id: `${uid}:${record.skillId}`,
      uid,
      skill_id: record.skillId,
      name: record.name,
      description: record.description,
      version: record.version,
      source_store: record.sourceStore,
      has_code_tools: record.hasCodeTools,
      enabled: record.enabled,
      minio_key: record.minioKey,
      installed_at: existing?.installed_at ?? now,
      updated_at: now,
    };
    await this.col.replaceOne({ _id: doc._id }, doc, { upsert: true });
  }

  async remove(uid: string, skillId: string): Promise<boolean> {
    const res = await this.col.deleteOne({ _id: `${uid}:${skillId}` });
    return res.deletedCount > 0;
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => undefined);
  }
}
