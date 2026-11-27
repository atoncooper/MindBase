import type { DocumentIR, IRBlock } from "./ir.js";
import type { DocTemplate } from "./templates.js";
import { checkDocumentQuality, type QualityReport } from "./content-quality.js";

/**
 * Structural (render-free) document audit.
 *
 * LibreOffice is only needed for pixel-level/visual checks. This module inspects
 * the Document IR + template *before* rendering and catches the issues that do
 * not need a rasterizer: hierarchy jumps, missing captions, tables that will
 * overflow/wrap badly, images wider than the text column, implausible page
 * estimates, missing cover/TOC for the selected genre, unsafe page margins and
 * content-quality findings. It runs in the slim image (no Office packages) and
 * is used by office_export as a generation-time self-check.
 */

export interface StructuralFinding {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  location?: string;
}

export interface StructuralAudit {
  score: number;
  estimatedPages: number;
  findings: StructuralFinding[];
  content: QualityReport;
}

const PAGE_HEIGHT_PT = 842; // A4 portrait in points; refined from the template margins
const PAGE_WIDTH_PT = 595;

function textLength(text: string): number {
  let length = 0;
  for (const ch of text) length += ch.charCodeAt(0) > 0x2e80 ? 2 : 1;
  return length;
}

function blocksOf(doc: DocumentIR): Array<{ block: IRBlock; path: string }> {
  return doc.sections.flatMap((section, sectionIndex) =>
    section.blocks.map((block, blockIndex) => ({ block, path: "sections[" + sectionIndex + "].blocks[" + blockIndex + "]" })),
  );
}

/** Rough page estimate: usable area / (avg char area * line factor). */
function estimatePages(doc: DocumentIR, template: DocTemplate): number {
  const page = template.page;
  const usableWidthPt = (11906 - page.margins.left - page.margins.right) / 20;
  const usableHeightPt = (16838 - page.margins.top - page.margins.bottom) / 20;
  const fontSize = template.typography.bodySizePt;
  const charsPerLine = Math.max(18, Math.floor(usableWidthPt / (fontSize * 0.95)));
  const lineHeight = template.typography.lineRule === "exact" ? template.typography.lineTwips / 20 : fontSize * 1.5;
  const linesPerPage = Math.max(10, Math.floor(usableHeightPt / lineHeight));

  let lines = 0;
  for (const { block } of blocksOf(doc)) {
    switch (block.type) {
      case "paragraph":
        lines += Math.ceil(textLength(block.text) / charsPerLine) + 0.5;
        break;
      case "heading":
        lines += block.level === 1 ? 3 : 2;
        break;
      case "line":
        lines += 1;
        break;
      case "orderedList":
      case "unorderedList":
        for (const item of block.items) lines += Math.ceil(textLength(item) / charsPerLine);
        break;
      case "table":
        lines += (block.rows.length + (block.headers ? 1 : 0) + 1) * 1.2;
        break;
      case "kv":
        lines += Math.ceil(block.items.length / (block.columns === 1 ? 1 : 2));
        break;
      case "metrics":
        lines += 5;
        break;
      case "callout":
        lines += 3;
        break;
      case "codeBlock":
        lines += block.code.split("\n").length + 1;
        break;
      case "image":
        lines += 12;
        break;
      case "reference":
        lines += block.items.length;
        break;
      case "quote":
        lines += Math.ceil(textLength(block.text) / charsPerLine) + 1;
        break;
      default:
        lines += 1;
    }
  }
  const overhead = doc.cover !== false && template.cover.enabled ? 1 : 0;
  const toc = doc.toc !== undefined ? doc.toc : template.toc.enabled;
  return Math.max(1, Math.ceil(lines / linesPerPage) + overhead + (toc ? 1 : 0));
}

function add(findings: StructuralFinding[], severity: StructuralFinding["severity"], code: string, message: string, location?: string): void {
  findings.push({ code, severity, message, ...(location ? { location } : {}) });
}

/** Runs the render-free audit. Never throws for ordinary content issues. */
export function auditDocumentStructure(doc: DocumentIR, template: DocTemplate): StructuralAudit {
  const findings: StructuralFinding[] = [];
  const blocks = blocksOf(doc);
  const content = checkDocumentQuality(doc, { templateId: template.id });

  // --- cover / toc expectations -------------------------------------------------
  const coverEnabled = doc.cover ?? template.cover.enabled;
  if (coverEnabled) {
    if (!doc.meta?.author && !doc.meta?.organization && !doc.meta?.date) {
      add(findings, "info", "cover_sparse", "封面只有标题：建议补充作者/单位/日期，避免封面显得空。", "cover");
    }
    if (doc.title.length > 40) {
      add(findings, "info", "cover_title_long", "封面标题超过 40 字，可能折行；建议压缩到 25 字以内。", "title");
    }
  } else if (template.category !== "work" && template.id !== "resume" && template.id !== "notice") {
    add(findings, "info", "cover_missing", "该模板通常带封面，但文档未生成封面。", "cover");
  }
  const tocEnabled = doc.toc ?? template.toc.enabled;
  if (tocEnabled) {
    if (doc.sections.length < 3) {
      add(findings, "info", "toc_thin", "只有 " + doc.sections.length + " 个章节，目录价值有限。", "toc");
    }
  } else if (doc.sections.length >= 7) {
    add(findings, "warning", "toc_recommended", "文档有 " + doc.sections.length + " 个章节但没有目录，建议开启 toc。", "toc");
  }

  // --- heading hierarchy ---------------------------------------------------------
  // A section title is rendered as Heading 1 by the renderer, so it participates
  // in the hierarchy exactly like an explicit heading block.
  const headings: Array<{ level: 1 | 2 | 3; text: string; path: string }> = [];
  doc.sections.forEach((section, sectionIndex) => {
    if (section.heading) headings.push({ level: 1, text: section.heading, path: "sections[" + sectionIndex + "].heading" });
    section.blocks.forEach((block, blockIndex) => {
      if (block.type === "heading") {
        headings.push({ level: block.level, text: block.text, path: "sections[" + sectionIndex + "].blocks[" + blockIndex + "]" });
      }
    });
  });
  let previousLevel = 0;
  let h1 = 0;
  for (const heading of headings) {
    if (heading.level === 1) h1 += 1;
    if (previousLevel > 0 && heading.level > previousLevel + 1) {
      add(findings, "error", "heading_level_jump", "标题层级跳跃：上一级是 H" + previousLevel + "，这里直接到 H" + heading.level + "。", heading.path);
    }
    previousLevel = heading.level;
    if (textLength(heading.text) > 60) {
      add(findings, "info", "heading_long", "标题过长（约 " + textLength(heading.text) + " 字），可能折行。", heading.path);
    }
  }
  if (h1 === 0) add(findings, "warning", "no_h1", "没有任何一级标题，文档结构不完整。");
  if (h1 === 1 && doc.sections.length >= 5) {
    add(findings, "warning", "single_h1", "只有 1 个一级标题但章节较多，建议每个主要部分用一级标题。");
  }

  // --- tables -------------------------------------------------------------------
  let tableIndex = 0;
  for (const { block, path } of blocks) {
    if (block.type !== "table") continue;
    tableIndex += 1;
    const columns = Math.max(block.headers?.length ?? 0, ...block.rows.map((row) => row.length));
    if (!block.caption) add(findings, "warning", "table_no_caption", "表 " + tableIndex + " 没有表题，正式文档应写「表 N xxx」。", path);
    if (columns > 6) add(findings, "warning", "table_wide", "表 " + tableIndex + " 有 " + columns + " 列，超出 A4 可读宽度（建议 ≤6 列）。", path);
    if (block.rows.length > 40) add(findings, "info", "table_tall", "表 " + tableIndex + " 有 " + block.rows.length + " 行，跨页时表头会重复但仍可能难读。", path);
    for (const row of block.rows) {
      for (const cell of row) {
        if (textLength(cell) > 120) {
          add(findings, "info", "table_cell_long", "表 " + tableIndex + " 存在超长单元格（>120 字），建议拆成段落或换行。", path);
          break;
        }
      }
    }
    const widths = block.widths;
    if (widths && widths.some((width) => width <= 0)) {
      add(findings, "error", "table_bad_widths", "表 " + tableIndex + " 的列宽包含非正数。", path);
    }
  }

  // --- images -------------------------------------------------------------------
  const page = template.page;
  const contentWidthCm = (11906 - page.margins.left - page.margins.right) / 567;
  let imageIndex = 0;
  for (const { block, path } of blocks) {
    if (block.type !== "image") continue;
    imageIndex += 1;
    if (!block.caption) add(findings, "warning", "image_no_caption", "图 " + imageIndex + " 没有图注。", path);
    if (!block.alt) add(findings, "info", "image_no_alt", "图 " + imageIndex + " 缺少 alt 文本（无障碍/替换文字）。", path);
    if (block.widthCm && block.widthCm > contentWidthCm) {
      add(findings, "error", "image_too_wide", "图 " + imageIndex + " 宽度 " + block.widthCm + "cm 超过正文宽度 " + contentWidthCm.toFixed(1) + "cm。", path);
    }
  }

  // --- page setup ---------------------------------------------------------------
  const margins = { ...page.margins, ...(doc.page?.margins ? doc.page.margins : {}) };
  for (const [side, cm] of Object.entries(doc.page?.margins ?? {})) {
    if (typeof cm !== "number") continue;
    if (cm < 1) add(findings, "warning", "margin_tight", side + " 边距仅 " + cm + "cm，打印/装订会裁切。", "page.margins." + side);
    if (cm > 5) add(findings, "info", "margin_wide", side + " 边距 " + cm + "cm，正文区域偏小。", "page.margins." + side);
  }
  void margins;

  // --- code blocks --------------------------------------------------------------
  let codeIndex = 0;
  for (const { block, path } of blocks) {
    if (block.type !== "codeBlock") continue;
    codeIndex += 1;
    const lines = block.code.split("\n");
    if (lines.length > 60) add(findings, "warning", "code_too_long", "代码块 " + codeIndex + " 超过 60 行，建议拆分并加说明。", path);
    if (lines.some((line) => line.length > 120)) {
      add(findings, "info", "code_long_line", "代码块 " + codeIndex + " 有超过 120 字符的长行，渲染会折行。", path);
    }
  }

  // --- genre expectations -------------------------------------------------------
  const headingsText = headings.map((heading) => heading.text).join(" ");
  if (template.id === "academic" && !/方法|实验|结论|结果/.test(headingsText + doc.title)) {
    add(findings, "warning", "academic_structure", "学术报告缺少「方法/实验/结果/结论」类章节。");
  }
  if (template.id === "business-plan" && !/风险|预算|实施|计划/.test(headingsText + doc.title)) {
    add(findings, "warning", "business_structure", "商业方案缺少「实施/预算/风险」类章节。");
  }
  if (template.id === "meeting-minutes") {
    const hasTodo = /待办|责任人|下一步|行动项/.test(headingsText);
    if (!hasTodo) add(findings, "warning", "minutes_no_actions", "会议纪要缺少待办/责任人等行动项章节。");
  }
  if (template.id === "notice") {
    const hasRequirement = /要求|事项|时间/.test(headingsText + doc.sections.map((section) => section.blocks.map((block) => ("text" in block ? block.text : "")).join(" ")).join(" "));
    if (!hasRequirement) add(findings, "warning", "notice_no_requirement", "通知缺少事项/时间/要求等内容。");
  }

  // --- content quality ----------------------------------------------------------
  for (const finding of content.findings) {
    findings.push({
      code: "content:" + finding.code,
      severity: finding.severity,
      message: finding.message,
      ...(finding.sectionIndex !== undefined ? { location: "sections[" + finding.sectionIndex + "]" } : {}),
    });
  }

  const penalty = findings.reduce(
    (sum, finding) => sum + (finding.severity === "error" ? 12 : finding.severity === "warning" ? 4 : 1),
    0,
  );
  return {
    score: Math.max(0, 100 - penalty),
    estimatedPages: estimatePages(doc, template),
    findings,
    content,
  };
}

/** Chinese one-screen summary for tool results / CLI reports. */
export function renderStructuralAudit(audit: StructuralAudit): string {
  const lines: string[] = [];
  lines.push("结构自检：" + audit.score + "/100，预估 " + audit.estimatedPages + " 页");
  const errors = audit.findings.filter((finding) => finding.severity === "error");
  const warnings = audit.findings.filter((finding) => finding.severity === "warning");
  const infos = audit.findings.filter((finding) => finding.severity === "info");
  for (const finding of [...errors, ...warnings].slice(0, 10)) {
    lines.push("- [" + finding.severity + "] " + finding.message + (finding.location ? "（" + finding.location + "）" : ""));
  }
  if (errors.length === 0 && warnings.length === 0) lines.push("- 未发现结构性问题。");
  if (infos.length > 0) lines.push("- 另有 " + infos.length + " 条提示（建议项）。");
  if (audit.content.score < 70) lines.push("- 内容质量分 " + audit.content.score + "/100，建议先修订套话/重复/空心段落。");
  return lines.join("\n");
}
