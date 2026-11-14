import type { PlanGraph } from "../agent/dag/types.js";
import type { PlanStepStatus, TokenUsage } from "../context/types.js";

/**
 * Durable plan-run state. One record per plan execution (DAG or linear); the
 * graph is the immutable plan definition, nodes carry the mutable execution
 * state so a crashed turn can resume without re-running completed nodes.
 */
export interface PlanRunNode {
  id: string;
  title: string;
  agent: string;
  deps: string[];
  task: string;
  acceptance: string;
  status: PlanStepStatus;
  note?: string;
  output?: string;
  error?: string;
  usage?: TokenUsage;
  attempts: number;
  startedAt?: number;
  endedAt?: number;
}

export type PlanRunStatus = "pending" | "running" | "completed" | "failed" | "partial";

export interface PlanRunRecord {
  runId: string;
  chatSessionId: string;
  uid?: string;
  /** Academic research project the run was launched from (research workbench chat context); absent for plain chats. */
  projectId?: string;
  goal: string;
  status: PlanRunStatus;
  version: number;
  graph: PlanGraph;
  nodes: PlanRunNode[];
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
}

/** Default page size for listByUid (docs/research-ui-api.md §6). */
export const PLAN_RUN_LIST_DEFAULT_LIMIT = 20;
/** Upper bound for a single listByUid page (out-of-range values are clamped). */
export const PLAN_RUN_LIST_MAX_LIMIT = 100;

/** Normalize a listByUid limit: default 20, clamped to [1, 100]. */
export function planRunListLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return PLAN_RUN_LIST_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), PLAN_RUN_LIST_MAX_LIMIT);
}

export interface PlanRunRepository {
  create(run: PlanRunRecord): Promise<void>;
  get(runId: string): Promise<PlanRunRecord | undefined>;
  getLatestBySession(chatSessionId: string): Promise<PlanRunRecord | undefined>;
  /**
   * Newest-first (updatedAt desc) history for one uid, optionally narrowed to a
   * chat session and/or an academic project. Limit is normalized by
   * planRunListLimit; runs without a uid (pre-identity rows) are never returned.
   */
  listByUid(uid: string, limit?: number, chatSessionId?: string, projectId?: string): Promise<PlanRunRecord[]>;
  /** Optimistic write: rejects when an equal/newer version already exists. */
  save(run: PlanRunRecord): Promise<void>;
}
