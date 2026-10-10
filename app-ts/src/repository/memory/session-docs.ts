import { randomUUID } from "node:crypto";
import type {
  SessionDocHit,
  SessionDocumentMeta,
  SessionDocumentRepository,
} from "../session-docs.js";

/** In-memory implementation: per-session isolation, keyword + 2-gram scoring (same strategy as the memory store). */
export class MemorySessionDocumentStore implements SessionDocumentRepository {
  private readonly docs = new Map<string, { meta: SessionDocumentMeta; chunks: string[] }>();

  async save(
    sessionId: string,
    filename: string,
    chunks: string[],
    sizeBytes: number,
    file?: import("../persistence.js").StoredChatImage,
  ): Promise<SessionDocumentMeta> {
    const meta: SessionDocumentMeta = {
      id: randomUUID(),
      sessionId,
      filename,
      sizeBytes,
      chunkCount: chunks.length,
      ...(file ? { key: file.key, contentType: file.contentType } : {}),
      createdAt: Date.now(),
    };
    this.docs.set(meta.id, { meta, chunks });
    return meta;
  }

  async list(sessionId: string): Promise<SessionDocumentMeta[]> {
    return [...this.docs.values()]
      .map((d) => d.meta)
      .filter((m) => m.sessionId === sessionId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async search(sessionId: string, query: string, limit = 4): Promise<SessionDocHit[]> {
    const hits: SessionDocHit[] = [];
    for (const { meta, chunks } of this.docs.values()) {
      if (meta.sessionId !== sessionId) continue;
      chunks.forEach((text, index) => {
        const score = this.score(text, query);
        if (score > 0) hits.push({ filename: meta.filename, text, score });
        void index;
      });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  async delete(sessionId: string, id: string): Promise<boolean> {
    const d = this.docs.get(id);
    if (!d || d.meta.sessionId !== sessionId) return false;
    this.docs.delete(id);
    return true;
  }

  async deleteBySession(sessionId: string): Promise<number> {
    let deleted = 0;
    for (const [id, d] of this.docs) {
      if (d.meta.sessionId === sessionId) {
        this.docs.delete(id);
        deleted += 1;
      }
    }
    return deleted;
  }

  /** Keyword full match + CJK 2-gram scoring (mirrors MemoryMemoryStore). */
  private score(text: string, query: string): number {
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
}
