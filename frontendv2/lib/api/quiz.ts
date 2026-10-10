/**
 * Quiz API - 题目训练系统：出题 / 答题 / 历史 / 错题 / 导出 / 分享.
 */
import { request, getAuthHeaders, API_BASE_URL } from "./client";

export interface QuizGenerateParams {
    folder_ids?: number[];
    pages?: Array<{ bvid: string; cid: number; page_index: number; page_title?: string }>;
    question_count?: number;
    difficulty?: string;
    title?: string;
}

export interface QuizGenerateResponse {
    quiz_uuid: string;
    question_count: number;
    estimated_cost_tokens: number;
}

export interface QuizQuestion {
    question_uuid: string;
    question_type: string;
    difficulty: string;
    question_text: string;
    options?: string[];
    correct_answer?: string | string[];
    explanation?: string;
    keywords?: string[];
}

export interface QuizSetData {
    quiz_uuid: string;
    title: string;
    status: string;
    error_message?: string | null;
    question_count: number;
    type_distribution?: Record<string, number>;
    difficulty: string;
    total_score: number;
    passing_score: number;
    source_type?: string;
    source_pages?: Array<{ bvid: string; cid: number; page_index: number; page_title?: string }>;
    created_at: string;
    questions: QuizQuestion[];
}

export interface QuizAnswerItem {
    question_uuid: string;
    answer: string | string[];
}

export interface QuizAnswerResult {
    question_uuid: string;
    is_correct: boolean | null;
    auto_score: number | null;
    // 主观题（short_answer）自动批改不达标时置 true，等待人工复核
    needs_manual_grading?: boolean;
    correct_answer: string | string[];
    grading_note?: string;
}

export interface QuizSubmissionResult {
    submission_uuid: string;
    score: number | null;
    passed: boolean | null;
    correct_count: number;
    total_count: number;
    results: QuizAnswerResult[];
}

export interface QuizHistoryItem {
    submission_uuid: string | null;
    quiz_uuid: string;
    title: string;
    status?: string;
    error_message?: string | null;
    question_count?: number;
    difficulty?: string;
    source_type?: string;
    score: number | null;
    passed: boolean | null;
    correct_count: number;
    total_question_count: number;
    time_spent_seconds: number | null;
    submitted_at: string | null;
    created_at?: string;
}

export interface QuizHistoryResponse {
    submissions: QuizHistoryItem[];
    total: number;
    page: number;
    page_size: number;
    has_more: boolean;
}

export interface QuizDeleteResponse {
    deleted: boolean;
    quiz_uuid: string;
    deleted_questions: number;
    deleted_submissions: number;
    deleted_answers: number;
}

export interface WrongAnswerItem {
    question_uuid: string;
    quiz_uuid: string;
    question_type: string;
    question_text: string;
    options?: string[];
    user_answer: string | string[];
    correct_answer: string | string[];
    explanation?: string;
    times_wrong: number;
    last_attempt_at: string;
}

export interface WrongAnswerResponse {
    wrong_answers: WrongAnswerItem[];
    total: number;
}

export interface QuizShareResponse {
    quiz_uuid: string;
    share_token: string;
    shared_at: string | null;
    share_expires_at: string | null;
}

export interface QuizShareStatus {
    quiz_uuid: string;
    shared: boolean;
    share_token?: string;
    shared_at?: string | null;
    share_expires_at?: string | null;
    expired?: boolean;
}

export interface QuizShareRevokeResponse {
    quiz_uuid: string;
    shared: boolean;
}

export interface SharedQuizQuestion {
    question_uuid: string;
    question_type: string;
    difficulty: string;
    question_text: string;
    options?: string[] | Record<string, string>;
}

export interface SharedQuizData {
    quiz_uuid: string;
    title: string;
    question_count: number;
    type_distribution?: Record<string, number>;
    difficulty: string;
    total_score: number;
    passing_score: number;
    source_type?: string;
    shared_at: string | null;
    questions: SharedQuizQuestion[];
}

// Mongo 题目文档把 list 字段存成 JSON 字符串（Go 端原样透传），前端统一解析。
// 兼容两种形态：已是数组/对象的原样返回；字符串则尝试 JSON.parse。
function parseListField<T>(v: unknown): T | unknown {
    if (typeof v !== "string") return v;
    const s = v.trim();
    if (!(s.startsWith("[") || s.startsWith("{"))) return v;
    try {
        return JSON.parse(s) as unknown;
    } catch {
        return v;
    }
}

function normalizeQuizQuestions<T extends { options?: unknown; keywords?: unknown; correct_answer?: unknown }>(questions: T[]): T[] {
    return (questions ?? []).map((q) => ({
        ...q,
        options: parseListField(q.options) as T["options"],
        keywords: parseListField(q.keywords) as T["keywords"],
        correct_answer: parseListField(q.correct_answer),
    }));
}

export const quizApi = {
    generate: (params: Omit<QuizGenerateParams, "session_id">) => {
        const sp = new URLSearchParams();
        if (params.folder_ids?.length) sp.set("folder_ids", params.folder_ids.join(","));
        if (params.question_count) sp.set("question_count", String(params.question_count));
        if (params.difficulty) sp.set("difficulty", params.difficulty);
        if (params.title) sp.set("title", params.title);
        const body = params.pages?.length ? JSON.stringify(params.pages) : undefined;
        return request<QuizGenerateResponse>(`/quiz/generate?${sp.toString()}`, {
            method: "POST",
            headers: { ...getAuthHeaders(), ...(body ? { "Content-Type": "application/json" } : {}) },
            ...(body ? { body } : {}),
        });
    },

    // AI 出题(不依赖知识库):free = 围绕主题自由出题;wrong_answers = 读取错题
    // 本,针对薄弱点出由易到难的变式新题。
    generateAI: (params: {
        mode: "free" | "wrong_answers";
        topic?: string;
        question_count: number;
        difficulty?: string;
        title?: string;
    }) =>
        request<{ quiz_uuid: string; status: string }>("/quiz/generate-ai", {
            method: "POST",
            headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
            body: JSON.stringify(params),
        }),

    getQuiz: (quizUuid: string, includeAnswers = false) =>
        request<QuizSetData>(`/quiz/${quizUuid}${includeAnswers ? "?include_answers=true" : ""}`).then((q) => ({
            ...q,
            questions: normalizeQuizQuestions(q.questions ?? []),
        })),

    // 基于聊天会话总结出题（非定时）：复用持久化总结，无总结时后端自动生成
    generateFromSummary: (params: {
        chat_session_id: string;
        question_count: number;
        difficulty: string;
        title?: string;
    }) =>
        request<{ quiz_uuid: string; status: string }>("/quiz/generate-from-summary", {
            method: "POST",
            headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
            body: JSON.stringify(params),
        }),

    submit: (params: {
        quiz_uuid: string;
        answers: QuizAnswerItem[];
        time_spent_seconds?: number;
    }) =>
        request<QuizSubmissionResult>("/quiz/submit", {
            method: "POST",
            headers: getAuthHeaders(),
            body: JSON.stringify(params),
        }),

    getHistory: (page = 1, pageSize = 10) =>
        request<QuizHistoryResponse>(`/quiz/history?page=${page}&page_size=${pageSize}`, {
            headers: getAuthHeaders(),
        }),

    deleteQuiz: (quizUuid: string) =>
        request<QuizDeleteResponse>(`/quiz/${quizUuid}`, {
            method: "DELETE",
            headers: getAuthHeaders(),
        }),

    getWrongAnswers: (folderIds?: number[]) =>
        request<WrongAnswerResponse>(
            `/quiz/wrong-answers${folderIds?.length ? `?folder_ids=${folderIds.join(",")}` : ""}`,
            { headers: getAuthHeaders() }
        ),

    exportData: async (format: "jsonl" | "csv" | "sft" = "jsonl", folderIds?: number[]) => {
        const sp = new URLSearchParams();
        sp.set("format", format);
        if (folderIds?.length) sp.set("folder_ids", folderIds.join(","));
        const res = await fetch(`${API_BASE_URL}/quiz/export?${sp.toString()}`, {
            headers: getAuthHeaders(),
        });
        if (!res.ok) throw new Error("导出失败");
        return res.blob();
    },

    createShare: (quizUuid: string, expiresInDays?: number | null) =>
        request<QuizShareResponse>(`/quiz/${quizUuid}/share`, {
            method: "POST",
            headers: getAuthHeaders(),
            body: JSON.stringify(
                expiresInDays === undefined
                    ? {}
                    : { expires_in_days: expiresInDays ?? null }
            ),
        }),

    getShareStatus: (quizUuid: string) =>
        request<QuizShareStatus>(`/quiz/${quizUuid}/share`, {
            headers: getAuthHeaders(),
        }),

    revokeShare: (quizUuid: string) =>
        request<QuizShareRevokeResponse>(`/quiz/${quizUuid}/share`, {
            method: "DELETE",
            headers: getAuthHeaders(),
        }),

    getSharedQuiz: (shareToken: string) =>
        request<SharedQuizData>(`/quiz/shared/${encodeURIComponent(shareToken)}`).then((q) => ({
            ...q,
            questions: normalizeQuizQuestions(q.questions ?? []),
        })),
};
