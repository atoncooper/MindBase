/**
 * Typed access to the workspace search / QA commands
 * (`search_knowledge` / `ask_knowledge` on the Rust side).
 *
 * Search embeds the query and brute-forces the local vector store; QA
 * additionally asks the configured chat model to answer with [n] citations
 * over the retrieved blocks. Both require a DashScope key (embeddings);
 * QA needs any conversational provider on top.
 */

import { invoke } from "@tauri-apps/api/core";

/** One retrieval hit with its document metadata joined in. */
export interface KnowledgeHit {
  docId: string;
  chunkIndex: number;
  content: string;
  /** Cosine similarity in [-1, 1]. */
  score: number;
  bvid: string;
  pageIndex: number;
  videoTitle: string;
  pageTitle: string;
  url: string;
}

/** Grounded answer plus the exact context blocks used. */
export interface QaAnswer {
  answer: string;
  sources: KnowledgeHit[];
  provider: string;
  model: string;
}

/** Semantic search over the ingested knowledge base. */
export function searchKnowledge(query: string, topK?: number): Promise<KnowledgeHit[]> {
  return invoke<KnowledgeHit[]>("search_knowledge", { query, topK: topK ?? null });
}

/** Ask a question grounded in the ingested knowledge base. */
export function askKnowledge(question: string): Promise<QaAnswer> {
  return invoke<QaAnswer>("ask_knowledge", { question });
}
