import { randomUUID } from "node:crypto";
import type { PlanRunNode, PlanRunRecord, PlanRunRepository, PlanRunStatus } from "../../repository/plan-runs.js";
import type { PlanGraph } from "./types.js";
import type { PlanNodeView, PlanSnapshot, PlanStepStatus } from "../../context/types.js";

export interface CreatePlanRunInput {
  graph: PlanGraph;
  chatSessionId: string;
  uid?: string;
  /** Academic project this run was launched from (research workbench context). */
  projectId?: string;
  runId?: string;
}

function now(): number {
  return Date.now();
}

export function createRunRecord(input: CreatePlanRunInput): PlanRunRecord {
  const nodes: PlanRunNode[] = input.graph.nodes.map((node) => ({
    id: node.id,
    title: node.title,
    agent: node.agent,
    deps: [...node.deps],
    task: node.task,
    acceptance: node.acceptance,
    status: "pending",
    attempts: 0,
  }));
  return {
    runId: input.runId ?? randomUUID(),
    chatSessionId: input.chatSessionId,
    ...(input.uid ? { uid: input.uid } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    goal: input.graph.goal,
    status: "pending",
    version: 0,
    graph: input.graph,
    nodes,
    createdAt: now(),
    updatedAt: now(),
  };
}

/**
 * Durable plan-run state machine. All callers mutate a run through this class
 * so versioning, snapshot projection and persistence stay in one place.
 *
 * The runner still owns scheduling; this class owns state + persistence.
 */
export class PlanRunEngine {
  constructor(private readonly repo: PlanRunRepository) {}

  async create(input: CreatePlanRunInput): Promise<PlanRunRecord> {
    if (input.runId) {
      const existing = await this.repo.get(input.runId);
      if (existing) return existing;
    }
    const run = createRunRecord(input);
    await this.repo.create(run);
    return run;
  }

  async get(runId: string): Promise<PlanRunRecord | undefined> {
    return this.repo.get(runId);
  }

  async latest(chatSessionId: string): Promise<PlanRunRecord | undefined> {
    return this.repo.getLatestBySession(chatSessionId);
  }

  /** Newest-first uid-scoped history (GET /chat/plans; docs/research-ui-api.md §6). */
  async list(uid: string, limit?: number, chatSessionId?: string, projectId?: string): Promise<PlanRunRecord[]> {
    return this.repo.listByUid(uid, limit, chatSessionId, projectId);
  }

  /** Persist the in-memory run. Caller already owns the run (single writer). */
  async commit(run: PlanRunRecord, status?: PlanRunStatus): Promise<PlanRunRecord> {
    run.version += 1;
    run.updatedAt = now();
    if (status) run.status = status;
    if (run.status === "completed" || run.status === "failed" || run.status === "partial") {
      run.endedAt = run.endedAt ?? now();
    }
    await this.repo.save(run);
    return run;
  }

  /**
   * Prepare a crashed/incomplete run for re-execution:
   * - in_progress => pending (crash left no trustworthy completion)
   * - failed => pending (explicit resume retries; attempts keep history)
   * - done/skipped keep output and are never re-run
   */
  async normalizeForResume(run: PlanRunRecord): Promise<PlanRunRecord> {
    for (const node of run.nodes) {
      if (node.status === "in_progress" || node.status === "failed") {
        node.status = "pending";
        node.note = node.note ?? "恢复执行";
        node.error = undefined;
      }
    }
    run.status = "running";
    return this.commit(run);
  }

  snapshot(run: PlanRunRecord): PlanSnapshot {
    const nodes: PlanNodeView[] = run.nodes.map((node) => ({
      id: node.id,
      title: node.title,
      agent: node.agent,
      deps: node.deps,
      status: node.status,
      ...(node.note ? { note: node.note } : {}),
    }));
    const done = nodes.filter((n) => n.status === "done" || n.status === "skipped").length;
    const steps = nodes.map((n) => ({ desc: n.title, status: n.status, note: n.note ?? "" }));
    return {
      runId: run.runId,
      version: run.version,
      goal: run.goal,
      nodes,
      steps,
      done,
      total: nodes.length,
    };
  }

  /** Update one node and persist the whole run atomically at the app level. */
  async setNode(
    run: PlanRunRecord,
    nodeId: string,
    status: PlanStepStatus,
    patch: Partial<Pick<PlanRunNode, "note" | "output" | "error" | "usage" | "attempts" | "startedAt" | "endedAt">> = {},
  ): Promise<PlanRunRecord> {
    const node = run.nodes.find((n) => n.id === nodeId);
    if (!node) return run;
    node.status = status;
    if (patch.note !== undefined) node.note = patch.note;
    if (patch.output !== undefined) node.output = patch.output;
    if (patch.error !== undefined) node.error = patch.error;
    if (patch.usage !== undefined) node.usage = patch.usage;
    if (patch.attempts !== undefined) node.attempts = patch.attempts;
    if (patch.startedAt !== undefined) node.startedAt = patch.startedAt;
    if (patch.endedAt !== undefined) node.endedAt = patch.endedAt;
    return this.commit(run, "running");
  }
}
