/**
 * Typed access to the built-in vector store
 * (exposed by the Rust `get_vector_stats` / `upsert_doc_chunks` /
 * `search_vectors` / `delete_doc_vectors` commands).
 *
 * Zero configuration by design: vectors live inside the same SQLite database
 * as everything else, under the active data directory. Search is brute-force
 * cosine similarity, sized for a personal knowledge base.
 */

import { invoke } from "@tauri-apps/api/core";

/** One chunk to store: position, text and its pre-computed embedding. */
export interface UpsertChunk {
  index: number;
  content: string;
  embedding: number[];
}

/** A retrieval hit with cosine similarity in [-1, 1]. */
export interface SearchHit {
  docId: string;
  chunkIndex: number;
  content: string;
  score: number;
}

/** Read-only store facts for the status card. */
export interface VectorStats {
  /** Stored chunk count across all documents. */
  count: number;
  /** Absolute path of the SQLite file hosting the vectors. */
  storagePath: string;
}

/** Read-only store facts for the status card. */
export async function getVectorStats(): Promise<VectorStats> {
  return invoke<VectorStats>("get_vector_stats");
}

/** Store or replace chunks of one document; resolves to the number written. */
export async function upsertDocChunks(
  docId: string,
  chunks: UpsertChunk[],
): Promise<number> {
  return invoke<number>("upsert_doc_chunks", { docId, chunks });
}

/**
 * Brute-force cosine search; rows with a different embedding dimension are
 * skipped. `docIds` optionally narrows the scan.
 */
export async function searchVectors(
  queryEmbedding: number[],
  topK: number,
  docIds?: string[],
): Promise<SearchHit[]> {
  return invoke<SearchHit[]>("search_vectors", {
    queryEmbedding,
    topK,
    docIds: docIds ?? null,
  });
}

/** Delete every chunk of one document; resolves to the number removed. */
export async function deleteDocVectors(docId: string): Promise<number> {
  return invoke<number>("delete_doc_vectors", { docId });
}
