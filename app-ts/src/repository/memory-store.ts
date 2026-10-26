/** MemoryRepository: user long-term memory storage (implementations: memory/ in-process, mongo/ durable; survives restarts only with Mongo). */
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

/**
 * Keyword relevance score shared by every MemoryRepository implementation
 * (memory/immediate + mongo/durable) so recall semantics do not drift when the
 * backing store changes: full-query hit weighs most, then whitespace/explicit
 * tokens, then sliding 2-grams (covers Chinese queries without separators).
 *
 * Lives in the contract (no I/O) because the Mongo adapter scores in the
 * application layer instead of relying on a text index.
 */
export function scoreMemoryText(text: string, query: string): number {
  const lower = text.toLowerCase();
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  let score = 0;
  if (lower.includes(q)) score += 3;
  // Whitespace tokenization (English/explicit tokenization)
  for (const token of q.split(/[\s,，。;；]+/).filter((t) => t.length >= 2)) {
    if (lower.includes(token)) score += 1;
  }
  // Chinese 2-grams: covers Chinese queries without separators (e.g. "主题偏好" matching "偏好深色主题")
  const grams = q.match(/.{2}/gu) ?? [];
  for (const gram of grams) {
    if (lower.includes(gram)) score += 0.5;
  }
  return score;
}
