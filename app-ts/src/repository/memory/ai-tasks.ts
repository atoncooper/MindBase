import type {
  AiTask,
  AiTaskPatch,
  AiTaskRepository,
  AiTaskRun,
  AiTaskRunPatch,
} from "../ai-tasks.js";

/** In-process fallback for tests and MongoDB-unreachable boots. */
export class MemoryAiTaskRepository implements AiTaskRepository {
  private readonly tasks = new Map<string, AiTask>();
  private readonly runs = new Map<string, AiTaskRun>();

  async createTask(task: AiTask): Promise<AiTask> {
    this.tasks.set(task.id, { ...task });
    return { ...task };
  }

  async getTask(uid: string, id: string): Promise<AiTask | undefined> {
    const task = this.tasks.get(id);
    return task?.uid === uid ? { ...task } : undefined;
  }

  async listTasks(uid: string): Promise<AiTask[]> {
    return [...this.tasks.values()]
      .filter((task) => task.uid === uid)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((task) => ({ ...task }));
  }

  async updateTask(uid: string, id: string, patch: AiTaskPatch): Promise<AiTask | undefined> {
    const current = this.tasks.get(id);
    if (!current || current.uid !== uid) return undefined;
    const next: AiTask = { ...current, updatedAt: Date.now() };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) {
        delete (next as unknown as Record<string, unknown>)[key];
      } else if (value !== undefined) {
        (next as unknown as Record<string, unknown>)[key] = value;
      }
    }
    this.tasks.set(id, next);
    return { ...next };
  }

  async deleteTask(uid: string, id: string): Promise<boolean> {
    const task = this.tasks.get(id);
    if (!task || task.uid !== uid) return false;
    this.tasks.delete(id);
    for (const [runId, run] of this.runs) {
      if (run.taskId === id) this.runs.delete(runId);
    }
    return true;
  }

  async listDue(now: number, limit: number): Promise<AiTask[]> {
    return [...this.tasks.values()]
      .filter(
        (task) =>
          task.status === "active" &&
          typeof task.nextRunAt === "number" &&
          task.nextRunAt <= now &&
          (task.lockedUntil === undefined || task.lockedUntil <= now),
      )
      .sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0))
      .slice(0, Math.max(1, limit))
      .map((task) => ({ ...task }));
  }

  async claimTask(id: string, now: number, leaseMs: number): Promise<AiTask | undefined> {
    const task = this.tasks.get(id);
    if (!task || task.status !== "active" || typeof task.nextRunAt !== "number" || task.nextRunAt > now) {
      return undefined;
    }
    if (task.lockedUntil !== undefined && task.lockedUntil > now) return undefined;
    const next = { ...task, lockedUntil: now + leaseMs, updatedAt: now };
    this.tasks.set(id, next);
    return { ...next };
  }

  async createRun(run: AiTaskRun): Promise<AiTaskRun> {
    const duplicate = [...this.runs.values()].find(
      (item) => item.taskId === run.taskId && item.runKey === run.runKey,
    );
    if (duplicate) return { ...duplicate };
    this.runs.set(run.id, { ...run });
    return { ...run };
  }

  async getRun(uid: string, id: string): Promise<AiTaskRun | undefined> {
    const run = this.runs.get(id);
    return run?.uid === uid ? { ...run } : undefined;
  }

  async listRuns(uid: string, taskId: string, limit: number): Promise<AiTaskRun[]> {
    return [...this.runs.values()]
      .filter((run) => run.uid === uid && run.taskId === taskId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, Math.max(1, limit))
      .map((run) => ({ ...run }));
  }

  async updateRun(runId: string, patch: AiTaskRunPatch): Promise<void> {
    const current = this.runs.get(runId);
    if (!current) return;
    const next = { ...current };
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) (next as unknown as Record<string, unknown>)[key] = value;
    }
    this.runs.set(runId, next);
  }

  async findRunningRun(taskId: string): Promise<AiTaskRun | undefined> {
    const run = [...this.runs.values()].find(
      (item) => item.taskId === taskId && (item.status === "running" || item.status === "queued"),
    );
    return run ? { ...run } : undefined;
  }
}
