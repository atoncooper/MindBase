import type { KgDocRecord } from "../kg/types.js";

/**
 * Cloud-drive document extraction ledger — repository contract.
 *
 * app-ts's OWN bookkeeping store (Mongo database mind_base_ts, collection
 * kg_docs), deliberately separate from app-kg's CloudDoc graph nodes and from
 * app-cloud's cloud_files table. The idempotency key is (uid, uploadUuid):
 * the build pipeline skips a document whose last successful record carries the
 * same app-cloud content hash (no LLM call, no graph rewrite).
 *
 * Implementations: mongo/kg-docs.ts (Mongo, database mind_base_ts) ·
 * memory/kg-docs.ts (in-memory, tests / degraded fallback).
 */

export interface KgDocRepository {
  get(uid: string, uploadUuid: string): Promise<KgDocRecord | undefined>;
  save(record: KgDocRecord): Promise<void>;
  close(): Promise<void>;
}
