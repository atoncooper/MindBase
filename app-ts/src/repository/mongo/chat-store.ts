import { MongoClient, type Db, type Collection } from "mongodb";
import { randomUUID } from "node:crypto";
import { config } from "../../config/index.js";
import { createLogger } from "../../logger.js";
import type {
  ChatMessage,
  ChatSession,
  ChatSessionRepository,
  ConversationSummary,
  MessageRepository,
  StoredChatImage,
} from "../persistence.js";
import type { Source } from "../../context/types.js";

const log = createLogger("MONGO");

interface SessionDoc {
  _id: string;
  uid?: string;
  title?: string;
  summary?: string;
  summarizedCount?: number;
  summaryUpdatedAt?: number;
  createdAt: number;
  updatedAt: number;
  lastMessageAt?: number;
}

interface MessageDoc {
  _id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  images?: string[];
  /** durable attachments (MinIO chat-images/*); display signs these, context hydrates these */
  imageRefs?: StoredChatImage[];
  /** Chunks during streaming (joined into content and cleared at finalize); recoverable after a crash */
  chunks?: string[];
  sources?: Source[];
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  error?: string;
  status: "pending" | "done" | "failed";
  createdAt: number;
}

function toSession(doc: SessionDoc): ChatSession {
  return {
    id: doc._id,
    uid: doc.uid,
    title: doc.title,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    lastMessageAt: doc.lastMessageAt,
  };
}

function toMessage(doc: MessageDoc): ChatMessage {
  return {
    id: doc._id,
    sessionId: doc.sessionId,
    role: doc.role,
    content: doc.content,
    sources: doc.sources,
    usage: doc.usage,
    error: doc.error,
    images: doc.images,
    imageRefs: doc.imageRefs,
    status: doc.status,
    createdAt: doc.createdAt,
  };
}

/**
 * MongoDB implementation of chat history (database mind_base_ts, isolated from Python/Go backend data).
 * Implements both ChatSessionRepository and MessageRepository.
 *
 * Streaming write strategy: appendChunk only $pushes small chunks into the chunks array (one atomic small write per delta,
 * avoiding the O(n²) of repeatedly rewriting the whole content string and content loss on crash); finalizeTurn joins into content.
 */
export class MongoChatStore implements ChatSessionRepository, MessageRepository {
  private constructor(
    private readonly client: MongoClient,
    private readonly db: Db,
    private readonly sessions: Collection<SessionDoc>,
    private readonly messages: Collection<MessageDoc>,
  ) {}

  /** Connect + create indexes; returns null on failure (the caller falls back to the in-memory implementation). */
  static async connect(): Promise<MongoChatStore | null> {
    const { uri, database, timeoutMs } = config.mongo;
    if (!uri) return null;
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: timeoutMs,
      connectTimeoutMS: timeoutMs,
    });
    try {
      await client.connect();
      await client.db("admin").command({ ping: 1 });
      const db = client.db(database);
      const store = new MongoChatStore(
        client,
        db,
        db.collection<SessionDoc>(config.mongo.sessionsCollection),
        db.collection<MessageDoc>(config.mongo.messagesCollection),
      );
      await store.ensureIndexes();
      return store;
    } catch (err) {
      log.warn(`[MONGO] connect failed, chat persistence falls back to memory: ${err instanceof Error ? err.message : err}`);
      await client.close().catch(() => undefined);
      return null;
    }
  }

  private async ensureIndexes(): Promise<void> {
    await this.sessions.createIndex({ uid: 1, updatedAt: -1 });
    await this.messages.createIndex({ sessionId: 1, createdAt: 1 });
    await this.messages.createIndex({ status: 1, createdAt: 1 }, { sparse: true });
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  // ---------- ChatSessionRepository ----------

  async getOrCreate(sessionId: string, uid?: string): Promise<ChatSession> {
    const now = Date.now();
    const doc = await this.sessions.findOneAndUpdate(
      { _id: sessionId },
      { $set: { updatedAt: now }, $setOnInsert: { _id: sessionId, uid, createdAt: now } },
      { upsert: true, returnDocument: "after" },
    );
    return toSession(doc as SessionDoc);
  }

  async touch(sessionId: string): Promise<void> {
    const now = Date.now();
    await this.sessions.updateOne({ _id: sessionId }, { $set: { updatedAt: now, lastMessageAt: now } });
  }

  async rename(sessionId: string, title: string): Promise<void> {
    await this.sessions.updateOne({ _id: sessionId }, { $set: { title, updatedAt: Date.now() } });
  }

  /** Recent user message texts across the user's sessions (blindspot probed-name signal). */
  async recentUserTexts(uid: string, limit: number): Promise<string[]> {
    const sessions = await this.sessions
      .find({ uid }, { sort: { updatedAt: -1 }, limit: 20, projection: { _id: 1 } })
      .toArray();
    if (sessions.length === 0) return [];
    const docs = await this.messages
      .find(
        { sessionId: { $in: sessions.map((s) => s._id) }, role: "user" },
        { sort: { createdAt: -1 }, limit, projection: { content: 1 } },
      )
      .toArray();
    return docs.map((d) => d.content).filter((c): c is string => typeof c === "string" && c.length > 0);
  }

  async list(uid?: string): Promise<ChatSession[]> {
    const filter = uid !== undefined ? { uid } : {};
    const docs = await this.sessions
      .find(filter, { sort: { updatedAt: -1 }, limit: 100 })
      .toArray();
    return docs.map(toSession);
  }

  async get(sessionId: string, uid?: string): Promise<ChatSession | undefined> {
    const doc = await this.sessions.findOne({ _id: sessionId });
    if (!doc) return undefined;
    if (uid !== undefined && doc.uid !== uid) return undefined;
    return toSession(doc);
  }

  async delete(sessionId: string, uid?: string): Promise<boolean> {
    const filter: Record<string, unknown> = { _id: sessionId };
    if (uid !== undefined) filter.uid = uid;
    const res = await this.sessions.deleteOne(filter);
    return res.deletedCount > 0;
  }

  // ---------- MessageRepository ----------

  async beginTurn(
    sessionId: string,
    userMessage: string,
    images?: string[],
    imageRefs?: StoredChatImage[],
  ): Promise<{ userMsg: ChatMessage; assistantMsg: ChatMessage }> {
    const now = Date.now();
    const userDoc: MessageDoc = {
      _id: randomUUID(),
      sessionId,
      role: "user",
      content: userMessage,
      // durable refs win: the doc keeps only keys, data URLs are never persisted
      ...(imageRefs?.length ? { imageRefs } : {}),
      ...(images?.length ? { images } : {}),
      status: "done",
      createdAt: now,
    };
    const assistantDoc: MessageDoc = {
      _id: randomUUID(),
      sessionId,
      role: "assistant",
      content: "",
      chunks: [],
      status: "pending",
      createdAt: now,
    };
    // Batch-write the two messages of the same turn
    await this.messages.insertMany([userDoc, assistantDoc]);
    await this.touch(sessionId);
    return { userMsg: toMessage(userDoc), assistantMsg: toMessage(assistantDoc) };
  }

  async appendChunk(assistantMsgId: string, delta: string): Promise<void> {
    if (!delta) return;
    await this.messages.updateOne(
      { _id: assistantMsgId },
      { $push: { chunks: delta }, $set: { updatedAt: Date.now() } },
    );
  }

  async resetContent(assistantMsgId: string): Promise<void> {
    await this.messages.updateOne(
      { _id: assistantMsgId },
      { $set: { content: "" }, $unset: { chunks: "" } },
    );
  }

  async finalizeTurn(
    assistantMsgId: string,
    patch: {
      sources?: Source[];
      usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
      status: "done" | "failed";
      error?: string;
    },
  ): Promise<void> {
    const doc = await this.messages.findOne({ _id: assistantMsgId });
    if (!doc) return;
    const fullContent = (doc.chunks ?? []).join("") || doc.content;
    await this.messages.updateOne(
      { _id: assistantMsgId },
      {
        $set: {
          content: fullContent,
          status: patch.status,
          ...(patch.sources ? { sources: patch.sources } : {}),
          ...(patch.usage ? { usage: patch.usage } : {}),
          ...(patch.error ? { error: patch.error } : {}),
        },
        $unset: { chunks: "" },
      },
    );
  }

  async getSummary(sessionId: string): Promise<ConversationSummary | undefined> {
    const doc = await this.sessions.findOne({ _id: sessionId });
    if (!doc?.summary) return undefined;
    return {
      summary: doc.summary,
      summarizedCount: doc.summarizedCount ?? 0,
      updatedAt: doc.summaryUpdatedAt ?? 0,
    };
  }

  async saveSummary(sessionId: string, summary: ConversationSummary): Promise<void> {
    await this.sessions.updateOne(
      { _id: sessionId },
      {
        $set: {
          summary: summary.summary,
          summarizedCount: summary.summarizedCount,
          summaryUpdatedAt: summary.updatedAt,
        },
      },
    );
  }

  async countDone(sessionId: string): Promise<number> {
    return this.messages.countDocuments({ sessionId, status: "done" });
  }

  async listDone(sessionId: string, skip: number, limit: number): Promise<ChatMessage[]> {
    const docs = await this.messages
      .find({ sessionId, status: "done" }, { sort: { createdAt: 1 }, skip, limit })
      .toArray();
    return docs.map(toMessage);
  }

  async recentMessages(sessionId: string, limit: number): Promise<ChatMessage[]> {
    // Fetching the last N: read in reverse order, return in order
    const docs = await this.messages
      .find({ sessionId, status: "done" }, { sort: { createdAt: -1 }, limit })
      .toArray();
    return docs.reverse().map(toMessage);
  }

  async getMessage(messageId: string): Promise<ChatMessage | undefined> {
    const doc = await this.messages.findOne({ _id: messageId });
    return doc ? toMessage(doc) : undefined;
  }

  async listBySession(sessionId: string): Promise<ChatMessage[]> {
    const docs = await this.messages
      .find({ sessionId }, { sort: { createdAt: 1 } })
      .toArray();
    return docs.map(toMessage);
  }

  async countBySession(sessionId: string): Promise<number> {
    return this.messages.countDocuments({ sessionId });
  }

  async deleteBySession(sessionId: string): Promise<number> {
    const res = await this.messages.deleteMany({ sessionId });
    return res.deletedCount;
  }

  async truncateFrom(sessionId: string, anchorMsgId: string): Promise<number | undefined> {
    const anchor = await this.messages.findOne({ _id: anchorMsgId, sessionId });
    if (!anchor) return undefined;
    const res = await this.messages.deleteMany({ sessionId, createdAt: { $gte: anchor.createdAt } });
    return res.deletedCount;
  }

  /** Ops helper: clean up orphaned pending messages (placeholders from cut-off streams, useless after the timeout) */
  async purgeStalePending(olderThanMs: number): Promise<number> {
    const res = await this.messages.deleteMany({
      status: "pending",
      createdAt: { $lt: Date.now() - olderThanMs },
    });
    if (res.deletedCount > 0) {
      log.info(`[MONGO] purged stale pending messages count=${res.deletedCount}`);
    }
    return res.deletedCount;
  }
}
