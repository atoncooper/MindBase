/**
 * Document IR (intermediate representation) for Word generation.
 *
 * The model (Content Engine) produces this structure; the Template Engine picks
 * a template; the DOCX renderer turns IR into real Word constructs (styles,
 * sections, fields, tables, drawings). Nothing here knows about OOXML, so the
 * same document can later be rendered to other formats or audited without a
 * round-trip through a .docx file.
 *
 * Rules:
 *  - every node is plain JSON (tool-schema friendly);
 *  - visual style is NOT part of the IR — it comes from the template;
 *  - caps are enforced twice (zod schema in the tool + validateDocumentIR).
 */

export type DocumentTemplateId =
  | "academic"
  | "business-plan"
  | "work-report"
  | "research-report"
  | "meeting-minutes"
  | "tech-design"
  | "resume"
  | "notice";

export const DOCUMENT_TEMPLATE_IDS: readonly DocumentTemplateId[] = [
  "academic",
  "business-plan",
  "work-report",
  "research-report",
  "meeting-minutes",
  "tech-design",
  "resume",
  "notice",
];

export type PageSize = "A4" | "A3" | "Letter";
export type PageOrientation = "portrait" | "landscape";

export interface PageSetup {
  size?: PageSize;
  orientation?: PageOrientation;
  /** Margins in centimetres; omitted fields fall back to the template. */
  margins?: { top?: number; right?: number; bottom?: number; left?: number };
  /** Multi-column layout for the section: 1 = single column (default), 2 = two columns. */
  columns?: 1 | 2;
}

export interface DocumentMeta {
  author?: string;
  organization?: string;
  /** Display date (e.g. "2026 年 11 月"); the renderer prints it as given. */
  date?: string;
  /** Document number / reference shown on the cover or header (公文文号). */
  docNo?: string;
  keywords?: string[];
  /** Abstract / executive summary paragraph rendered as a lead block on page 1. */
  abstract?: string;
}

export interface IRHeading {
  type: "heading";
  level: 1 | 2 | 3;
  text: string;
}

export interface IRParagraph {
  type: "paragraph";
  text: string;
  /** body = normal paragraph, lead = emphasised opening, note = small grey note. */
  style?: "body" | "lead" | "note";
  align?: "left" | "center" | "right" | "justify";
}

export interface IRLine {
  type: "line";
  text: string;
}

export interface IRList {
  type: "orderedList" | "unorderedList";
  items: string[];
}

export interface IRTable {
  type: "table";
  headers?: string[];
  rows: string[][];
  caption?: string;
  /** Relative column widths; omitted = estimated from content. */
  widths?: number[];
  align?: "center" | "left";
  fontSizePt?: number;
}

export interface IRImage {
  type: "image";
  /** Cloud-drive file id: the export service downloads the bytes and embeds them. */
  uploadUuid?: string;
  /** http(s) URL the service may download instead of a cloud file. */
  src?: string;
  caption?: string;
  widthCm?: number;
  align?: "center" | "left" | "right";
  alt?: string;
  /** Text wrapping: inline (default) or a floating block (square/topAndBottom). */
  wrap?: "inline" | "square" | "topAndBottom";
  /**
   * Text flow around a square-wrap drawing (wp:wrapSquare wrapText). Ignored for
   * inline/topAndBottom drawings.
   */
  wrapText?: "bothSides" | "largest" | "left" | "right";
  /**
   * Distance between the floating drawing and the surrounding text in centimetres
   * (wp:anchor distT/distB/distL/distR). Ignored for inline drawings.
   */
  distCm?: { top?: number; right?: number; bottom?: number; left?: number };
  /** Horizontal anchor for a floating drawing (default centre). */
  floatAlign?: "left" | "right";
  /** Outline drawn around the picture (a:ln); omitted = no border. */
  border?: { color: string; sizePt: number };
  /** Caption paragraph alignment; omitted = the Caption style default (centre). */
  captionAlign?: "left" | "center" | "right";
  /** Caption placement relative to the image (default below). */
  captionPosition?: "below" | "above";
}

export interface IRCaption {
  type: "caption";
  text: string;
}

export interface IRQuote {
  type: "quote";
  text: string;
  cite?: string;
}

export interface IRCodeBlock {
  type: "codeBlock";
  code: string;
  language?: string;
}

export interface IRFormula {
  type: "formula";
  /** Plain-text fallback shown when the expression cannot be parsed. */
  text: string;
  /** LaTeX subset (^{} _{ } \frac{}{} \sqrt{}) rendered as native OMML. */
  latex?: string;
}

/** Footnote: a reference mark in the flow plus the note text at the page bottom. */
export interface IRFootnote {
  type: "footnote";
  text: string;
}

/** Endnote: a reference mark in the flow, notes collected in word/endnotes.xml. */
export interface IREndnote {
  type: "endnote";
  text: string;
}

/** Cross-reference to the Nth captioned table/figure/heading/formula. */
export interface IRCrossRef {
  type: "crossReference";
  kind: "table" | "figure" | "heading" | "formula";
  /**
   * 1-based target index: the Nth captioned table/figure, the Nth heading in
   * document order, or the Nth formula block.
   */
  index: number;
  /** Optional surrounding text, default 见. */
  prefix?: string;
}

export interface IRReference {
  type: "reference";
  items: string[];
}

export interface IRToc {
  type: "toc";
}

export interface IRPageBreak {
  type: "pageBreak";
}

export interface IRSectionBreak {
  type: "sectionBreak";
  page?: PageSetup;
}

export interface IRDivider {
  type: "divider";
}

export interface IRCallout {
  type: "callout";
  text: string;
  title?: string;
  tone?: "info" | "warning" | "success";
}

export interface IRKv {
  type: "kv";
  items: Array<{ label: string; value: string }>;
  columns?: 1 | 2;
}

export interface IRMetrics {
  type: "metrics";
  items: Array<{ label: string; value: string; note?: string }>;
}

export type IRBlock =
  | IRHeading
  | IRParagraph
  | IRLine
  | IRList
  | IRTable
  | IRImage
  | IRCaption
  | IRQuote
  | IRCodeBlock
  | IRFormula
  | IRFootnote
  | IREndnote
  | IRCrossRef
  | IRReference
  | IRToc
  | IRPageBreak
  | IRSectionBreak
  | IRDivider
  | IRCallout
  | IRKv
  | IRMetrics;

export interface IRSection {
  blocks: IRBlock[];
  /** Optional section title; rendered as Heading 1 before the blocks. */
  heading?: string;
  page?: PageSetup;
}

export interface DocumentIR {
  version: 1;
  /** Template id (aliases like "report"/"proposal" are resolved by the registry). */
  template?: string;
  title: string;
  subtitle?: string;
  meta?: DocumentMeta;
  /** Running header text; "{title}" is substituted by the renderer. Defaults to the template. */
  header?: string;
  /** Footer text before the page number; defaults to the template. */
  footer?: string;
  /** Insert a TOC page after the cover (defaults to the template setting). */
  toc?: boolean;
  /** Render a cover page (defaults to the template setting). */
  cover?: boolean;
  /** Extra cover lines (e.g. from the legacy cover block): department, edition. */
  coverMeta?: string[];
  /** Page setup for the first/whole document (sections may override). */
  page?: PageSetup;
  /**
   * Footnote numbering across sections: "continuous" (Word default) or
   * "section" (restart every section; renders w:footnotePr/w:numRestart).
   * A template extension may also provide it (see renderDocument options).
   */
  footnoteRestart?: "continuous" | "section";
  /**
   * Caption numbering: "continuous" = 表 1 / 图 1 (default), "chapter" =
   * 表 {STYLEREF 1}-{SEQ * ARABIC s 1} (e.g. 表 2-1, 图 2-3).
   */
  captionNumbering?: "continuous" | "chapter";
  /** Diagonal text watermark drawn in the running header (VML, no image part). */
  watermark?: { text: string; opacity?: number };
  sections: IRSection[];
}

export const IR_LIMITS = {
  sections: 30,
  blocksPerSection: 200,
  blocksTotal: 900,
  tableRows: 400,
  tableCols: 10,
  imageBytes: 12 * 1024 * 1024,
  references: 120,
} as const;

/** Flat list of blocks (used by quality checks and renderers that ignore sections). */
export function flattenBlocks(doc: DocumentIR): IRBlock[] {
  return doc.sections.flatMap((section) => section.blocks);
}

export interface TocHeading {
  level: 1 | 2 | 3;
  text: string;
}

/**
 * Document-order headings for two-pass TOC rendering: the caller resolves page
 * numbers (e.g. by extracting them from a rendered PDF) and feeds the list back
 * through renderDocument({ tocEntries }). Section headings render as Heading 1.
 * Text is the authored heading text (Word generates the visible numbers itself).
 */
export function collectTocHeadings(doc: DocumentIR): TocHeading[] {
  const headings: TocHeading[] = [];
  for (const section of doc.sections) {
    if (section.heading !== undefined && section.heading.trim() !== "") {
      headings.push({ level: 1, text: section.heading.trim() });
    }
    for (const block of section.blocks) {
      if (block.type === "heading") headings.push({ level: block.level, text: block.text });
    }
  }
  return headings;
}

export type ValidationIssue = { path: string; message: string };

export class DocumentIRError extends Error {
  constructor(readonly issues: ValidationIssue[]) {
    super("文档结构不合法：" + issues.slice(0, 3).map((issue) => issue.path + " " + issue.message).join("；"));
    this.name = "DocumentIRError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(value: unknown, max: number, required = false): string | undefined {
  if (value === undefined || value === null) return required ? undefined : undefined;
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
  if (text === "") return undefined;
  return text.length > max ? text.slice(0, max) + "…" : text;
}

function stringList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => textOf(entry, max))
    .filter((entry): entry is string => entry !== undefined);
}

/** Validates + normalizes an untrusted IR payload (tool args or tests). */
export function validateDocumentIR(input: unknown): DocumentIR {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) throw new DocumentIRError([{ path: "$", message: "必须是对象" }]);

  const title = textOf(input.title, 300, true);
  if (!title) issues.push({ path: "title", message: "必须有文档标题" });

  const rawSections = Array.isArray(input.sections) ? input.sections : [];
  if (rawSections.length === 0) issues.push({ path: "sections", message: "至少需要一个章节" });
  if (rawSections.length > IR_LIMITS.sections) {
    issues.push({ path: "sections", message: "章节过多（上限 " + IR_LIMITS.sections + "）" });
  }

  const sections: IRSection[] = [];
  let blockCount = 0;
  rawSections.slice(0, IR_LIMITS.sections).forEach((rawSection, sectionIndex) => {
    if (!isRecord(rawSection)) {
      issues.push({ path: "sections[" + sectionIndex + "]", message: "必须是对象" });
      return;
    }
    const rawBlocks = Array.isArray(rawSection.blocks) ? rawSection.blocks : [];
    const blocks: IRBlock[] = [];
    rawBlocks.slice(0, IR_LIMITS.blocksPerSection).forEach((rawBlock, blockIndex) => {
      const path = "sections[" + sectionIndex + "].blocks[" + blockIndex + "]";
      const block = normalizeBlock(rawBlock, path, issues);
      if (!block) return;
      blocks.push(block);
      blockCount += 1;
    });
    if (blocks.length === 0) {
      issues.push({ path: "sections[" + sectionIndex + "]", message: "章节没有内容块" });
    }
    sections.push({
      blocks,
      ...(textOf(rawSection.heading, 200) ? { heading: textOf(rawSection.heading, 200) } : {}),
      ...(normalizePage(rawSection.page) ? { page: normalizePage(rawSection.page) } : {}),
    });
  });
  if (blockCount > IR_LIMITS.blocksTotal) {
    issues.push({ path: "sections", message: "内容块过多（上限 " + IR_LIMITS.blocksTotal + "）" });
  }

  const rawMeta = isRecord(input.meta) ? input.meta : {};
  const meta: DocumentMeta = {};
  const author = textOf(rawMeta.author, 120);
  if (author) meta.author = author;
  const organization = textOf(rawMeta.organization, 160);
  if (organization) meta.organization = organization;
  const date = textOf(rawMeta.date, 80);
  if (date) meta.date = date;
  const docNo = textOf(rawMeta.docNo, 80);
  if (docNo) meta.docNo = docNo;
  const keywords = stringList(rawMeta.keywords, 40).slice(0, 12);
  if (keywords.length > 0) meta.keywords = keywords;
  const abstract = textOf(rawMeta.abstract, 2000);
  if (abstract) meta.abstract = abstract;

  const watermark = normalizeWatermark(input.watermark, issues);
  if (issues.length > 0) throw new DocumentIRError(issues);

  return {
    version: 1,
    ...(textOf(input.template, 40) ? { template: textOf(input.template, 40) } : {}),
    title: title as string,
    ...(textOf(input.subtitle, 300) ? { subtitle: textOf(input.subtitle, 300) } : {}),
    ...(Object.keys(meta).length > 0 ? { meta } : {}),
    ...(textOf(input.header, 200) ? { header: textOf(input.header, 200) } : {}),
    ...(textOf(input.footer, 200) ? { footer: textOf(input.footer, 200) } : {}),
    ...(typeof input.toc === "boolean" ? { toc: input.toc } : {}),
    ...(typeof input.cover === "boolean" ? { cover: input.cover } : {}),
    ...(stringList(input.coverMeta, 120).length > 0 ? { coverMeta: stringList(input.coverMeta, 120).slice(0, 8) } : {}),
    ...(normalizePage(input.page) ? { page: normalizePage(input.page) } : {}),
    ...(input.footnoteRestart === "section"
      ? { footnoteRestart: "section" as const }
      : input.footnoteRestart === "continuous"
        ? { footnoteRestart: "continuous" as const }
        : {}),
    ...(input.captionNumbering === "chapter"
      ? { captionNumbering: "chapter" as const }
      : input.captionNumbering === "continuous"
        ? { captionNumbering: "continuous" as const }
        : {}),
    ...(watermark ? { watermark } : {}),
    sections,
  };
}

function normalizeWatermark(value: unknown, issues: ValidationIssue[]): DocumentIR["watermark"] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    issues.push({ path: "watermark", message: "水印必须是对象" });
    return undefined;
  }
  const text = textOf(value.text, 60, true);
  if (!text) {
    issues.push({ path: "watermark", message: "水印文字不能为空" });
    return undefined;
  }
  const opacity =
    typeof value.opacity === "number" && Number.isFinite(value.opacity)
      ? Math.min(1, Math.max(0.05, Math.round(value.opacity * 100) / 100))
      : undefined;
  return { text, ...(opacity !== undefined ? { opacity } : {}) };
}

function normalizeDistances(value: unknown): { top?: number; right?: number; bottom?: number; left?: number } | undefined {
  if (!isRecord(value)) return undefined;
  const dist: { top?: number; right?: number; bottom?: number; left?: number } = {};
  for (const key of ["top", "right", "bottom", "left"] as const) {
    const raw = value[key];
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 10) {
      dist[key] = Math.round(raw * 10) / 10;
    }
  }
  return Object.keys(dist).length > 0 ? dist : undefined;
}

function normalizeImageBorder(value: unknown): { color: string; sizePt: number } | undefined {
  if (!isRecord(value)) return undefined;
  const rawColor = typeof value.color === "string" ? value.color.trim().replace(/^#/, "") : "";
  if (!/^[0-9A-Fa-f]{6}$/.test(rawColor)) return undefined;
  const sizePt =
    typeof value.sizePt === "number" && Number.isFinite(value.sizePt) && value.sizePt >= 0.25 && value.sizePt <= 10
      ? Math.round(value.sizePt * 100) / 100
      : undefined;
  if (sizePt === undefined) return undefined;
  return { color: rawColor.toUpperCase(), sizePt };
}

function normalizePage(value: unknown): PageSetup | undefined {
  if (!isRecord(value)) return undefined;
  const page: PageSetup = {};
  if (value.size === "A4" || value.size === "A3" || value.size === "Letter") page.size = value.size;
  if (value.orientation === "portrait" || value.orientation === "landscape") page.orientation = value.orientation;
  if (isRecord(value.margins)) {
    const margins: NonNullable<PageSetup["margins"]> = {};
    for (const key of ["top", "right", "bottom", "left"] as const) {
      const raw = value.margins[key];
      if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0.5 && raw <= 8) margins[key] = Math.round(raw * 10) / 10;
    }
    if (Object.keys(margins).length > 0) page.margins = margins;
  }
  if (value.columns === 1 || value.columns === 2) page.columns = value.columns;
  return Object.keys(page).length > 0 ? page : undefined;
}

function normalizeBlock(raw: unknown, path: string, issues: ValidationIssue[]): IRBlock | undefined {
  if (!isRecord(raw)) {
    issues.push({ path, message: "必须是对象" });
    return undefined;
  }
  const type = raw.type;
  const add = (message: string): undefined => {
    issues.push({ path, message });
    return undefined;
  };
  switch (type) {
    case "heading": {
      const text = textOf(raw.text, 300, true);
      if (!text) return add("标题不能为空");
      const level = raw.level === 2 ? 2 : raw.level === 3 ? 3 : 1;
      return { type: "heading", level, text };
    }
    case "paragraph": {
      const text = textOf(raw.text, 6000, true);
      if (!text) return add("段落不能为空");
      const style = raw.style === "lead" || raw.style === "note" ? raw.style : "body";
      const align =
        raw.align === "center" || raw.align === "right" || raw.align === "justify" ? raw.align : undefined;
      return { type: "paragraph", text, style, ...(align ? { align } : {}) };
    }
    case "line": {
      const text = textOf(raw.text, 500, true);
      return text ? { type: "line", text } : add("信息行不能为空");
    }
    case "orderedList":
    case "unorderedList": {
      const items = stringList(raw.items, 1000).slice(0, 100);
      return items.length > 0 ? { type, items } : add("列表不能为空");
    }
    case "table": {
      const columns = Array.isArray(raw.headers) ? raw.headers.length : 0;
      const rows = Array.isArray(raw.rows)
        ? raw.rows
            .filter((row): row is unknown[] => Array.isArray(row))
            .slice(0, IR_LIMITS.tableRows)
            .map((row) =>
              row
                .slice(0, IR_LIMITS.tableCols)
                .map((cell) => (cell === null || cell === undefined ? "" : String(cell).slice(0, 2000))),
            )
        : [];
      if (rows.length === 0) return add("表格没有数据行");
      const widest = Math.max(columns, ...rows.map((row) => row.length));
      if (widest > IR_LIMITS.tableCols) return add("表格列数过多（上限 " + IR_LIMITS.tableCols + "）");
      const headers = Array.isArray(raw.headers) ? raw.headers.map((cell) => String(cell).slice(0, 200)) : [];
      const caption = textOf(raw.caption, 200);
      const widths = Array.isArray(raw.widths)
        ? raw.widths.filter((value): value is number => typeof value === "number" && value > 0).slice(0, widest)
        : [];
      const fontSizePt =
        typeof raw.fontSizePt === "number" && raw.fontSizePt >= 7 && raw.fontSizePt <= 14 ? raw.fontSizePt : undefined;
      return {
        type: "table",
        ...(headers.length > 0 ? { headers } : {}),
        rows,
        ...(caption ? { caption } : {}),
        ...(widths.length > 0 ? { widths } : {}),
        ...(raw.align === "left" ? { align: "left" as const } : {}),
        ...(fontSizePt ? { fontSizePt } : {}),
      };
    }
    case "image": {
      const uploadUuid = textOf(raw.uploadUuid, 200);
      const src = textOf(raw.src, 2000);
      if (!uploadUuid && !src) return add("图片需要 uploadUuid 或 src");
      const widthCm =
        typeof raw.widthCm === "number" && raw.widthCm >= 2 && raw.widthCm <= 18 ? raw.widthCm : undefined;
      const wrapText =
        raw.wrapText === "bothSides" || raw.wrapText === "largest" || raw.wrapText === "left" || raw.wrapText === "right"
          ? raw.wrapText
          : undefined;
      const distCm = normalizeDistances(raw.distCm);
      const floatAlign = raw.floatAlign === "left" || raw.floatAlign === "right" ? raw.floatAlign : undefined;
      const border = normalizeImageBorder(raw.border);
      const captionAlign =
        raw.captionAlign === "left" || raw.captionAlign === "center" || raw.captionAlign === "right"
          ? raw.captionAlign
          : undefined;
      return {
        type: "image",
        ...(uploadUuid ? { uploadUuid } : {}),
        ...(src ? { src } : {}),
        ...(textOf(raw.caption, 200) ? { caption: textOf(raw.caption, 200) } : {}),
        ...(widthCm ? { widthCm } : {}),
        ...(raw.align === "left" || raw.align === "right" ? { align: raw.align } : {}),
        ...(textOf(raw.alt, 300) ? { alt: textOf(raw.alt, 300) } : {}),
        ...(raw.wrap === "square" || raw.wrap === "topAndBottom" ? { wrap: raw.wrap } : {}),
        ...(raw.captionPosition === "above" ? { captionPosition: "above" as const } : {}),
        ...(wrapText ? { wrapText } : {}),
        ...(distCm ? { distCm } : {}),
        ...(floatAlign ? { floatAlign } : {}),
        ...(border ? { border } : {}),
        ...(captionAlign ? { captionAlign } : {}),
      };
    }
    case "caption": {
      const text = textOf(raw.text, 300, true);
      return text ? { type: "caption", text } : add("图注/表注不能为空");
    }
    case "quote": {
      const text = textOf(raw.text, 3000, true);
      if (!text) return add("引用不能为空");
      return { type: "quote", text, ...(textOf(raw.cite, 200) ? { cite: textOf(raw.cite, 200) } : {}) };
    }
    case "codeBlock": {
      const code = typeof raw.code === "string" ? raw.code.slice(0, 20_000) : "";
      if (code.trim() === "") return add("代码块不能为空");
      return { type: "codeBlock", code, ...(textOf(raw.language, 30) ? { language: textOf(raw.language, 30) } : {}) };
    }
    case "formula": {
      const text = textOf(raw.text, 2000, true);
      if (!text) return add("公式不能为空");
      return { type: "formula", text, ...(textOf(raw.latex, 2000) ? { latex: textOf(raw.latex, 2000) } : {}) };
    }
    case "footnote": {
      const text = textOf(raw.text, 2000, true);
      return text ? { type: "footnote", text } : add("脚注不能为空");
    }
    case "endnote": {
      const text = textOf(raw.text, 2000, true);
      return text ? { type: "endnote", text } : add("尾注不能为空");
    }
    case "crossReference": {
      const index = typeof raw.index === "number" && Number.isInteger(raw.index) && raw.index >= 1 && raw.index <= 500 ? raw.index : undefined;
      if (!index) return add("交叉引用需要 index（第几个表/图/标题/公式，从 1 开始）");
      const kind =
        raw.kind === "figure"
          ? "figure"
          : raw.kind === "heading"
            ? "heading"
            : raw.kind === "formula"
              ? "formula"
              : "table";
      return {
        type: "crossReference",
        kind,
        index,
        ...(textOf(raw.prefix, 20) ? { prefix: textOf(raw.prefix, 20) } : {}),
      };
    }
    case "reference": {
      const items = stringList(raw.items, 600).slice(0, IR_LIMITS.references);
      return items.length > 0 ? { type: "reference", items } : add("参考文献不能为空");
    }
    case "toc":
      return { type: "toc" };
    case "pageBreak":
      return { type: "pageBreak" };
    case "sectionBreak":
      return { type: "sectionBreak", ...(normalizePage(raw.page) ? { page: normalizePage(raw.page) } : {}) };
    case "divider":
      return { type: "divider" };
    case "callout": {
      const text = textOf(raw.text, 3000, true);
      if (!text) return add("提示框不能为空");
      return {
        type: "callout",
        text,
        ...(textOf(raw.title, 80) ? { title: textOf(raw.title, 80) } : {}),
        ...(raw.tone === "warning" || raw.tone === "success" ? { tone: raw.tone } : {}),
      };
    }
    case "kv": {
      const items = Array.isArray(raw.items)
        ? raw.items
            .filter(isRecord)
            .map((item) => ({ label: textOf(item.label, 40) ?? "", value: textOf(item.value, 500) ?? "" }))
            .filter((item) => item.label !== "" && item.value !== "")
            .slice(0, 24)
        : [];
      if (items.length === 0) return add("信息网格不能为空");
      return { type: "kv", items, ...(raw.columns === 1 ? { columns: 1 as const } : {}) };
    }
    case "metrics": {
      const items = Array.isArray(raw.items)
        ? raw.items
            .filter(isRecord)
            .map((item) => ({
              label: textOf(item.label, 40) ?? "",
              value: textOf(item.value, 40) ?? "",
              ...(textOf(item.note, 80) ? { note: textOf(item.note, 80) } : {}),
            }))
            .filter((item) => item.label !== "" && item.value !== "")
            .slice(0, 8)
        : [];
      if (items.length === 0) return add("指标卡不能为空");
      return { type: "metrics", items };
    }
    default:
      return add("未知的块类型：" + String(type));
  }
}

/** Concatenated plain text of the document (quality checks, previews). */
export function documentPlainText(doc: DocumentIR): string {
  const parts: string[] = [doc.title, doc.subtitle ?? ""];
  for (const section of doc.sections) {
    if (section.heading) parts.push(section.heading);
    for (const block of section.blocks) parts.push(blockText(block));
  }
  return parts.filter((part) => part.trim() !== "").join("\n");
}

function blockText(block: IRBlock): string {
  switch (block.type) {
    case "heading":
    case "paragraph":
    case "line":
    case "caption":
    case "quote":
    case "formula":
      return block.text;
    case "orderedList":
    case "unorderedList":
      return block.items.join("\n");
    case "table":
      return [block.caption ?? "", ...(block.headers ?? []), ...block.rows.map((row) => row.join(" | "))]
        .filter((part) => part !== "")
        .join("\n");
    case "image":
      return block.caption ?? block.alt ?? "";
    case "codeBlock":
      return block.code;
    case "reference":
      return block.items.join("\n");
    case "callout":
      return (block.title ? block.title + "：" : "") + block.text;
    case "footnote":
      return "[注] " + block.text;
    case "endnote":
      return "[尾注] " + block.text;
    case "crossReference": {
      const label =
        block.kind === "table" ? "表 " : block.kind === "figure" ? "图 " : block.kind === "heading" ? "标题 " : "公式 ";
      return (block.prefix ?? "见") + label + block.index;
    }
    case "kv":
      return block.items.map((item) => item.label + "：" + item.value).join("\n");
    case "metrics":
      return block.items.map((item) => item.label + "：" + item.value).join("\n");
    default:
      return "";
  }
}
