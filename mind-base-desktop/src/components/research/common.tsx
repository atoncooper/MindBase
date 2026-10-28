/**
 * 科研视图共用的纯工具函数（样式见 ./research.css，组件直接复用 App.css 的现有控件）。
 */

import type { KeyboardEvent } from "react";

/** 归一化任意 reject 值为可读中文（Rust 侧本身就是中文 String）。 */
export function errorText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** 秒级时间戳 → 本地日期；0 / null 显示为破折号。 */
export function formatDate(ts: number | null): string {
  if (ts === null || ts === 0) return "—";
  return new Date(ts * 1000).toLocaleDateString("zh-CN");
}

/** 秒级时间戳 → 本地日期时间。 */
export function formatDateTime(ts: number): string {
  if (ts <= 0) return "—";
  return new Date(ts * 1000).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 年份展示（缺失显示破折号）。 */
export function formatYear(year: number | null): string {
  return year === null ? "—" : String(year);
}

/** Tauri WebView 下剪贴板权限不稳，统一带 execCommand 兜底。 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 回退：临时 textarea + execCommand，兼容拒绝 clipboard 权限的 WebView。
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    document.body.removeChild(area);
    return ok;
  }
}

/**
 * 文本域的 Enter 发送语义：Enter 发送，Shift+Enter 换行。
 * （脚本编辑器不要用这个。）
 */
export function submitOnEnter(event: KeyboardEvent<HTMLTextAreaElement>, submit: () => void): void {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    submit();
  }
}
