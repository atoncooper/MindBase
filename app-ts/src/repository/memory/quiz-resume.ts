import type { QuizResumePlan, QuizResumeStore } from "../quiz-resume.js";

/** 进程内实现：单测 / Mongo 不可达时的降级 fallback（分层约定见 AGENTS §三）。 */
export class MemoryQuizResumeStore implements QuizResumeStore {
  private readonly plans = new Map<string, QuizResumePlan>();

  private key(uid: string, quizUuid: string): string {
    return uid + ":" + quizUuid;
  }

  async save(plan: QuizResumePlan): Promise<void> {
    this.plans.set(this.key(plan.uid, plan.quizUuid), { ...plan });
  }

  async get(uid: string, quizUuid: string): Promise<QuizResumePlan | null> {
    const hit = this.plans.get(this.key(uid, quizUuid));
    return hit ? { ...hit } : null;
  }

  async remove(uid: string, quizUuid: string): Promise<void> {
    this.plans.delete(this.key(uid, quizUuid));
  }
}
