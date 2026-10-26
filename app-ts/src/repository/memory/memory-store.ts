import { randomUUID } from "node:crypto";
import { scoreMemoryText, type MemoryEntry, type MemoryRepository } from "../memory-store.js";

/** In-memory implementation: isolated per uid, retrieval scored by keyword tokenization (process-local — cleared on restart). */
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
    const scored = this.entries
      .filter((e) => e.uid === uid)
      .map((e) => ({ e, score: scoreMemoryText(e.content + " " + e.tags.join(" "), query) }))
      .filter((x) => x.score > 0);
    // stable sort keeps add order for equal scores (oldest first)
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((x) => x.e);
  }

  async list(uid: string, limit = 20): Promise<MemoryEntry[]> {
    return this.entries
      .filter((e) => e.uid === uid)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }
}
