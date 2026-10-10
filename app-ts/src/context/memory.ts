import type { MemoryRepository } from "../repository/memory-store.js";

/**
 * Memory context: recall belongs to the context layer, not the agent —
 * each turn retrieves memories relevant to the current query and injects them into the system prompt (falls back to the most recent entries when nothing matches).
 * Writes go through the save_memory tool; once embeddings are wired in, search can be upgraded to semantic retrieval.
 */
export async function buildMemorySection(
  store: MemoryRepository,
  uid: string | undefined,
  query: string,
): Promise<string> {
  if (uid === undefined) return "";
  let entries = await store.search(uid, query, 5);
  if (entries.length === 0) {
    entries = await store.list(uid, 3);
  }
  if (entries.length === 0) return "";
  const lines = entries.map((e) => `- ${e.content}`).join("\n");
  return [
    ``,
    `## 用户长期记忆`,
    `以下是该用户之前保存的记忆，回答时参考；与当前问题无关时不要强行引用。`,
    lines,
  ].join("\n");
}
