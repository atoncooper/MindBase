import { MongoClient, type Collection } from "mongodb";
import { randomUUID } from "node:crypto";
import { config } from "../../config/index.js";
import { createLogger } from "../../logger.js";
import { scoreMemoryText, type MemoryEntry, type MemoryRepository } from "../memory-store.js";

const log = createLogger("MONGO");

/** Own database (mind_base_ts) — same collection name as the retired Python memory store. */
const COLLECTION = "memory_entries";

/**
 * Retrieval scans the uid's most recent N entries and scores them in the
 * application layer with the shared scorer (scoreMemoryText) instead of a Mongo
 * text index: relevance semantics stay identical to MemoryMemoryStore, and CJK
 * 2-gram matching works without a language-specific index. The bounded scan keeps
 * one turn's lookup O(scan) rather than O(all memories).
 */
const SEARCH_SCAN_LIMIT = 500;

interface MemoryDoc {
  _id: string;
  uid: string;
  content: string;
  tags?: string[];
  createdAt: number;
}

function toEntry(doc: MemoryDoc): MemoryEntry {
  return {
    id: doc._id,
    uid: doc.uid,
    content: doc.content,
    tags: doc.tags ?? [],
    createdAt: doc.createdAt,
  };
}

/**
 * MongoDB implementation of long-term memory (durable across restarts).
 * Contract + scoring are unchanged from the memory implementation; connect()
 * returns null on failure so the composition root falls back to memory.
 */
export class MongoMemoryStore implements MemoryRepository {
  private constructor(
    private readonly client: MongoClient,
    private readonly coll: Collection<MemoryDoc>,
  ) {}

  static async connect(): Promise<MongoMemoryStore | null> {
    const { uri, database, timeoutMs } = config.mongo;
    if (!uri) return null;
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: timeoutMs,
      connectTimeoutMS: timeoutMs,
    });
    try {
      await client.connect();
      await client.db("admin").command({ ping: 1 });
      const coll = client.db(database).collection<MemoryDoc>(COLLECTION);
      await coll.createIndex({ uid: 1, createdAt: -1 });
      return new MongoMemoryStore(client, coll);
    } catch (err) {
      log.warn(
        "[MONGO] memory store connect failed, memory fallback: " +
          (err instanceof Error ? err.message : String(err)),
      );
      await client.close().catch(() => undefined);
      return null;
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async add(uid: string, content: string, tags: string[] = []): Promise<MemoryEntry> {
    const entry: MemoryEntry = {
      id: randomUUID(),
      uid,
      content: content.trim(),
      tags,
      createdAt: Date.now(),
    };
    await this.coll.insertOne({
      _id: entry.id,
      uid: entry.uid,
      content: entry.content,
      tags: entry.tags,
      createdAt: entry.createdAt,
    });
    return entry;
  }

  async search(uid: string, query: string, limit = 5): Promise<MemoryEntry[]> {
    const docs = await this.coll
      .find({ uid }, { sort: { createdAt: -1 }, limit: SEARCH_SCAN_LIMIT })
      .toArray();
    const scored = docs
      .map((doc) => ({
        entry: toEntry(doc),
        score: scoreMemoryText(`${doc.content} ${(doc.tags ?? []).join(" ")}`, query),
      }))
      .filter((x) => x.score > 0);
    // tie-break oldest-first so equal-score ordering matches the memory implementation
    scored.sort((a, b) => b.score - a.score || a.entry.createdAt - b.entry.createdAt);
    return scored.slice(0, limit).map((x) => x.entry);
  }

  async list(uid: string, limit = 20): Promise<MemoryEntry[]> {
    const docs = await this.coll.find({ uid }, { sort: { createdAt: -1 }, limit }).toArray();
    return docs.map(toEntry);
  }
}
