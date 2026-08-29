/**
 * 本地 ASR 模型管理：状态查询与下载（对应 Rust `whisper_server.rs` 的
 * `local_asr_model_status` / `local_asr_model_download` 命令）。
 */

import { invoke } from "@tauri-apps/api/core";

/** 一个已知 whisper 模型的下载状态（前端每 ~1.5s 轮询一次）。 */
export interface LocalAsrModelStatus {
  /** 模型 id（tiny / base / small / medium / large-v3）。 */
  model: string;
  /** 展示标签（含速度/精度提示）。 */
  label: string;
  /** 近似完整下载体积（下载开始前用于展示）。 */
  approxSizeBytes: number;
  /** 本地目录（或旧版 HF 缓存快照）中已有完整模型。 */
  downloaded: boolean;
  /** 后台正在下载。 */
  downloading: boolean;
  /** 已下载字节（model.bin；仅 downloading 时有意义）。 */
  downloadedBytes: number;
  /** 总字节（model.bin Content-Length；未知为 0）。 */
  totalBytes: number;
  /** 上次下载失败的错误信息（可重试）。 */
  error: string | null;
}

/** 查询全部已知模型的状态。 */
export function getLocalAsrModelStatus(): Promise<LocalAsrModelStatus[]> {
  return invoke<LocalAsrModelStatus[]>("local_asr_model_status");
}

/** 启动一个模型的后台下载（已下载或在下载中时为无操作）。 */
export function downloadLocalAsrModel(model: string): Promise<void> {
  return invoke<void>("local_asr_model_download", { model });
}
