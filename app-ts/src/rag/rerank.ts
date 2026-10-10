import { config } from "../config/index.js";
import { createLogger } from "../logger.js";
import type { Document } from "./types.js";

/**
 * Reranker: dashscope gte-rerank-v2 via the Higress gateway native passthrough route /api/v1.
 * Semantics mirror Python rerank.py: never throws; any failure falls back to the original order truncated to top_k.
 */
const log = createLogger("RERANK");

export class Reranker {
  constructor(
    private readonly model: string = config.rerank.model,
    private readonly timeoutMs: number = config.rerank.timeoutMs,
  ) {}

  async rerank(query: string, docs: Document[], topK: number): Promise<Document[]> {
    if (docs.length <= 1) return docs.slice(0, topK);
    try {
      return await this.rerankDashscope(query, docs, topK);
    } catch (err) {
      log.warn(`[RERANK] failed, fallback to original order: ${err instanceof Error ? err.message : err}`);
      return docs.slice(0, topK);
    }
  }

  private async rerankDashscope(query: string, docs: Document[], topK: number): Promise<Document[]> {
    const url = `${config.aiGateway.nativeBaseUrl}/services/rerank/text-rerank/text-rerank`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.aiGateway.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: {
          query,
          // Truncate documents to 1500 characters (mirrors Python)
          documents: docs.map((d) => d.text.slice(0, 1500)),
        },
        parameters: { top_n: topK, return_documents: false },
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`[RERANK] gateway ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      output?: { results?: Array<{ index: number; relevance_score: number }> };
    };
    const results = json.output?.results;
    if (!results) throw new Error("[RERANK] unexpected response shape");
    const out: Document[] = [];
    for (const r of results) {
      if (config.rerank.minRelevanceScore > 0 && r.relevance_score < config.rerank.minRelevanceScore) {
        continue;
      }
      const doc = docs[r.index];
      if (!doc) continue;
      out.push({ ...doc, rerankScore: r.relevance_score });
    }
    return out;
  }
}
