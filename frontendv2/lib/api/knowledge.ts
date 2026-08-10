/**
 * Knowledge API - 知识库构建 / 同步 / 统计 / 视频向量管理.
 */
import { request, getAuthHeaders } from "./client";
import type { VideoPagesResponse } from "./favorites";

export interface BuildRequest {
    folder_ids: number[];
    exclude_bvids?: string[];
}

export interface BuildStatus {
    task_id: string;
    status: "pending" | "running" | "completed" | "failed";
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

    // 构建知识库 (v2: Bearer token auth via get_current_uid; session_id 是 v1 残留已移除)
    build: (data: BuildRequest) =>
        request<{ task_id: string; message: string }>("/knowledge/build", {
            headers: getAuthHeaders(),
            method: "POST",
            body: JSON.stringify(data),
        }),

    // 获取构建状态
    getBuildStatus: (taskId: string) =>
        request<BuildStatus>(`/knowledge/build/status/${taskId}`),

    // 获取收藏夹入库状态 (v2: Bearer token auth)
    getFolderStatus: () =>
        request<FolderStatus[]>("/knowledge/folders/status", {
            headers: getAuthHeaders(),
        }),

    // 同步收藏夹到向量库 (v2: Bearer token auth; session_id 已移除)
    syncFolders: (data: SyncRequest) =>
        request<SyncResult[]>("/knowledge/folders/sync", {
            headers: getAuthHeaders(),
            method: "POST",
            body: JSON.stringify(data),
        }),

    // 清空知识库
    clear: () =>
        request<{ message: string }>("/knowledge/clear", { method: "DELETE" }),

    // 删除视频
    deleteVideo: (bvid: string) =>
        request<{ message: string }>(`/knowledge/video/${bvid}`, { method: "DELETE" }),

    /** @deprecated Use favoritesV2Api.listVideoPages(bvid) */
    getVideoPages: (bvid: string) =>
        request<VideoPagesResponse>(`/knowledge/video/${bvid}/pages`),

    // 获取已向量化的分P列表 (v2: Bearer token auth)
    getVectorizedPages: () =>
        request<VectorizedPageItem[]>("/knowledge/pages/vectorized", {
            headers: getAuthHeaders(),
        }),
};
