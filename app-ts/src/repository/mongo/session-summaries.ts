import { MongoClient, type Collection } from "mongodb";
import { randomUUID } from "node:crypto";
import { config } from "../../config/index.js";
import { createLogger } from "../../logger.js";
import type {
  SessionSummaryDoc,
  SessionSummaryInsert,
  SessionSummaryRepository,
} from "../session-summaries.js";

const log = createLogger("MONGO");

/** Collection name kept identical to Python's (different database mind_base_ts). */
const COLLECTION = "session_summaries";

interface SummaryDoc {
  _id: string;
  chatSessionId: string;
  uid: string;
  content: string;
  messageCount: number;
  firstMessageAt: number | null;
  lastMessageAt: number | null;
  createdAt: number;
}

function toDoc(d: SummaryDoc): SessionSummaryDoc {
  return {
    summaryId: d._id,
    chatSessionId: d.chatSessionId,
    uid: d.uid,
    content: d.content,
    messageCount: d.messageCount,
    firstMessageAt: d.firstMessageAt,
    lastMessageAt: d.lastMessageAt,
    createdAt: d.createdAt,
  };
}

/** MongoDB implementation (returns null on connect failure → memory fallback). */
export class MongoSessionSummaryStore implements SessionSummaryRepository {
  private constructor(
    private readonly client: MongoClient,
    private readonly coll: Collection<SummaryDoc>,
  ) {}

  static async connect(): Promise<MongoSessionSummaryStore | null> {
    const { uri, database, timeoutMs } = config.mongo;
    if (!uri) return null;
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: timeoutMs,
      connectTimeoutMS: timeoutMs,
    });
    try {
      await client.connect();
      await client.db("admin").command({ ping: 1 });
      const coll = client.db(database).collection<SummaryDoc>(COLLECTION);
      await coll.createIndex({ chatSessionId: 1, uid: 1, createdAt: -1 });
      return new MongoSessionSummaryStore(client, coll);
    } catch (err) {
      log.warn(
        "[MONGO] session-summaries connect failed, memory fallback: " +
          (err instanceof Error ? err.message : String(err)),
      );
      await client.close().catch(() => undefined);
      return null;
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async insert(input: SessionSummaryInsert): Promise<SessionSummaryDoc> {
    const doc: SummaryDoc = { _id: randomUUID(), createdAt: Date.now(), ...input };
    await this.coll.insertOne(doc);
    log.info(
      "[MONGO_SUMMARY] inserted summary_id=" + doc._id +
        " session=" + input.chatSessionId.slice(0, 8) + " messages=" + input.messageCount,
    );
    return toDoc(doc);
  }

  async latest(chatSessionId: string, uid: string): Promise<SessionSummaryDoc | undefined> {
    const doc = await this.coll.findOne({ chatSessionId, uid }, { sort: { createdAt: -1 } });
    return doc ? toDoc(doc) : undefined;
  }
}
