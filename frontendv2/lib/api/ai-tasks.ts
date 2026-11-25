import { getAuthHeaders, request } from "./client";

export type AiTaskKind = "news" | "literature" | "report" | "custom";
export type AiTaskStatus = "active" | "paused" | "completed";
export type AiTaskPriority = "low" | "normal" | "high";
export type AiTaskScheduleType = "once" | "daily" | "weekly" | "monthly";

export interface AiTaskSchedule {
    type: AiTaskScheduleType;
    timezone: string;
    time?: string;
    weekday?: number;
    dayOfMonth?: number;
    runAt?: number;
}

export interface AiTask {
    id: string;
    title: string;
    prompt: string;
    kind: AiTaskKind;
    schedule: AiTaskSchedule;
    scheduleLabel: string;
    status: AiTaskStatus;
    priority: AiTaskPriority;
    notifyEmail: boolean;
    notifyPush: boolean;
    academicProjectId?: string;
    nextRunAt?: number;
    lastRunAt?: number;
    lastRunStatus?: string;
    lastRunId?: string;
    lastError?: string;
    runCount: number;
    createdAt: number;
    updatedAt: number;
}

export interface AiTaskRun {
    id: string;
    taskId: string;
    status: string;
    scheduledFor: number;
    startedAt?: number;
    finishedAt?: number;
    lastHeartbeatAt?: number;
    cancelRequestedAt?: number;
    sessionId?: string;
    summary?: string;
    error?: string;
    content?: string;
    createdAt: number;
}

export interface AiTaskCreateInput {
    title: string;
    prompt: string;
    kind: AiTaskKind;
    schedule: AiTaskSchedule;
    priority?: AiTaskPriority;
    notifyEmail?: boolean;
    notifyPush?: boolean;
    academicProjectId?: string;
}

export const aiTaskApi = {
    list: () => request<{ tasks: AiTask[] }>("/ai-tasks", { headers: getAuthHeaders() }),

    get: (id: string) => request<AiTask>(`/ai-tasks/${encodeURIComponent(id)}`, { headers: getAuthHeaders() }),

    create: (body: AiTaskCreateInput) =>
        request<AiTask>("/ai-tasks", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...getAuthHeaders() },
            body: JSON.stringify(body),
        }),

    update: (id: string, body: Partial<AiTaskCreateInput>) =>
        request<AiTask>(`/ai-tasks/${encodeURIComponent(id)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", ...getAuthHeaders() },
            body: JSON.stringify(body),
        }),

    remove: (id: string) =>
        request<{ deleted: boolean }>(`/ai-tasks/${encodeURIComponent(id)}`, {
            method: "DELETE",
            headers: getAuthHeaders(),
        }),

    pause: (id: string) =>
        request<AiTask>(`/ai-tasks/${encodeURIComponent(id)}/pause`, {
            method: "POST",
            headers: getAuthHeaders(),
        }),

    resume: (id: string) =>
        request<AiTask>(`/ai-tasks/${encodeURIComponent(id)}/resume`, {
            method: "POST",
            headers: getAuthHeaders(),
        }),

    runNow: (id: string) =>
        request<{ runId: string; status: string }>(`/ai-tasks/${encodeURIComponent(id)}/run`, {
            method: "POST",
            headers: getAuthHeaders(),
        }),

    listRuns: (id: string, limit = 20) =>
        request<{ runs: AiTaskRun[] }>(
            `/ai-tasks/${encodeURIComponent(id)}/runs?limit=${limit}`,
            { headers: getAuthHeaders() },
        ),

    getRun: (runId: string) =>
        request<AiTaskRun>(`/ai-tasks/runs/${encodeURIComponent(runId)}`, {
            headers: getAuthHeaders(),
        }),

    cancelRun: (runId: string) =>
        request<AiTaskRun>(`/ai-tasks/runs/${encodeURIComponent(runId)}/cancel`, {
            method: "POST",
            headers: getAuthHeaders(),
        }),
};
