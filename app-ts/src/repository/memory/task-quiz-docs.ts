import type { TaskQuizDoc, TaskQuizQuestion } from "../task-quiz-docs.js";

/** In-memory implementation (tests / degraded fallback). */
export class MemoryTaskQuizDocStore {
  private readonly docs = new Map<string, TaskQuizDoc>();

  async get(taskId: string): Promise<TaskQuizDoc | undefined> {
    const doc = this.docs.get(taskId);
    return doc ? { ...doc } : undefined;
  }

  async markGenerating(doc: Pick<TaskQuizDoc, "task_id" | "uid">): Promise<void> {
    const existing = this.docs.get(doc.task_id);
    if (existing) {
      existing.status = "generating";
      existing.uid = doc.uid;
    } else {
      this.docs.set(doc.task_id, { ...doc, status: "generating", created_at: new Date() });
    }
  }

  async markFailed(taskId: string, error: string): Promise<void> {
    const doc = this.docs.get(taskId);
    if (doc) {
      doc.status = "failed";
      doc.error = error;
      doc.failed_at = new Date();
    }
  }

  async markReady(taskId: string, questions: TaskQuizQuestion[], difficulty: string): Promise<void> {
    const doc = this.docs.get(taskId);
    if (doc) {
      doc.status = "ready";
      doc.questions = questions;
      doc.difficulty = difficulty;
      doc.generated_at = new Date();
    }
  }

  async deleteIfFailed(taskId: string): Promise<void> {
    const doc = this.docs.get(taskId);
    if (doc && doc.status === "failed") this.docs.delete(taskId);
  }

  async close(): Promise<void> {}
}
