/**
 * Typed access to the resume commands (`resume_*` on the Rust side).
 *
 * 简历 agent：全量聊天历史 → 分段事实提炼 → Markdown 简历。聊得越久，
 * 可提炼的事实越多，简历越详细——纯数据形状，无额外开关。
 */

import { Channel, invoke } from "@tauri-apps/api/core";

/** Progress pushed while a resume generates. */
export type ResumeGenEvent =
  | { type: "collecting"; messages: number }
  | { type: "extracting"; index: number; total: number }
  | { type: "writing" };

export interface ResumeGenerateRequest {
  /** Optional target role — shifts the resume's emphasis. */
  targetRole?: string;
}

/** Generate a resume from the full chat history; resolves to Markdown. */
export function generateResume(
  request: ResumeGenerateRequest,
  onEvent?: (event: ResumeGenEvent) => void,
): Promise<string> {
  const channel = new Channel<ResumeGenEvent>();
  if (onEvent !== undefined) channel.onmessage = onEvent;
  return invoke<string>("resume_generate", { request, onEvent: channel });
}

/** Write text content to a user-chosen path (export button). */
export function exportTextFile(path: string, contents: string): Promise<void> {
  return invoke<void>("export_text_file", { path, contents });
}
