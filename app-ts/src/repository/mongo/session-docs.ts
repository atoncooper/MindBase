import { MongoClient, type Db, type Collection, type Document as MongoDoc } from "mongodb";
import { randomUUID } from "node:crypto";
import { config } from "../../config/index.js";
import { createLogger } from "../../logger.js";
import type { EmbeddingsClient } from "../../llm/embeddings.js";
import type { StoredChatImage } from "../persistence.js";
import type {
  SessionDocHit,
  SessionDocumentMeta,
  SessionDocumentRepository,
} from "../session-docs.js";

const log = createLogger("MONGO");

interface SessionDocChunkDoc {
  index: number;
  text: string;
  /** embedding vector (1024-dim), absent when the gateway was offline at upload time */
  vector?: number[];
}

interface SessionDocMetaDoc extends MongoDoc {
  _id: string;
  sessionId: string;
  filename: string;
  sizeBytes: number;
  chunkCount: number;
  chunks: SessionDocChunkDoc[];
  /** 原始文件 MinIO 对象(chat-files/*);空 = 未存 */
  key?: string;
  contentType?: string;
  createdAt: number;
}

/**
 * MongoDB implementation (collection session_documents, db mind_base_ts).
 * Retrieval strategy: embedding cosine similarity (chunks embedded at upload,
 * query embedded at search); on embedding failure falls back to keyword + 2-gram scoring.
 * Strictly scoped by sessionId — cross-session retrieval is impossible by construction.
 */
export class MongoSessionDocumentStore implements SessionDocumentRepository {
  private constructor(
    private readonly client: MongoClient,
    private readonly collection: Collection<SessionDocMetaDoc>,
    private readonly embeddings?: EmbeddingsClient,
  ) {}

  static async connect(embeddings?: EmbeddingsClient): Promise<MongoSessionDocumentStore | null> {
    const { uri, database, timeoutMs } = config.mongo;
    if (!uri) return null;
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: timeoutMs,
      connectTimeoutMS: timeoutMs,
    });
    try {
      await client.connect();
      await client.db("admin").command({ ping: 1 });
      const collection = client.db(database).collection<SessionDocMetaDoc>("session_documents");
      await collection.createIndex({ sessionId: 1, createdAt: 1 });
      log.info(`[MONGO] session_documents ready db=${database}`);
      return new MongoSessionDocumentStore(client, collection, embeddings);
    } catch (err) {
      log.warn(`[MONGO] session_documents connect failed: ${err instanceof Error ? err.message : err}`);
      await client.close().catch(() => undefined);
      return null;
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async save(
    sessionId: string,
    filename: string,
    chunks: string[],
    sizeBytes: number,
    file?: StoredChatImage,
  ): Promise<SessionDocumentMeta> {
    const chunkDocs: SessionDocChunkDoc[] = chunks.map((text, index) => ({ index, text }));
    if (this.embeddings) {
      try {
        const vectors = await this.embeddings.embedDocuments(chunks);
        for (let i = 0; i < vectors.length; i++) chunkDocs[i].vector = vectors[i];
      } catch (err) {
        log.warn(`[MONGO] chunk embedding failed, keyword-only retrieval: ${err instanceof Error ? err.message : err}`);
      }
    }
    const doc: SessionDocMetaDoc = {
      _id: randomUUID(),
      sessionId,
      filename,
      sizeBytes,
      chunkCount: chunks.length,
      chunks: chunkDocs,
      ...(file ? { key: file.key, contentType: file.contentType } : {}),
      createdAt: Date.now(),
    };
    await this.collection.insertOne(doc);
    return this.toMeta(doc);
  }

  async list(sessionId: string): Promise<SessionDocumentMeta[]> {
    const docs = await this.collection
      .find({ sessionId }, { sort: { createdAt: 1 }, projection: { chunks: 0 } })
      .toArray();
    return docs.map((d) => this.toMeta(d as SessionDocMetaDoc));
  }

  async search(sessionId: string, query: string, limit = 4): Promise<SessionDocHit[]> {
    const docs = await this.collection.find({ sessionId }).toArray();
    const hits: SessionDocHit[] = [];
    let queryVector: number[] | undefined;
    if (this.embeddings) {
      try {
        queryVector = await this.embeddings.embedQuery(query);
      } catch {
        queryVector = undefined;
      }
    }
    for (const d of docs) {
      const meta = d as SessionDocMetaDoc;
      for (const chunk of meta.chunks ?? []) {
        if (queryVector && chunk.vector) {
          hits.push({
            filename: meta.filename,
            text: chunk.text,
            score: cosine(queryVector, chunk.vector),
          });
        } else {
          const s = keywordScore(chunk.text, query);
          if (s > 0) hits.push({ filename: meta.filename, text: chunk.text, score: s });
        }
      }
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  async delete(sessionId: string, id: string): Promise<boolean> {
    // sessionId in the filter: a guessed id can never cross sessions
    const res = await this.collection.deleteOne({ _id: id, sessionId });
    return res.deletedCount > 0;
  }

  async deleteBySession(sessionId: string): Promise<number> {
    const res = await this.collection.deleteMany({ sessionId });
    return res.deletedCount;
  }

  private toMeta(d: SessionDocMetaDoc): SessionDocumentMeta {
    return {
      id: d._id,
      sessionId: d.sessionId,
      filename: d.filename,
      sizeBytes: d.sizeBytes,
      chunkCount: d.chunkCount,
      key: d.key,
      contentType: d.contentType,
      createdAt: d.createdAt,
    };
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

function keywordScore(text: string, query: string): number {
  const lower = text.toLowerCase();
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  let score = 0;
  if (lower.includes(q)) score += 3;
  for (const token of q.split(/[\s,，。;；]+/).filter((t) => t.length >= 2)) {
    if (lower.includes(token)) score += 1;
  }
  const grams = q.match(/.{2}/gu) ?? [];
  for (const gram of grams) {
    if (lower.includes(gram)) score += 0.5;
  }
  return score;
}
