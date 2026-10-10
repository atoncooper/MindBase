/**
 * Knowledge API - 知识库构建 / 同步 / 统计 / 视频向量管理.
 *
 * 网关路由三分（Python 退役后无 catch_all 兜底）：
 *  - build / build/status / folders/sync → app-bili（bili_user）
 *  - stats / folders/status / pages/vectorized / clear / video/{bvid} → app-ts（vec_knowledge_ts）
 *  - /knowledge/kg/* → app-ts（kg_ts，见 kg.ts）
 */
import { request, getAuthHeaders } from "./client";

export interface BuildRequest {
    folder_ids: number[];
    exclude_bvids?: string[];
}

export interface BuildStatus {
    task_id: string;
    status: "pending" | "processing" | "running" | "done" | "completed" | "failed";
    progress: number;
    current_step: string;
    total_videos: number;
    processed_videos: number;
    message: string;
}

export interface FolderStatus {
    media_id: number;
    indexed_count: number;
    media_count?: number;
    last_sync_at?: string;
}

export interface SyncRequest {
    folder_ids?: number[];
}

export interface SyncResult {
    folder_id: number;
    total: number;
    added: number;
    removed: number;
    indexed: number;
    message: string;
    last_sync_at: string;
}

export interface KnowledgeStats {
    total_chunks: number;
    total_videos: number;
    collection_name: string;
}

export interface VectorizedPageItem {
    bvid: string;
    cid: number;
    page_index: number;
    page_title?: string;
    video_title?: string;
    vector_chunk_count: number;
    vectorized_at?: string;
}

export const knowledgeApi = {
    // 获取统计信息
    getStats: () => request<KnowledgeStats>("/knowledge/stats"),

    // 构建知识库（同步+ASR 编排在 app-bili）
    build: (data: BuildRequest) =>
        request<{ task_id: string; message: string }>("/knowledge/build", {
            headers: getAuthHeaders(),
            method: "POST",
            body: JSON.stringify(data),
        }),

    // 获取构建状态
    getBuildStatus: (taskId: string) =>
        request<BuildStatus>(`/knowledge/build/status/${taskId}`),

    // 获取收藏夹入库状态
    getFolderStatus: () =>
        request<FolderStatus[]>("/knowledge/folders/status", {
            headers: getAuthHeaders(),
        }),

    // 同步收藏夹到向量库（同步编排在 app-bili；ASR 完成后经 bili:page_ready
    // 事件由 app-ts 自动向量化）
    // 返回单个后台任务描述 { task_id, message, reused }，前端轮询 /knowledge/build/status/{task_id}
    syncFolders: (data: SyncRequest) =>
        request<{ task_id: string; message: string; reused?: boolean }>("/knowledge/folders/sync", {
            headers: getAuthHeaders(),
            method: "POST",
            body: JSON.stringify(data),
        }),

    // 清空知识库（admin；app-ts 向量账本 + Milvus）
    clear: () =>
        request<{ message: string }>("/knowledge/clear", { method: "DELETE" }),

    // 删除视频（向量数据；归属校验 + admin 旁路在 app-ts）
    deleteVideo: (bvid: string) =>
        request<{ message: string }>(`/knowledge/video/${bvid}`, { method: "DELETE" }),

    // 获取已向量化的分P列表（账本 = app-ts Mongo vec_pages）
    getVectorizedPages: () =>
        request<VectorizedPageItem[]>("/knowledge/pages/vectorized", {
            headers: getAuthHeaders(),
        }),
};
