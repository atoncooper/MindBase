/**
 * ASR transcript source for the KG build pipeline — port contract for a READ-ONLY cross-DB
 * accessor into the Python backend's Mongo database (mind_base.asr_documents).
 * The transcript data is owned by the bili (获取) domain; app-ts never writes
 * here. The read mirrors app/repository/mongo_asr_repository.get_latest.
 *
 * Implementations: mongo/kg-sources.ts (Mongo, production) ·
 * memory/kg-sources.ts (in-memory, tests / degraded fallback).
 */

export interface AsrTranscript {
  content: string;
  pageTitle: string;
}

export interface KgSourceStore {
  getLatest(bvid: string, cid: number): Promise<AsrTranscript | undefined>;
  close(): Promise<void>;
}
