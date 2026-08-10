/**
 * ASR API - 分P 语音转文本：内容查询 / 发起（幂等）/ 手动编辑 / 重 ASR / 版本历史.
 */
import { request } from "./client";

export interface ASRContentResponse {
    exists: boolean;
    bvid?: string;
    cid?: number;
    page_index?: number;
    page_title?: string;
    content?: string;
    content_source?: "asr" | "user_edit";
    version?: number;
    is_processed?: boolean;
}

export interface ASRTaskStatus {
    task_id: string;
    status: "pending" | "processing" | "done" | "failed";
    progress: number;
    message: string;
}

export interface VideoPageVersionInfo {
    version: number;
    content_source: string;
    content_preview: string;
    is_latest: boolean;
    created_at: string;
}

// ASR 分P相关
export const asrApi = {
    // 查询 ASR 内容
    getContent: (bvid: string, cid: number) =>
        request<ASRContentResponse>(`/asr/content?bvid=${bvid}&cid=${cid}`),

    // 发起 ASR（幂等）
    create: (params: { bvid: string; cid: number; page_index: number; page_title?: string }) =>
        request<{ task_id: string | null; message: string; version?: number }>(
            "/asr/create",
            {
                method: "POST",
                body: JSON.stringify(params),
            }
        ),

    // 手动编辑更新
    update: (params: { bvid: string; cid: number; page_index: number; content: string }) =>
        request<{ success: boolean; message: string }>(
            "/asr/update",
            {
                method: "POST",
                body: JSON.stringify(params),
            }
        ),

    // 强制重新 ASR
    reasr: (params: { bvid: string; cid: number; page_index: number }) =>
        request<{ task_id: string; message: string }>(
            "/asr/reasr",
            {
                method: "POST",
                body: JSON.stringify(params),
            }
        ),

    // 轮询任务状态
    getStatus: (taskId: string) =>
        request<ASRTaskStatus>(`/asr/status/${taskId}`),

    // 查询版本历史
    getVersions: (bvid: string, cid: number) =>
        request<VideoPageVersionInfo[]>(`/asr/versions?bvid=${bvid}&cid=${cid}`),
};
