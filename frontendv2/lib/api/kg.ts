/**
 * Knowledge Graph API - 知识图谱构建 / 统计（Plan 1.0.5）.
 *
 * 后端契约见 app/routers/knowledge.py 的 KG 段；前端设计见 plan/1.0.5-KnowledgeGraph/frontend-design.md.
 */
import { request } from "./client";

export type KgTaskStatus =
    | "pending"
    | "processing"
    | "running"
    | "done"
    | "completed"
    | "failed";

export interface KgGraphStats {
    entities: number;
    relations: number;
    evidence: number;
    videos: number;
}

export interface KgStats {
    available: boolean;
    graph: KgGraphStats;
    entity_vectors: number;
    pending_pages: number;
}

export interface KgBuildStart {
    task_id: string;
    reused: boolean;
}

export interface KgActiveTask {
    task_id: string | null;
}

export interface KgBuildStatus {
    task_id: string;
    status: KgTaskStatus;
    progress: number;
    current_step: string;
    /** 完成时 {total, ok, failed} 或 {total: 0, message}；进行中为 {} */
    result: Record<string, unknown>;
    error: string;
}

export const kgApi = {
    // 图谱统计（Neo4j 计数 + 待抽取分P数）
    getStats: () => request<KgStats>("/knowledge/kg/stats"),

    // 触发构建（folder_ids 为空数组 = 用户全部收藏夹）；已有活跃任务时复用其 task_id
    build: (folderIds: number[]) =>
        request<KgBuildStart>("/knowledge/kg/build", {
            method: "POST",
            body: JSON.stringify({ folder_ids: folderIds }),
        }),

    // 探测活跃任务（刷新页面后恢复轮询）
    getActiveTask: () => request<KgActiveTask>("/knowledge/kg/active"),

    // 轮询构建状态
    getStatus: (taskId: string) =>
        request<KgBuildStatus>(`/knowledge/kg/status/${taskId}`),
};
