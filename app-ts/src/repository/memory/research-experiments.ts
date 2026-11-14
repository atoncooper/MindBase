import type { ResearchExperiment, ResearchExperimentRepository } from "../research-experiments.js";

export class MemoryResearchExperimentRepository implements ResearchExperimentRepository {
  private readonly runs = new Map<string, ResearchExperiment>();

  async create(exp: ResearchExperiment): Promise<void> {
    this.runs.set(exp.id, structuredClone(exp));
  }

  async get(id: string): Promise<ResearchExperiment | undefined> {
    const run = this.runs.get(id);
    return run ? structuredClone(run) : undefined;
  }

  async listByUid(uid: string, projectId?: string, limit = 20): Promise<ResearchExperiment[]> {
    return [...this.runs.values()]
      .filter((r) => r.uid === uid && (!projectId || r.projectId === projectId))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }

  async listUnfinished(): Promise<ResearchExperiment[]> {
    return [...this.runs.values()]
      .filter((r) => r.status === "queued" || r.status === "running")
      .map((r) => structuredClone(r));
  }

  async save(exp: ResearchExperiment): Promise<void> {
    this.runs.set(exp.id, structuredClone(exp));
  }
}
