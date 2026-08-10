/**
 * Vector page API - 分P 向量化状态查询 / 触发（幂等）/ 重向量化 / 任务轮询.
 */
import { request } from "./client";

export interface VectorPageStatusResponse {
  exists: boolean;
  bvid?: string;
  cid?: number;
  page_index?: number;
  page_title?: string;
  is_processed: boolean;
  content_preview?: string;
  is_vectorized: "pending" | "processing" | "done" | "failed";
  vectorized_at?: string;
  vector_chunk_count: number;
  vector_error?: string;
}

export interface VectorPageTaskStatus {
  task_id: string;
  status: "pending" | "processing" | "done" | "failed";
  progress: number;
  message: string;
  result?: { chunk_count?: number };
  error?: string;
}

export const vecPageApi = {
  // 查询向量状态
  getStatus: (bvid: string, cid: number) =>
    request<VectorPageStatusResponse>(
      `/vec/page/status?bvid=${bvid}&cid=${cid}`
    ),

  // 发起向量化（幂等）
  create: (params: { bvid: string; cid: number; page_index: number; page_title?: string }) =>
    request<{ task_id: string | null; message: string }>(
      "/vec/page/create",
      {
        method: "POST",
        body: JSON.stringify(params),
      }
    ),

  // 强制重新向量化
  revector: (params: { bvid: string; cid: number }) =>
    request<{ task_id: string; message: string }>(
      "/vec/page/revector",
      {
        method: "POST",
        body: JSON.stringify(params),
      }
    ),

  // 轮询任务状态
  getTaskStatus: (taskId: string) =>
    request<VectorPageTaskStatus>(`/vec/page/status/${taskId}`),
};
