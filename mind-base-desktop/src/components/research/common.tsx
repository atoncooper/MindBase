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

/** 秒级时间戳 → 本地「MM-DD HH:mm:ss」（最近动态精确到秒）。 */
export function formatDateTimeSeconds(ts: number): string {
  if (ts <= 0) return "—";
  const date = new Date(ts * 1000);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " "
    + pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds())
  );
}

/** 秒级时间戳 → 本地「MM-DD HH:mm」（时间区间展示用）。 */
function formatDateTimeMinute(ts: number): string {
  if (ts <= 0) return "—";
  const date = new Date(ts * 1000);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " "
    + pad(date.getHours()) + ":" + pad(date.getMinutes())
  );
}

/**
 * 「最近动态」时间文案。
 *
 * - 折叠分组跨度 < 60 秒（含单条事件 firstTs == ts）：显示精确到秒；
 * - 跨度 ≥ 60 秒：显示「最早时间 – 最新时间」区间；
 * - firstTs 缺失 / 非法（旧后端）时退化为 ts，保证不出现 NaN。
 */
export function formatActivityTime(ts: number, firstTs: number): string {
  const start = Number.isFinite(firstTs) && firstTs > 0 ? firstTs : ts;
  if (start >= ts || ts - start < 60) return formatDateTimeSeconds(ts);
  return formatDateTimeMinute(start) + " – " + formatDateTimeMinute(ts);
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
 * 文本域自适应高度：内容变高时撑开（上限由 CSS 的 max-height 兜住）。
 * 用法：onInput={(event) => autoGrowTextarea(event.currentTarget)}
 */
export function autoGrowTextarea(element: HTMLTextAreaElement): void {
  element.style.height = "auto";
  element.style.height = element.scrollHeight + "px";
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
