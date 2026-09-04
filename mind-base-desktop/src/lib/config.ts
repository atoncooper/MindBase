/**
 * Typed access to the application configuration stored in SQLite
 * (exposed by the Rust `get_config` / `set_config` commands).
 */

import { invoke } from "@tauri-apps/api/core";

export interface AppConfig {
  /** UI theme: "system" | "light" | "dark". */
  theme: string;
  /** UI language, e.g. "zh-CN". */
  language: string;
  /** Whether to check for updates automatically on startup. */
  autoCheckUpdates: boolean;
  /** GitHub repo ("owner/name") used for update checks. */
  updateRepo: string;
  /** Optional explicit ffmpeg binary path; null = use PATH lookup. */
  ffmpegPathOverride: string | null;
  /** 对话默认提供方（"dashscope" | "deepseek" | "openrouter"）；null = 自动。 */
  defaultChatProvider?: string | null;
  /** 本地 faster-whisper-server（方案 A）设置。 */
  localAsr?: LocalAsrConfig;
  /** 本地 OCR（RapidOCR / PP-OCRv4）设置。 */
  localOcr?: LocalOcrConfig;
}

/** 本地 whisper 服务设置（与 Rust `LocalAsrConfig` 对齐）。服务由应用通过
 *  嵌入式 Python 自动管理（`scripts/whisper_server.py`），首次使用自动安装
 *  依赖并下载模型；应用启动时拉起、退出时停止。 */
export interface LocalAsrConfig {
  /** 启用后入库 ASR 走本地服务（无需云端 API Key）。 */
  enabled: boolean;
  /** 遗留字段：旧版的手动启动命令，后端已忽略并归一为空。 */
  command: string;
  /** 监听端口（默认 8765）。 */
  port: number;
  /** Whisper 模型名（small / medium / large-v3…，默认 small）。 */
  model: string;
  /** 追加的额外启动参数（空格分隔）。 */
  extraArgs: string;
  /** 等待服务就绪的超时（秒）。 */
  readyTimeoutSecs: number;
}

/** 本地 OCR 设置（与 Rust `LocalOcrConfig` 对齐）。模型包（det/rec/cls
 *  ONNX）在「API 设置 → 本地 OCR 模型」卡片中下载；推理接入由后续版本提供。 */export interface LocalOcrConfig {
  /** 启用后 OCR 工作负载优先走本地模型（当前版本先提供配置与模型管理）。 */
  enabled: boolean;
  /** 模型包 id（pp-ocrv4-mobile / pp-ocrv4-server）。 */
  model: string;
  /** 预留的额外启动参数。 */
  extraArgs: string;
  /** 计算设备：auto（检测到 GPU 则优先）/ cpu / cuda（需 onnxruntime-gpu + CUDA 环境）。 */
  device: string;
  /** 等待流水线就绪的超时（秒）。 */
  readyTimeoutSecs: number;
}

/** Fetch the persisted config (falls back to defaults on the Rust side). */
export async function getConfig(): Promise<AppConfig> {
  return invoke<AppConfig>("get_config");
}

/** Persist the given config and return the stored value. */
export async function setConfig(config: AppConfig): Promise<AppConfig> {
  return invoke<AppConfig>("set_config", { config });
}
