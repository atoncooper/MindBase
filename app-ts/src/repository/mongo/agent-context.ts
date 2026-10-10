import { MongoClient, type Db, type Collection } from "mongodb";
import { config } from "../../config/index.js";
import { createLogger } from "../../logger.js";
import type {
  AgentContextEntry,
  AgentContextRepository,
  AgentContextSummary,
} from "../agent-context.js";

const log = createLogger("MONGO");

interface AgentContextDoc {
  _id: string; // `${sessionId}:${agentName}`
  sessionId: string;
  agentName: string;
  entries: AgentContextEntry[];
  summary?: string;
  summarizedCount?: number;
  summaryUpdatedAt?: number;
}

/** MongoDB implementation (collection agent_contexts, db mind_base_ts). */
export class MongoAgentContextStore implements AgentContextRepository {
  private constructor(
    private readonly client: MongoClient,
    private readonly collection: Collection<AgentContextDoc>,
  ) {}

  static async connect(): Promise<MongoAgentContextStore | null> {
    const { uri, database, timeoutMs } = config.mongo;
    if (!uri) return null;
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: timeoutMs,
      connectTimeoutMS: timeoutMs,
    });
    try {
      await client.connect();
      await client.db("admin").command({ ping: 1 });
      const collection = client.db(database).collection<AgentContextDoc>("agent_contexts");
      await collection.createIndex({ sessionId: 1, agentName: 1 });
      return new MongoAgentContextStore(client, collection);
    } catch (err) {
      log.warn(`[MONGO] agent_contexts connect failed: ${err instanceof Error ? err.message : err}`);
      await client.close().catch(() => undefined);
      return null;
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  private async load(sessionId: string, agentName: string): Promise<AgentContextDoc> {
    const id = `${sessionId}:${agentName}`;
    let doc = await this.collection.findOne({ _id: id });
    if (!doc) {
      doc = { _id: id, sessionId, agentName, entries: [] };
      await this.collection.insertOne(doc).catch(() => undefined);
    }
    return doc;
  }

  /** read-only variant: never creates the doc (clear() must not count read-created empties) */
  private async peek(sessionId: string, agentName: string): Promise<AgentContextDoc | null> {
    return this.collection.findOne({ _id: `${sessionId}:${agentName}` });
  }

  async append(sessionId: string, agentName: string, entry: AgentContextEntry): Promise<void> {
    await this.load(sessionId, agentName);
    await this.collection.updateOne(
      { _id: `${sessionId}:${agentName}` },
      { $push: { entries: entry } },
    );
  }

  async recent(sessionId: string, agentName: string, limit: number): Promise<AgentContextEntry[]> {
    const doc = await this.peek(sessionId, agentName);
    return (doc?.entries ?? []).slice(-limit);
  }

  async countEntries(sessionId: string, agentName: string): Promise<number> {
    const doc = await this.peek(sessionId, agentName);
    return doc?.entries.length ?? 0;
  }

  async listEntries(sessionId: string, agentName: string, skip: number, limit: number): Promise<AgentContextEntry[]> {
    const doc = await this.peek(sessionId, agentName);
    return (doc?.entries ?? []).slice(skip, skip + limit);
  }

  async getSummary(sessionId: string, agentName: string): Promise<AgentContextSummary | undefined> {
    const doc = await this.peek(sessionId, agentName);
    if (!doc?.summary) return undefined;
    return {
      summary: doc.summary,
      summarizedCount: doc.summarizedCount ?? 0,
      updatedAt: doc.summaryUpdatedAt ?? 0,
    };
  }

  async saveSummary(sessionId: string, agentName: string, summary: AgentContextSummary): Promise<void> {
    await this.load(sessionId, agentName);
    await this.collection.updateOne(
      { _id: `${sessionId}:${agentName}` },
      {
        $set: {
          summary: summary.summary,
          summarizedCount: summary.summarizedCount,
          summaryUpdatedAt: summary.updatedAt,
        },
      },
    );
  }

  async trim(sessionId: string, agentName: string, keepLast: number): Promise<void> {
    const doc = await this.load(sessionId, agentName);
    const entries = (doc.entries ?? []).slice(-keepLast);
    await this.collection.updateOne({ _id: `${sessionId}:${agentName}` }, { $set: { entries } });
  }

  async clear(sessionId: string, agentName?: string): Promise<number> {
    const filter = agentName ? { sessionId, agentName } : { sessionId };
    const res = await this.collection.deleteMany(filter);
    return res.deletedCount;
  }
}
