/**
 * 写作 tab 共用常量与纯函数（文档类型默认章节 / 文案 / 导出摘要）。
 */

import {
  DEFAULT_MANUSCRIPT_SECTIONS, MANUSCRIPT_DOCUMENT_KIND_LABELS,
  type DocxExport, type LatexExport,
} from "../../../lib/research";

/** 各文档类型的默认章节（新建时提交给后端；未知类型退化为自定义）。 */
export const DEFAULT_SECTIONS_BY_KIND: Record<string, readonly string[]> = {
  proposal: [
    "研究背景与意义", "国内外研究现状", "研究问题与目标", "研究内容与方法",
    "技术路线", "时间计划", "预期成果与创新点", "参考文献",
  ],
  plan: ["研究目标", "研究问题", "研究内容与方法", "技术路线", "里程碑", "风险与应对", "参考文献"],
  draft: DEFAULT_MANUSCRIPT_SECTIONS,
  revision: ["修改说明", "审稿意见回复", "修改后摘要", "修改后正文", "修改后参考文献"],
  cover_letter: ["投稿信正文", "作者与单位信息", "推荐审稿人"],
  custom: ["摘要", "正文", "参考文献"],
};

/** 某文档类型的默认章节（拷贝一份，避免调用方修改常量）。 */
export function defaultSections(kind: string): string[] {
  return [...(DEFAULT_SECTIONS_BY_KIND[kind] ?? DEFAULT_SECTIONS_BY_KIND.custom)];
}

/** 文档类型中文名（历史 / 未知类型原样显示）。 */
export function kindLabel(kind: string): string {
  return MANUSCRIPT_DOCUMENT_KIND_LABELS[kind] ?? kind;
}

/** 章节状态中文名。 */
export const STATUS_LABEL: Record<string, string> = {
  draft: "草稿", review: "待审", ready: "待审", final: "定稿", done: "已完成",
};

/** 导出摘要：N 个章节 · M 字。 */
export function describeExport(info: DocxExport | LatexExport): string {
  const parts: string[] = [];
  if (typeof info.sections === "number") parts.push(info.sections + " 个章节");
  if (typeof info.words === "number") parts.push(info.words + " 字");
  return parts.length > 0 ? parts.join(" · ") : "已导出";
}

/** 写作中栏视图模式。 */
export type WritingViewMode = "edit" | "split" | "preview";

/** 视图模式按钮（顺序即展示顺序）。 */
export const WRITING_VIEW_MODES: Array<{ id: WritingViewMode; label: string }> = [
  { id: "edit", label: "编辑" },
  { id: "split", label: "分栏" },
  { id: "preview", label: "预览" },
];

/** 右栏 / 阅读编辑里的 AI 动作（仍走主聊天 jumpToChat）。 */
export type WritingAiAction = "continue" | "polish" | "cite";

/** 正文字数（按字符数，与后端 chars().count() 口径一致）。 */
export function textLength(text: string): number {
  return [...text].length;
}

/** 段落数（以空行分隔的非空块）。 */
export function paragraphCount(text: string): number {
  return text.split(/\n\s*\n/).filter((block) => block.trim() !== "").length;
}

