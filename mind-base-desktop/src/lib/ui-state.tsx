/**
 * Shared UI state helpers for per-item bootstrap outcomes.
 *
 * Every independently-loaded piece of data resolves into an [`ItemState`] so
 * one failing call only marks its own row ("读取失败") and never blanks its
 * siblings.
 */

import type { ReactNode } from "react";
import { toErrorMessage } from "./updater";

/** Per-item bootstrap outcome so one failure never blanks its siblings. */
export type ItemState<T> =
  | { status: "loading" }
  | { status: "ok"; value: T }
  | { status: "error" };

/** Outcome of a user action, rendered as an inline hint or error block. */
export type Feedback = { kind: "ok" | "error"; text: string } | null;

/** Collapse a settled promise into an independent row state. */
export function toItem<T>(result: PromiseSettledResult<T>): ItemState<T> {
  if (result.status === "fulfilled") return { status: "ok", value: result.value };
  // Keep a trace for diagnostics; the UI still degrades per row.
  console.warn("[bootstrap] failed to load status item", toErrorMessage(result.reason));
  return { status: "error" };
}

/** Render one bootstrap row; failures stay local to that row. */
export function itemValue<T>(item: ItemState<T>, render: (value: T) => ReactNode): ReactNode {
  switch (item.status) {
    case "ok":
      return render(item.value);
    case "loading":
      return "加载中…";
    case "error":
      return <span className="status status--error">读取失败</span>;
  }
}
