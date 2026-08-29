/**
 * Typed access to the quiz commands (`quiz_*` on the Rust side).
 *
 * Generation samples knowledge chunks from the local store and asks the chat
 * model for a strict-JSON batch. Grading is local for choice types and LLM
 * rubric scoring for essays. The full question (with answer material)
 * travels back from the UI on grade — a deliberate local-app trust model.
 */

import { Channel, invoke } from "@tauri-apps/api/core";

export type QuizType = "single_choice" | "multi_choice" | "short_answer" | "essay";
export type QuizDifficulty = "easy" | "medium" | "hard";

export interface RubricItem {
  description: string;
  maxPoints: number;
}

export interface QuizQuestion {
  questionId: string;
  questionType: QuizType;
  difficulty: string;
  question: string;
  options?: string[];
  correctAnswer?: unknown;
  keywords: string[];
  answerTemplate?: string;
  modelAnswer?: string;
  scoringRubric?: RubricItem[];
  explanation: string;
  sourceSnippet: string;
  lowConfidence: boolean;
}

export interface GradeOutcome {
  questionId: string;
  correct: boolean;
  score: number;
  maxScore: number;
  feedback: string;
}

export interface GenerateRequest {
  count: number;
  types: QuizType[];
  difficulty: QuizDifficulty;
  topic?: string;
}

/** Sample knowledge-base chunks feeding the generator (for previews). */
export function sourceChunks(topic?: string, count?: number): Promise<{ title: string; content: string }[]> {
  return invoke("quiz_source_chunks", { topic: topic ?? null, count: count ?? null });
}

/** Progress pushed while a batch generates. */
export type QuizGenEvent = { type: "sampling" } | { type: "generating" };

/** Outcome of one generation run (dedup stats included). */
export interface QuizGenerateResult {
  questions: QuizQuestion[];
  /** Batch-internal duplicates dropped (same stem seen twice this run). */
  duplicatesSkipped: number;
  /** Stems already in the ask-history that this run avoided. */
  historySize: number;
}

export function generateQuiz(
  request: GenerateRequest,
  onEvent?: (event: QuizGenEvent) => void,
): Promise<QuizGenerateResult> {
  const channel = new Channel<QuizGenEvent>();
  if (onEvent !== undefined) channel.onmessage = onEvent;
  return invoke<QuizGenerateResult>("quiz_generate", { request, onEvent: channel });
}

export function gradeQuestion(question: QuizQuestion, answer: string): Promise<GradeOutcome> {
  return invoke<GradeOutcome>("quiz_grade", { question, answer });
}

// --- 测验历史记录（graded sessions） --------------------------------------

/** One answered question inside a saved record. */
export interface QuizRecordItem {
  questionType: QuizType;
  question: string;
  given: string;
  correct: boolean;
  score: number;
  maxScore: number;
  feedback: string;
}

/** One graded quiz session, as listed in history. */
export interface QuizRecord {
  id: string;
  createdAt: number;
  difficulty: string;
  questionCount: number;
  totalScore: number;
  totalMax: number;
  items: QuizRecordItem[];
}

/** Save one graded session; totals are computed server-side. */
export function saveQuizRecord(difficulty: QuizDifficulty, items: QuizRecordItem[]): Promise<string> {
  return invoke<string>("quiz_record_save", { request: { difficulty, items } });
}

/** List recent graded sessions, newest first. */
export function listQuizRecords(limit?: number): Promise<QuizRecord[]> {
  return invoke<QuizRecord[]>("quiz_record_list", { limit: limit ?? null });
}

/** Delete one graded session. */
export function deleteQuizRecord(id: string): Promise<void> {
  return invoke<void>("quiz_record_delete", { id });
}
