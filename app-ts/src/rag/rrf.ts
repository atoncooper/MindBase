import type { Document } from "./types.js";

/**
 * Reciprocal-rank-fusion of the dense and sparse result lists (mirrors Python RRFRanker
 * with k=60): score(d) = Σ 1/(k + rank). Dedupes by chunkId, sorts by fused score.
 */
export function rrfMerge(a: Document[], b: Document[], k = 60): Document[] {
  const scores = new Map<string, number>();
  const docs = new Map<string, Document>();
  const add = (list: Document[]) => {
    list.forEach((doc, index) => {
      const key = doc.metadata.chunkId || `${doc.metadata.bvid ?? ""}:${index}`;
      scores.set(key, (scores.get(key) ?? 0) + 1 / (k + index + 1));
      if (!docs.has(key)) docs.set(key, doc);
    });
  };
  add(a);
  add(b);
  return [...scores.entries()]
    .sort((x, y) => y[1] - x[1])
    .map(([key, score]) => {
      const doc = docs.get(key)!;
      return { ...doc, score };
    });
}
