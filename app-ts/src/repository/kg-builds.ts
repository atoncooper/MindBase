import type { KgBuildRecord } from "../kg/types.js";

/**
 * KG build task records — repository contract. Records are uid-scoped;
 * status is the single-active guard. app-ts's OWN task store, deliberately
 * NOT the Python async_tasks table (the MySQL task rows belong to the
 * Python stack's vec/kg bookkeeping; the /knowledge/kg/status contract is
 * served from here once app-ts owns the routes).
 *
 * Implementations: mongo/kg-builds.ts (Mongo, database mind_base_ts) ·
 * memory/kg-builds.ts (in-memory, tests / degraded fallback).
 */

export interface KgBuildRepository {
  save(record: KgBuildRecord): Promise<void>;
  get(taskId: string, uid: string): Promise<KgBuildRecord | undefined>;
  /** the user's active (processing) build, if any */
  findActive(uid: string): Promise<KgBuildRecord | undefined>;
  close(): Promise<void>;
}
