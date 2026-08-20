/**
 * Task-quiz API - 定时出题：注册任务 / 任务列表 / 详情 / 答题 / agent 对话.
 *
 * Three backends are involved (see CLAUDE.md §2.7):
 *  - Main app:  POST /task-quiz/register (form register), POST /task-quiz/chat (agent SSE),
 *               GET /tasks/{id}/detail + POST /tasks/{id}/answer (business detail & judging)
 *  - app-task:  GET /tasks (scheduler list), GET /tasks/{id} (scheduler view)
 * All routed through APISIX with bili_session Bearer auth; the caller does
 * NOT pass uid - identity comes from the session.
 *
 * Responses are snake_case from the backend and converted to camelCase here.
 */
import { requestCamel, getAuthHeaders, API_BASE_URL } from "./client";

/**
 * Two status vocabularies exist after the app-task decoupling:
 *  - Scheduler (app-task list /tasks): pending -> running -> completed | failed
 *  - Business (main app /tasks/{id}/detail): generating -> awaiting_answer ->
 *    completed, plus overdue / failed
 * The union covers both; which one you see depends on the endpoint.
 */
export type TaskQuizStatus =
    | "pending"         // scheduler: registered, waiting for trigger_time
    | "running"         // scheduler: executor dispatched
    | "generating"      // business: quiz being generated
    | "awaiting_answer" // business: quiz sent, waiting for answer (deadline armed)
    | "completed"
    | "overdue"         // business: deadline passed without answer
    | "failed";

export interface TaskQuizListItem {
    taskId: string;
    taskType: string;       // scheduler task type (e.g. "http")
    status: TaskQuizStatus; // scheduler view: pending/running/completed/failed
    triggerTime: string;
    executorUrl?: string;
    async?: boolean;
    /** Opaque payload passed through by the scheduler for display; quiz tasks
     *  carry prompt/difficulty/questionCount/ccEmails (never interpreted). */
    payload?: {
        prompt?: string;
        difficulty?: string;
        questionCount?: number;
        ccEmails?: string[];
    } | null;
}

export interface TaskQuizQuestion {
    question: string;
    questionType: string;            // choice / fill_blank / short_answer
    options: string[] | null;        // choice types only
    answer: string;                  // correct answer (choice text/letter, or fill-in text)
    difficulty: string;              // easy / medium / hard
    answerTimeLimitSeconds: number;
}

export interface TaskQuizAnswerItem {
    questionIndex: number;           // 0-based, 与 questions 数组下标对应
    answer: string;
    isCorrect: boolean;
    submittedAt: string;
}

export interface TaskQuizDetail {
    taskId: string;
    prompt: string;
    difficulty: string;              // easy / medium / hard
    status: TaskQuizStatus;          // business view: generating/awaiting_answer/completed/overdue/failed
    deadline: string | null;         // armed on send; countdown base (null before send)
    ccEmails: string[];
    /** Backend /detail has no trigger_time; only set on the client-side
     *  fallback detail synthesized from a list item (business row 404s
     *  before the trigger fires). Optional everywhere else. */
    triggerTime?: string | null;
    quiz: { questions: TaskQuizQuestion[] } | null;
    answers: TaskQuizAnswerItem[];   // 空数组 = 未作答
}

export interface RegisterTaskParams {
    prompt: string;
    triggerTime: string;             // ISO8601 UTC
    ccEmails: string[];
    incompleteMessage?: string | null;
    difficulty: string;              // easy / medium / hard
    questionCount: number;           // 1~5
}

export interface RegisterTaskResponse {
    taskId: string;
    status: string;
}

export interface SubmitAnswerItem {
    question_index: number; // wire format (snake_case)
    answer: string;
}

export interface SubmitAnswerResponse {
    status: string;
    isCorrect: boolean;
    results: { questionIndex: number; answer: string; isCorrect: boolean }[];
}

export interface TaskQuizStreamHandlers {
    onChunk?: (content: string) => void;
    onTool?: (e: { name: string; status: string; output?: string }) => void;
    onDone?: () => void;
    onError?: (msg: string) => void;
}

export const taskQuizApi = {
    /** Register a scheduled quiz task (main app /task-quiz/register -> app-task). */
    register: (params: RegisterTaskParams) =>
        requestCamel<RegisterTaskResponse>("/task-quiz/register", {
            method: "POST",
            body: JSON.stringify({
                prompt: params.prompt,
                trigger_time: params.triggerTime,
                cc_emails: params.ccEmails,
                incomplete_message: params.incompleteMessage ?? null,
                difficulty: params.difficulty,
                question_count: params.questionCount,
            }),
        }),

    /** List current user's scheduled quiz tasks. */
    listTasks: async (): Promise<TaskQuizListItem[]> => {
        const res = await requestCamel<{ tasks: TaskQuizListItem[] }>("/tasks");
        return res.tasks ?? [];
    },

    /**
     * Get the business detail (quiz + answers + business status) from the main
     * app. Note: the business row is only created at generation time, so this
     * 404s for tasks whose trigger time has not fired yet - callers should
     * fall back to a scheduled view built from the list item.
     */
    getTask: (taskId: string) =>
        requestCamel<TaskQuizDetail>(`/tasks/${taskId}/detail`),

    /** Submit answers for an awaiting_answer task (one entry per question, index 0-based). */
    submitAnswer: (taskId: string, answers: SubmitAnswerItem[]) =>
        requestCamel<SubmitAnswerResponse>(`/tasks/${taskId}/answer`, {
            method: "POST",
            body: JSON.stringify({ answers }),
        }),

    /**
     * Stream the task-quiz agent chat (SSE). Direct fetch to bypass the Next.js
     * dev proxy, which buffers SSE and collapses token streaming. Mirrors
     * chatApi.askStream's stream-base resolution.
     */
    streamChat: async (
        message: string,
        handlers: TaskQuizStreamHandlers,
        signal?: AbortSignal,
    ): Promise<void> => {
        // Use API_BASE_URL directly: browser "" (relative) -> nginx; SSR gets
        // http://nginx:80. Do NOT fall back to NEXT_PUBLIC_APISIX_HOST - in
        // docker prod it's the container name "nginx:80" which the browser
        // can't DNS-resolve. Mirrors chatApi.askStream's stream-base resolution.
        const streamBase = API_BASE_URL;

        const resp = await fetch(`${streamBase}/task-quiz/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...getAuthHeaders() },
            body: JSON.stringify({ message }),
            signal,
        });

        if (resp.status === 401) {
            if (typeof window !== "undefined") {
                localStorage.removeItem("bili_session");
                localStorage.removeItem("bili_user");
                window.dispatchEvent(new Event("auth:unauthorized"));
            }
            handlers.onError?.("会话已过期，请重新登录");
            return;
        }

        if (!resp.ok || !resp.body) {
            handlers.onError?.(`HTTP ${resp.status}`);
            return;
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split("\n\n");
            buf = lines.pop() || "";
            for (const line of lines) {
                const data = line.replace(/^data: /, "").trim();
                if (!data) continue;
                try {
                    const evt = JSON.parse(data);
                    if (evt.type === "chunk") handlers.onChunk?.(evt.content);
                    else if (evt.type === "tool") handlers.onTool?.(evt);
                    else if (evt.type === "done") handlers.onDone?.();
                    else if (evt.type === "error") handlers.onError?.(evt.message);
                } catch {
                    /* ignore malformed SSE frame */
                }
            }
        }
        handlers.onDone?.();
    },
};
