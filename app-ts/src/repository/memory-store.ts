/** MemoryRepository: user long-term memory storage (mirrors the Python memory agent's responsibilities; v1 in-memory, MySQL/Mongo later). */
export interface MemoryEntry {
  id: string;
  uid: string;
  content: string;
  tags: string[];
  createdAt: number;
}

export interface MemoryRepository {
  add(uid: string, content: string, tags?: string[]): Promise<MemoryEntry>;
  /** v1 keyword-match retrieval; upgrades to semantic retrieval once embeddings are wired in */
  search(uid: string, query: string, limit?: number): Promise<MemoryEntry[]>;
  list(uid: string, limit?: number): Promise<MemoryEntry[]>;
}
