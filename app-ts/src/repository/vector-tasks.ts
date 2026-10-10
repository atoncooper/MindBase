/**
 * Vectorization bookkeeping — the AI side's OWN store for per-page vector
 * state (vec_pages) and pipeline task records (vec_tasks).
 *
 * With the Python backend retired, the MySQL `video.is_vectorized*` columns
 * it maintained go stale by design; this store becomes the source of truth
 * for vectorization state (Milvus itself only holds content). User scoping
 * of pages goes through the app-bili knowledge scope (collection ownership),
 * not through a uid column here.
 */

export type VecStatus = "pending" | "processing" | "done" | "failed";

export interface VecPageRecord {
  bvid: string;
  cid: number;
  pageIndex: number;
  pageTitle: string;
  status: VecStatus;
  chunkCount: number;
  error?: string;
  /** sha1 of the ASR content the current vectors were built from (change detection) */
  contentHash?: string;
  /** epoch ms; absent for records seeded without a timestamp */
  vectorizedAt?: number;
  updatedAt: number;
}

export interface VecTaskStep {
  name: string;
  status: string;
  progress: number;
  at: number;
}

export interface VecTaskRecord {
  taskId: string;
  uid: string;
  bvid: string;
  cid: number;
  pageIndex: number;
  pageTitle: string;
  status: VecStatus;
  progress: number;
  steps: VecTaskStep[];
  result?: Record<string, unknown>;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface VectorTaskRepository {
  upsertPage(record: VecPageRecord): Promise<void>;
  getPage(bvid: string, cid: number): Promise<VecPageRecord | undefined>;
  listPagesByBvid(bvid: string): Promise<VecPageRecord[]>;
  listAllPages(): Promise<VecPageRecord[]>;
  deletePagesByBvid(bvid: string): Promise<void>;
  deleteAllPages(): Promise<void>;
  saveTask(record: VecTaskRecord): Promise<void>;
  getTask(taskId: string): Promise<VecTaskRecord | undefined>;
  close(): Promise<void>;
}

export function newVecTaskId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
