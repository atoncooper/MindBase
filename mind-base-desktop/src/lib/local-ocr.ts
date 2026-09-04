/**
 * 本地 OCR 模型管理：状态查询与下载（对应 Rust `ocr_server.rs` 的
 * `local_ocr_model_status` / `local_ocr_model_download` 命令）。
 * 一个"模型"是一个 bundle：det + rec + cls 三个 ONNX 文件。
 */

import { invoke } from "@tauri-apps/api/core";

/** 一个已知 OCR 模型包的下载状态（前端每 ~2s 轮询一次）。 */
export interface LocalOcrModelStatus {
  /** 模型包 id（pp-ocrv4-mobile / pp-ocrv4-server）。 */
  model: string;
  /** 展示标签（含速度/精度提示）。 */
  label: string;
  /** 近似完整下载体积（下载开始前用于展示）。 */
  approxSizeBytes: number;
  /** 本地目录中已有完整模型包。 */
  downloaded: boolean;
  /** 后台正在下载。 */
  downloading: boolean;
  /** 已下载字节（rec.onnx；仅 downloading 时有意义）。 */
  downloadedBytes: number;
  /** 总字节（rec.onnx Content-Length；未知为 0）。 */
  totalBytes: number;
  /** 上次下载失败的错误信息（可重试）。 */
  error: string | null;
}

/** 查询全部已知模型包的状态。 */
export function getLocalOcrModelStatus(): Promise<LocalOcrModelStatus[]> {
  return invoke<LocalOcrModelStatus[]>("local_ocr_model_status");
}

/** 启动一个模型包的后台下载（已下载或在下载中时为无操作）。 */
export function downloadLocalOcrModel(model: string): Promise<void> {
  return invoke<void>("local_ocr_model_download", { model });
}
