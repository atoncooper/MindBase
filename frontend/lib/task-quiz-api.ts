/**
 * Task-quiz API: /task-quiz/chat (SSE) + /tasks/* (REST). Routed via APISIX.
 *
 * Auth: bili_session (Bearer) in Authorization header. APISIX forward-auth
 * validates it and injects X-Uid; callers do NOT pass uid in the request -
 * the identity comes from the session. /tasks/register is service-to-service
 * (agent -> app-task, key-auth) and is NOT called from the frontend.
 */
import { API_BASE_URL } from "@/lib/api";

function authHeaders(): Record<string, string> {
    if (typeof window === "undefined") return {};
    const token = localStorage.getItem("bili_session");
    // X-Requested-With lets next.config.ts beforeFiles rewrites route API fetches
    // to APISIX (bypassing /tasks/* /task-quiz/* page routes that return HTML).
    const h: Record<string, string> = { "X-Requested-With": "XMLHttpRequest" };
    if (token) h["Authorization"] = `Bearer ${token}`;
    return h;
}

export interface TaskListItem {
    task_id: string;
    prompt: string;
    status: string;
    trigger_time: string;
}

export interface TaskDetail {
    task_id: string;
    uid: number;
    prompt: string;
    status: string;
    trigger_time: string;
    cc_emails: string[];
    quiz: {
        question: string;
        question_type: string;
        options: string[] | null;
        answer: string;
        difficulty: string;
        answer_time_limit_seconds: number;
    } | null;
    answer: { answer: string; is_correct: boolean; submitted_at: string } | null;
}

/** Stream the task-quiz agent chat (SSE). uid resolved by APISIX from session. */
export async function streamTaskQuizChat(
    message: string,
    onChunk: (content: string) => void,
    onTool?: (e: { name: string; status: string; output?: string }) => void,
    onDone?: () => void,
    onError?: (msg: string) => void,
): Promise<void> {
    const resp = await fetch(`${API_BASE_URL}/task-quiz/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ message }),
    });
    if (!resp.ok || !resp.body) {
        onError?.(`HTTP ${resp.status}`);
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
                if (evt.type === "chunk") onChunk(evt.content);
                else if (evt.type === "tool") onTool?.(evt);
                else if (evt.type === "done") onDone?.();
                else if (evt.type === "error") onError?.(evt.message);
            } catch {
                /* ignore malformed */
            }
        }
    }
}

/** Register a scheduled quiz task (user-facing; main app /task-quiz/register forwards to app-task). */
export async function registerTask(
    prompt: string,
    triggerTime: string, // ISO8601 UTC
    ccEmails: string[],
    incompleteMessage?: string,
    difficulty: string = "medium", // easy/medium/hard
): Promise<{ task_id: string; status: string }> {
    const resp = await fetch(`${API_BASE_URL}/task-quiz/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
            prompt,
            trigger_time: triggerTime,
            cc_emails: ccEmails,
            incomplete_message: incompleteMessage || null,
            difficulty,
        }),
    });
    if (!resp.ok) throw new Error(`register failed: ${resp.status}`);
    return resp.json();
}

/** List current user's tasks (uid from APISIX X-Uid). */
export async function listTasks(): Promise<TaskListItem[]> {
    const resp = await fetch(`${API_BASE_URL}/tasks`, { headers: authHeaders() });
    if (!resp.ok) throw new Error(`list failed: ${resp.status}`);
    const data = await resp.json();
    return data.tasks;
}

/** Get task detail (uid from APISIX X-Uid). */
export async function getTask(taskId: string): Promise<TaskDetail> {
    const resp = await fetch(`${API_BASE_URL}/tasks/${taskId}`, {
        headers: authHeaders(),
    });
    if (!resp.ok) throw new Error(`get failed: ${resp.status}`);
    return resp.json();
}

/** Submit answer (uid from APISIX X-Uid). */
export async function submitAnswer(
    taskId: string,
    answer: string,
): Promise<{ status: string; is_correct: boolean }> {
    const resp = await fetch(`${API_BASE_URL}/tasks/${taskId}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ answer }),
    });
    if (!resp.ok) throw new Error(`submit failed: ${resp.status}`);
    return resp.json();
}
