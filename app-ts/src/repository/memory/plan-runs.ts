import { planRunListLimit, type PlanRunRecord, type PlanRunRepository } from "../plan-runs.js";

function clone<T>(v: T): T {
  return structuredClone(v);
}

/** In-memory plan-run store: unit tests and MongoDB-unreachable fallback. */
export class MemoryPlanRunRepository implements PlanRunRepository {
  private readonly runs = new Map<string, PlanRunRecord>();

  async create(run: PlanRunRecord): Promise<void> {
    this.runs.set(run.runId, clone(run));
  }

  async get(runId: string): Promise<PlanRunRecord | undefined> {
    const run = this.runs.get(runId);
    return run ? clone(run) : undefined;
  }

  async getLatestBySession(chatSessionId: string): Promise<PlanRunRecord | undefined> {
    let latest: PlanRunRecord | undefined;
    for (const run of this.runs.values()) {
      if (run.chatSessionId !== chatSessionId) continue;
      if (!latest || run.updatedAt > latest.updatedAt) latest = run;
    }
    return latest ? clone(latest) : undefined;
  }

  async listByUid(uid: string, limit?: number, chatSessionId?: string, projectId?: string): Promise<PlanRunRecord[]> {
    const take = planRunListLimit(limit);
    return [...this.runs.values()]
      .filter(
        (run) =>
          run.uid === uid &&
          (chatSessionId === undefined || run.chatSessionId === chatSessionId) &&
          (projectId === undefined || run.projectId === projectId),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, take)
      .map(clone);
  }

  async save(run: PlanRunRecord): Promise<void> {
    const current = this.runs.get(run.runId);
    if (current && current.version >= run.version) {
      throw new Error("plan run version conflict: " + run.runId);
    }
    this.runs.set(run.runId, clone(run));
  }
}
