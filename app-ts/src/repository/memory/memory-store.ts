import { randomUUID } from "node:crypto";
import type { MemoryEntry, MemoryRepository } from "../memory-store.js";

/** In-memory implementation: isolated per uid, retrieval scored by keyword tokenization. */
export class MemoryMemoryStore implements MemoryRepository {
  private readonly entries: MemoryEntry[] = [];

  async add(uid: string, content: string, tags: string[] = []): Promise<MemoryEntry> {
    const entry: MemoryEntry = {
      id: randomUUID(),
      uid,
      content: content.trim(),
      tags,
      createdAt: Date.now(),
    };
    this.entries.push(entry);
    return entry;
  }

  async search(uid: string, query: string, limit = 5): Promise<MemoryEntry[]> {
    // Simple keyword scoring: split into 2-grams + the original word; more hits = higher score
    const scored = this.entries
      .filter((e) => e.uid === uid)
      .map((e) => ({ e, score: this.score(e.content + " " + e.tags.join(" "), query) }))
      .filter((x) => x.score > 0);
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((x) => x.e);
  }

  async list(uid: string, limit = 20): Promise<MemoryEntry[]> {
    return this.entries
      .filter((e) => e.uid === uid)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  private score(text: string, query: string): number {
    const lower = text.toLowerCase();
    const q = query.toLowerCase().trim();
    if (!q) return 0;
    let score = 0;
    if (lower.includes(q)) score += 3;
    // Whitespace tokenization (English/explicit tokenization)
    for (const token of q.split(/[\s,，。;；]+/).filter((t) => t.length >= 2)) {
      if (lower.includes(token)) score += 1;
    }
    // Chinese 2-grams: covers Chinese queries without separators (e.g. "theme preference" matching "dark theme")
    const grams = q.match(/.{2}/gu) ?? [];
    for (const gram of grams) {
      if (lower.includes(gram)) score += 0.5;
    }
    return score;
  }
}
