/**
 * Typed access to the slides commands (`slides_*` on the Rust side).
 *
 * PPT agent：主题 → LLM 结构化大纲（标题/要点/讲者备注）→ python-pptx
 * sidecar 渲染为 .pptx。首次导出会按需安装 python-pptx 依赖。
 */

import { Channel, invoke } from "@tauri-apps/api/core";

/** One slide of the outline. */
export interface SlideDraft {
  title: string;
  bullets: string[];
  note: string;
}

/** A full deck outline. */
export interface SlidesOutline {
  title: string;
  subtitle: string;
  slides: SlideDraft[];
}

export interface SlidesOutlineRequest {
  topic: string;
  slideCount?: number;
  audience?: string;
  style?: string;
}

/** Progress pushed while the outline generates. */
export type SlidesGenEvent = { type: "outlining" };

/** Generate a deck outline for one topic. */
export function generateSlidesOutline(
  request: SlidesOutlineRequest,
  onEvent?: (event: SlidesGenEvent) => void,
): Promise<SlidesOutline> {
  const channel = new Channel<SlidesGenEvent>();
  if (onEvent !== undefined) channel.onmessage = onEvent;
  return invoke<SlidesOutline>("slides_outline", { request, onEvent: channel });
}

/** Render an outline to a .pptx file at the given path. */
export function exportSlides(outline: SlidesOutline, path: string): Promise<void> {
  return invoke<void>("slides_export", { request: { outline, path } });
}
