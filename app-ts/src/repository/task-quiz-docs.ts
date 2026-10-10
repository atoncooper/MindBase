/**
 * Scheduled-quiz generation state documents — the SHARED Mongo collection
 * `task_quiz_questions` (database mind_base). app-ts writes the generation
 * lifecycle (generating → ready/failed + questions); app-quiz (Go) reads the
 * same collection for /tasks/{id}/detail. Same sharing pattern as the
 * async_tasks rows between app-bili and the old Python stack.
 *
 * Implementations: mongo/task-quiz-docs.ts (Mongo, production) ·
 * memory/task-quiz-docs.ts (in-memory, tests / degraded fallback).
 */

export interface TaskQuizQuestion {
  question: string;
  question_type: "fill_blank" | "choice" | "short_answer";
  options: string[] | null;
  answer: string;
  difficulty: "easy" | "medium" | "hard";
  answer_time_limit_seconds: number;
}

export interface TaskQuizDoc {
  task_id: string;
  uid: string;
  status: "generating" | "ready" | "failed";
  questions?: TaskQuizQuestion[];
  difficulty?: string;
  error?: string;
  created_at?: Date;
  generated_at?: Date;
  failed_at?: Date;
}

/** task-level answer window = first question's limit; fallbacks by difficulty. */
export function taskTimeLimitSeconds(questions: TaskQuizQuestion[], difficulty: string): number {
  const first = questions[0]?.answer_time_limit_seconds;
  if (typeof first === "number" && first > 0) return first;
  if (difficulty === "easy") return 600;
  if (difficulty === "hard") return 1800;
  return 1200;
}
