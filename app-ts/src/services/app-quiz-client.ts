import { config } from "../config/index.js";
import { InternalServiceClient } from "../transport/internal-client.js";

/**
 * Thin HTTP client for app-quiz's internal storage API
 * (APISIX key-auth route /internal/quiz/*). app-ts is the AI orchestrator; the
 * quiz tables and Mongo question documents stay owned by app-quiz, so every
 * write goes through this M2M face (same pattern as app-pay membership).
 * Identity rides the X-Uid header (gateway-authenticated uid), never a
 * user-visible parameter. Fail-closed: storage errors propagate (quota 429
 * must reach the caller), unlike the app-bili scope fail-open.
 */

export interface AgentQuestionPayload {
  question: string;
  question_type?: string;
  difficulty?: string;
  options?: string[];
  answer?: string;
  correct_answer?: unknown;
  explanation: string;
  keywords?: string[];
  /** 来源溯源(知识库模式);free 模式为空 */
  bvid?: string;
  page_index?: number;
  page_title?: string;
  source_segment?: string;
  /** short_answer / essay 富字段 */
  answer_template?: string;
  scoring_rubric?: unknown;
  model_answer?: string;
}

export interface QuizSetCreateInput {
  title: string;
  difficulty?: string;
  questionCount?: number;
  typeDistribution?: Record<string, number>;
  folderIds?: number[];
  sourceType?: string;
  sourcePages?: Array<Record<string, unknown>>;
  chatSessionId?: string;
  status?: string;
  totalScore?: number;
  passingScore?: number;
}

export interface GradingPayload {
  set: {
    quiz_uuid: string;
    passing_score: number | null;
    total_score: number | null;
    status: string | null;
  };
  questions: Array<Record<string, unknown>>;
}

export interface GradedAnswerPayload {
  question_uuid: string;
  question_type: string;
  user_answer: unknown;
  user_answer_text: string | null;
  is_correct: boolean | null;
  auto_score: number | null;
  correct_answer_snapshot: unknown;
  matched_keywords?: unknown;
  keyword_match_rate?: number | null;
  grading_detail?: unknown;
}

export interface SubmissionPayload {
  quiz_uuid: string;
  total_question_count: number;
  passing_score: number | null;
  total_score: number;
  correct_count: number;
  passed: boolean | null;
  time_spent_seconds?: number | null;
  answers: GradedAnswerPayload[];
}

export interface WrongAnswerEntry {
  question_uuid: string;
  quiz_uuid: string;
  question_type: string;
  difficulty?: string | null;
  question_text: string;
  options?: unknown;
  user_answer?: unknown;
  correct_answer?: unknown;
  explanation?: string | null;
  times_wrong: number;
  last_attempt_at?: string | null;
}

export class AppQuizError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "AppQuizError";
  }
}

export class AppQuizClient extends InternalServiceClient {
  constructor(opts?: { baseUrl?: string; apiKey?: string; timeoutMs?: number }) {
    super(
      {
        baseUrl: opts?.baseUrl ?? config.appQuiz.baseUrl,
        apiKey: opts?.apiKey ?? config.appQuiz.apiKey,
        timeoutMs: opts?.timeoutMs ?? config.appQuiz.timeoutMs,
      },
      "app-quiz",
    );
  }

  protected override error(message: string, status?: number): Error {
    return new AppQuizError(message, status);
  }

  async createSet(uid: string, input: QuizSetCreateInput): Promise<{ quiz_uuid: string; question_count?: number }> {
    return this.post("/sets", uid, {
      uid,
      title: input.title,
      difficulty: input.difficulty,
      question_count: input.questionCount,
      type_distribution: input.typeDistribution,
      folder_ids: input.folderIds,
      source_type: input.sourceType,
      source_pages: input.sourcePages,
      chat_session_id: input.chatSessionId,
      status: input.status,
      total_score: input.totalScore,
      passing_score: input.passingScore,
    });
  }

  async finalizeSet(
    uid: string,
    quizUuid: string,
    questions: AgentQuestionPayload[],
    status: string,
    qualityMetrics?: unknown,
    bvidCount = 0,
  ): Promise<{ quiz_uuid: string; status: string; question_count: number }> {
    return this.post("/sets/" + encodeURIComponent(quizUuid) + "/questions", uid, {
      uid,
      status,
      questions,
      quality_metrics: qualityMetrics,
      bvid_count: bvidCount,
    });
  }

  /** Full question set (answers included) + set meta for the grader. */
  async gradingPayload(uid: string, quizUuid: string): Promise<GradingPayload> {
    return this.post("/grading", uid, { uid, quiz_uuid: quizUuid });
  }

  /** Persist a graded submission (+ per-answer rows); returns submission_uuid. */
  async createSubmission(uid: string, payload: SubmissionPayload): Promise<{ submission_uuid: string }> {
    return this.post("/submissions", uid, { uid, ...payload });
  }

  /** Peek the daily quota (429 AppQuizError when exhausted; fail-open when Redis is down). */
  async quotaPeek(uid: string, kind: "generate" | "grade"): Promise<void> {
    await this.post("/quota/peek", uid, { uid, kind });
  }

  /** Consume one daily quota slot (429 when the increment crosses the limit). */
  async quotaConsume(uid: string, kind: "generate" | "grade"): Promise<void> {
    await this.post("/quota/consume", uid, { uid, kind });
  }

  async failSet(uid: string, quizUuid: string, message: string): Promise<{ quiz_uuid: string; status: string }> {
    return this.post("/sets/" + encodeURIComponent(quizUuid) + "/fail", uid, {
      uid,
      error_message: message,
    });
  }

  /** 分批生成 checkpoint：把当前累计题目增量 upsert（仅 generating 行；幂等）。 */
  async appendQuestions(uid: string, quizUuid: string, questions: AgentQuestionPayload[]): Promise<void> {
    if (questions.length === 0) return;
    await this.post("/sets/" + encodeURIComponent(quizUuid) + "/questions/append", uid, { uid, questions });
  }

  /** Insert the generating quiz_task business row (duplicate task_id = idempotent OK). */
  async createTaskQuizRow(
    uid: string,
    body: {
      task_id: string;
      prompt: string;
      difficulty: string;
      question_count: number;
      user_email: string;
      cc_emails: string[];
      incomplete_message: string | null;
    },
  ): Promise<void> {
    await this.post("/tasks", uid, { uid, ...body });
  }

  /** generating → awaiting_answer + arm the deadline. */
  async markTaskQuizGenerated(uid: string, taskId: string, deadlineSeconds: number): Promise<void> {
    await this.post(`/tasks/${encodeURIComponent(taskId)}/generated`, uid, { deadline_seconds: deadlineSeconds });
  }

  /** Blindspot attribution signals: the user's answered questions + related entities. */
  async getQuizSignals(uid: string): Promise<{ signals: Array<{
    question_uuid: string;
    is_correct: boolean;
    question_text: string;
    related_entities: string[];
  }> }> {
    const res = await this.request("GET", "/quiz-signals", undefined, uid);
    return this.json(res, "app-quiz quiz-signals");
  }

  private async post<T>(path: string, uid: string, body: unknown): Promise<T> {
    try {
      const res = await this.request("POST", path, body, uid);
      return await this.json<T>(res, "app-quiz 调用失败");
    } catch (err) {
      if (err instanceof AppQuizError) throw err;
      throw new AppQuizError("app-quiz 调用失败: " + (err instanceof Error ? err.message : String(err)));
    }
  }

  /** User's wrong-answer notebook (error-profile driven quiz generation).
   * Most recent entries first; limit caps the slice server-side. */
  async wrongAnswers(uid: string, limit = 30): Promise<WrongAnswerEntry[]> {
    const res = await this.json<{ wrong_answers?: WrongAnswerEntry[]; total?: number }>(
      await this.request("GET", `/wrong-answers?limit=${limit}`, undefined, uid),
      "wrong-answers",
    );
    return res.wrong_answers ?? [];
  }
}
