import { MongoClient, type Collection, type Db } from "mongodb";
import { config } from "../../config/index.js";
import { createLogger } from "../../logger.js";
import type { TaskQuizDoc, TaskQuizQuestion } from "../task-quiz-docs.js";

const log = createLogger("TASK_QUIZ_DOCS");

/**
 * Mongo adapter for the scheduled-quiz generation docs — see
 * ../task-quiz-docs.ts for the contract and the shared-collection story
 * (mind_base.task_quiz_questions, read by app-quiz for /tasks/{id}/detail).
 */

export class MongoTaskQuizDocStore {
  private constructor(
    private readonly client: MongoClient,
    private readonly col: Collection<TaskQuizDoc>,
  ) {}

  static async connect(): Promise<MongoTaskQuizDocStore | null> {
    const { uri, timeoutMs } = config.mongo;
    const database = config.taskQuiz.sourceDatabase;
    if (!uri) return null;
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: timeoutMs,
      connectTimeoutMS: timeoutMs,
    });
    try {
      await client.connect();
      await client.db("admin").command({ ping: 1 });
      const db = client.db(database) as Db;
      const store = new MongoTaskQuizDocStore(client, db.collection<TaskQuizDoc>(config.taskQuiz.docCollection));
      await store.col.createIndex({ task_id: 1 }, { unique: true });
      return store;
    } catch (err) {
      log.warn(`[MONGO] connect failed: ${err instanceof Error ? err.message : err}`);
      await client.close().catch(() => undefined);
      return null;
    }
  }

  async get(taskId: string): Promise<TaskQuizDoc | undefined> {
    return (await this.col.findOne({ task_id: taskId })) ?? undefined;
  }

  async markGenerating(doc: Pick<TaskQuizDoc, "task_id" | "uid">): Promise<void> {
    await this.col.updateOne(
      { task_id: doc.task_id },
      {
        $set: { status: "generating", uid: doc.uid },
        $setOnInsert: { created_at: new Date() },
      },
      { upsert: true },
    );
  }

  async markFailed(taskId: string, error: string): Promise<void> {
    await this.col.updateOne(
      { task_id: taskId },
      { $set: { status: "failed", error, failed_at: new Date() } },
    );
  }

  async markReady(taskId: string, questions: TaskQuizQuestion[], difficulty: string): Promise<void> {
    await this.col.updateOne(
      { task_id: taskId },
      { $set: { status: "ready", questions, difficulty, generated_at: new Date() } },
    );
  }

  /** failed → delete so the next executor retry regenerates (Python parity). */
  async deleteIfFailed(taskId: string): Promise<void> {
    await this.col.deleteOne({ task_id: taskId, status: "failed" });
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => undefined);
  }
}
