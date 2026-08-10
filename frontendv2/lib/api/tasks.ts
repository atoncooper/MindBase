/**
 * Async tasks API - 异步任务（向量化 / ASR / 元数据提取 / 知识库构建）类型与标签.
 *
 * Task list/detail streaming is handled over WebSocket in the UI layer; this
 * file only owns the shared types and human-readable label helpers.
 */
export interface TaskStep {
    name: string;
    status: string;
    progress: number;
}

export interface TaskData {
    task_id: string;
    uid: number;
    task_type: string;       // vec_page / asr / arc_meta_extract / build
    target: unknown;
    status: string;           // pending / processing / done / failed
    progress: number;         // 0-100
    steps: TaskStep[] | null;
    result: unknown;
    error: string | null;
    created_at: string | null;
    updated_at: string | null;
    completed_at: string | null;
}

export interface WsTaskMessage {
    type: "tasks" | "task_detail" | "task_update" | "error";
    count?: number;
    tasks?: TaskData[];
    task?: TaskData;
    message?: string;
    timestamp?: number;
}

const TASK_TYPE_LABELS: Record<string, string> = {
    vec_page: "向量化",
    asr: "语音转文本",
    arc_meta_extract: "元数据提取",
    build: "知识库构建",
};

export function getTaskTypeLabel(type: string): string {
    return TASK_TYPE_LABELS[type] ?? type;
}

export function getTaskStatusLabel(status: string): string {
    return { pending: "等待中", processing: "处理中", done: "已完成", failed: "失败" }[status] ?? status;
}
