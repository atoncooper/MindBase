/**
 * Task-quiz API - 定时出题：注册任务 / 任务列表 / 详情 / 答题 / agent 对话.
 *
 * Two backends are involved (see CLAUDE.md §2.7):
 *  - Main app:  POST /task-quiz/register (form register), POST /task-quiz/chat (agent SSE)
 *  - app-task:  GET /tasks, GET /tasks/{id}, POST /tasks/{id}/answer (REST, X-Uid via APISIX)
 * Both are routed through APISIX with bili_session Bearer auth; the caller does
 * NOT pass uid - identity comes from the session.
 *
 * Responses are snake_case from the backend and converted to camelCase here.
 */
import { requestCamel, getAuthHeaders, API_BASE_URL } from "./client";

export type TaskQuizStatus =
    | "pending"      // registered, waiting for trigger_time
    | "sent"         // quiz generated + email sent, waiting for answer (deadline armed)
    | "completed"    // user answered
    | "overdue"      // deadline passed without answer
    | "failed";      // quiz generation failed

export interface TaskQuizListItem {
    taskId: string;
    prompt: string;
    status: TaskQuizStatus;
    triggerTime: string;
}

export interface TaskQuizQuestion {
    question: string;
    questionType: string;            // single_choice / multiple_choice / fill_blank / short_answer ...
    options: string[] | null;        // choice types only
    answer: string;                  // correct answer (choice index/text, or fill-in text)
    difficulty: string;              // easy / medium / hard
    answerTimeLimitSeconds: number;
}

export interface TaskQuizAnswer {
    answer: string;
    isCorrect: boolean;
    submittedAt: string;
}

export interface TaskQuizDetail {
    taskId: string;
    uid: number;
    prompt: string;
    status: TaskQuizStatus;
    triggerTime: string;
    ccEmails: string[];
    deadline?: string | null;        // armed on send; used for the answer countdown
    quiz: TaskQuizQuestion | null;
    answer: TaskQuizAnswer | null;
}

export interface RegisterTaskParams {
    prompt: string;
    triggerTime: string;             // ISO8601 UTC
    ccEmails: string[];
    incompleteMessage?: string | null;
    difficulty: string;              // easy / medium / hard
}

export interface RegisterTaskResponse {
    taskId: string;
    status: string;
}

export interface SubmitAnswerResponse {
    status: string;
    isCorrect: boolean;
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
            }),
        }),

    /** List current user's scheduled quiz tasks. */
    listTasks: async (): Promise<TaskQuizListItem[]> => {
        const res = await requestCamel<{ tasks: TaskQuizListItem[] }>("/tasks");
        return res.tasks ?? [];
    },

    /** Get task detail (task + quiz + answer). */
    getTask: (taskId: string) =>
        requestCamel<TaskQuizDetail>(`/tasks/${taskId}`),

    /** Submit answer for a sent task. */
    submitAnswer: (taskId: string, answer: string) =>
        requestCamel<SubmitAnswerResponse>(`/tasks/${taskId}/answer`, {
            method: "POST",
            body: JSON.stringify({ answer }),
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
