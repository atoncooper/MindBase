import { MongoClient, type Collection, type Db } from "mongodb";
import { config } from "../../config/index.js";
import { createLogger } from "../../logger.js";
import type {
  AiTask,
  AiTaskPatch,
  AiTaskRepository,
  AiTaskRun,
  AiTaskRunPatch,
} from "../ai-tasks.js";

const log = createLogger("MONGO");

/** MongoDB adapter: mind_base_ts.ai_tasks + ai_task_runs. */
export class MongoAiTaskRepository implements AiTaskRepository {
  private constructor(
    private readonly client: MongoClient,
    private readonly tasks: Collection<AiTask>,
    private readonly runs: Collection<AiTaskRun>,
  ) {}

  static async connect(): Promise<MongoAiTaskRepository | null> {
    const { uri, database, timeoutMs } = config.mongo;
    if (!uri) return null;
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: timeoutMs,
      connectTimeoutMS: timeoutMs,
    });
    try {
      await client.connect();
      const db: Db = client.db(database);
      const tasks = db.collection<AiTask>("ai_tasks");
      const runs = db.collection<AiTaskRun>("ai_task_runs");
      await Promise.all([
        tasks.createIndex({ uid: 1, createdAt: -1 }),
        tasks.createIndex({ status: 1, nextRunAt: 1 }),
        runs.createIndex({ uid: 1, taskId: 1, createdAt: -1 }),
        runs.createIndex({ taskId: 1, runKey: 1 }, { unique: true }),
      ]);
      return new MongoAiTaskRepository(client, tasks, runs);
    } catch (err) {
      log.warn("[AI_TASKS] Mongo connect failed: " + (err instanceof Error ? err.message : String(err)));
      await client.close().catch(() => undefined);
      return null;
    }
  }

  async createTask(task: AiTask): Promise<AiTask> {
    await this.tasks.insertOne({ ...task });
    return { ...task };
  }

  async getTask(uid: string, id: string): Promise<AiTask | undefined> {
    return (await this.tasks.findOne({ id, uid })) ?? undefined;
  }

  async listTasks(uid: string): Promise<AiTask[]> {
    return this.tasks.find({ uid }).sort({ createdAt: -1 }).toArray();
  }

  async updateTask(uid: string, id: string, patch: AiTaskPatch): Promise<AiTask | undefined> {
    const set: Record<string, unknown> = { updatedAt: Date.now() };
    const unset: Record<string, ""> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) unset[key] = "";
      else if (value !== undefined) set[key] = value;
    }
    const updated = await this.tasks.findOneAndUpdate(
      { id, uid },
      { $set: set, ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}) },
      { returnDocument: "after" },
    );
    return updated ?? undefined;
  }

  async deleteTask(uid: string, id: string): Promise<boolean> {
    const result = await this.tasks.deleteOne({ id, uid });
    if (result.deletedCount > 0) {
      await this.runs.deleteMany({ taskId: id, uid });
    }
    return result.deletedCount > 0;
  }

  async listDue(now: number, limit: number): Promise<AiTask[]> {
    return this.tasks
      .find({
        status: "active",
        nextRunAt: { $lte: now },
        $or: [{ lockedUntil: { $exists: false } }, { lockedUntil: { $lte: now } }],
      } as never)
      .sort({ nextRunAt: 1 })
      .limit(Math.max(1, limit))
      .toArray();
  }

  async claimTask(id: string, now: number, leaseMs: number): Promise<AiTask | undefined> {
    const updated = await this.tasks.findOneAndUpdate(
      {
        id,
        status: "active",
        nextRunAt: { $lte: now },
        $or: [{ lockedUntil: { $exists: false } }, { lockedUntil: { $lte: now } }],
      } as never,
      { $set: { lockedUntil: now + leaseMs, updatedAt: now } },
      { returnDocument: "after" },
    );
    return updated ?? undefined;
  }

  async createRun(run: AiTaskRun): Promise<AiTaskRun> {
    try {
      await this.runs.insertOne({ ...run });
      return { ...run };
    } catch (err) {
      // Unique (taskId, runKey): a scheduler retry/restart returns the existing run.
      const existing = await this.runs.findOne({ taskId: run.taskId, runKey: run.runKey });
      if (existing) return existing;
      throw err;
    }
  }

  async getRun(uid: string, id: string): Promise<AiTaskRun | undefined> {
    return (await this.runs.findOne({ id, uid })) ?? undefined;
  }

  async listRuns(uid: string, taskId: string, limit: number): Promise<AiTaskRun[]> {
    return this.runs
      .find({ uid, taskId })
      .sort({ createdAt: -1 })
      .limit(Math.max(1, limit))
      .toArray();
  }

  async updateRun(runId: string, patch: AiTaskRunPatch): Promise<void> {
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) set[key] = value;
    }
    if (Object.keys(set).length > 0) {
      await this.runs.updateOne({ id: runId }, { $set: set });
    }
  }

  async findRunningRun(taskId: string): Promise<AiTaskRun | undefined> {
    return (await this.runs.findOne({ taskId, status: { $in: ["running", "queued"] } })) ?? undefined;
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
