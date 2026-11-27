import type { DocumentTemplateId, PageOrientation, PageSetup, PageSize } from "./ir.js";

/**
 * Template Registry for Word generation.
 *
 * A template owns everything visual: page geometry, typography, heading
 * hierarchy, cover, running header/footer, TOC rules, table chrome, heading
 * numbering and list glyphs. The Content Engine only produces IR; the DOCX
 * renderer maps IR onto these specs — no visual constants live in prompts or in
 * the renderer switch statements.
 *
 * Priority (see resolveTemplate): user .docx template (handled by the export
 * service) > explicit template id / style alias > keyword inference from the
 * request > default professional template (work-report).
 */

export interface PageSpec {
  size: PageSize;
  orientation: PageOrientation;
  /** Twips (1cm = 567 twips). */
  margins: { top: number; right: number; bottom: number; left: number };
  headerDistance: number;
  footerDistance: number;
}

export interface TypographySpec {
  bodyFontEastAsia: string;
  bodyFontAscii: string;
  /** Points; the renderer converts to half-points. */
  bodySizePt: number;
  /** "auto" = multiple line spacing (lineTwips is 240ths of a line), "exact" = twips. */
  lineRule: "auto" | "exact";
  lineTwips: number;
  indentChars: number;
  paragraphAfterPt: number;
  justify: boolean;
  headingFontEastAsia: string;
  headingSizesPt: { h1: number; h2: number; h3: number };
  headingColors: { h1: string; h2: string; h3: string };
  headingBold: boolean;
  headingRule: boolean;
  titleSizePt: number;
  subtitleSizePt: number;
  captionSizePt: number;
  tableSizePt: number;
  accentColor: string;
}

export interface CoverSpec {
  enabled: boolean;
  variant: "center" | "banner" | "plain";
  titleSizePt: number;
  subtitleSizePt: number;
  metaSizePt: number;
  spaceBeforeTwips: number;
  rule: boolean;
}

export interface HeaderFooterSpec {
  /** Header text; tokens {title} {docNo} {date} are substituted. Empty = no header. */
  headerText: string;
  headerRule: boolean;
  headerSizePt: number;
  /** Footer text before the page number; empty = page number only. */
  footerText: string;
  pageNumber: "center" | "right" | "left";
  /** Outer wrapper for official-document footers, e.g. "— {page} —". */
  pageNumberFormat: "plain" | "dash";
  /** Append " / 共 N 页" after the page number. */
  pageTotal: boolean;
  footerSizePt: number;
}

export interface TocSpec {
  enabled: boolean;
  depth: 1 | 2 | 3;
  title: string;
}

export interface TableSpec {
  headerFill: string;
  headerColor: string;
  borderColor: string;
  headerBold: boolean;
  fontSizePt: number;
}

export interface NumberingSpec {
  /** chapter-cn = 一、/（一）/1.; decimal = 1/1.1/1.1.1; none = as written. */
  style: "chapter-cn" | "decimal" | "none";
}

/**
 * Optional per-deployment brand. Loaded from the external template override JSON
 * (see template-overrides.ts) and deliberately not consumed by the renderer yet:
 * drawing the logo and recolouring the accent is a follow-up task, but the
 * registry already carries it so callers/tools can report branding.
 */
export interface TemplateBrand {
  /** Cloud-drive uploadUuid of the brand logo. */
  logoUploadUuid?: string;
  /** Primary brand colour as 6-digit hex without "#"; overrides typography.accentColor. */
  primaryColor?: string;
}

export interface DocTemplate {
  id: DocumentTemplateId;
  label: string;
  description: string;
  category: "academic" | "business" | "work" | "general";
  aliases: string[];
  keywords: string[];
  page: PageSpec;
  typography: TypographySpec;
  cover: CoverSpec;
  headerFooter: HeaderFooterSpec;
  toc: TocSpec;
  table: TableSpec;
  numbering: NumberingSpec;
  listGlyph: "dot" | "dash" | "square";
  /** Deployment brand injected by template override JSON (absent = built-in palette). */
  brand?: TemplateBrand;
}

function page(
  marginsCm: { top: number; right: number; bottom: number; left: number },
  extra: Partial<PageSpec> = {},
): PageSpec {
  const cm = (value: number): number => Math.round(value * 567);
  return {
    size: "A4",
    orientation: "portrait",
    margins: {
      top: cm(marginsCm.top),
      right: cm(marginsCm.right),
      bottom: cm(marginsCm.bottom),
      left: cm(marginsCm.left),
    },
    headerDistance: 720,
    footerDistance: 720,
    ...extra,
  };
}

function typography(overrides: Partial<TypographySpec>): TypographySpec {
  return {
    bodyFontEastAsia: "宋体",
    bodyFontAscii: "Times New Roman",
    bodySizePt: 12,
    lineRule: "auto",
    lineTwips: 360,
    indentChars: 200,
    paragraphAfterPt: 0,
    justify: true,
    headingFontEastAsia: "黑体",
    headingSizesPt: { h1: 16, h2: 14, h3: 12 },
    headingColors: { h1: "1F2937", h2: "374151", h3: "374151" },
    headingBold: true,
    headingRule: true,
    titleSizePt: 22,
    subtitleSizePt: 14,
    captionSizePt: 10.5,
    tableSizePt: 10.5,
    accentColor: "1F2937",
    ...overrides,
  };
}

function headerFooter(overrides: Partial<HeaderFooterSpec>): HeaderFooterSpec {
  return {
    headerText: "{title}",
    headerRule: true,
    headerSizePt: 9,
    footerText: "",
    pageNumber: "center",
    pageNumberFormat: "plain",
    pageTotal: true,
    footerSizePt: 9,
    ...overrides,
  };
}

const DEFAULT_TABLE: TableSpec = {
  headerFill: "F2F3F5",
  headerColor: "1F2937",
  borderColor: "D9D9D9",
  headerBold: true,
  fontSizePt: 10.5,
};

const DEFAULT_COVER: CoverSpec = {
  enabled: true,
  variant: "center",
  titleSizePt: 26,
  subtitleSizePt: 14,
  metaSizePt: 11,
  spaceBeforeTwips: 2400,
  rule: true,
};

export const DOC_TEMPLATES: Record<DocumentTemplateId, DocTemplate> = {
  academic: {
    id: "academic",
    label: "学术论文 / 科研报告",
    description: "严谨的学术版式：封面、摘要、分级标题、图表题注、参考文献、目录、页眉页脚与页码。",
    category: "academic",
    aliases: ["paper", "academic-paper", "thesis", "论文", "学术", "科研报告", "科研"],
    keywords: ["论文", "学术", "研究", "实验", "文献", "综述", "thesis", "paper", "研究假设", "实证"],
    page: page({ top: 2.54, right: 2.5, bottom: 2.54, left: 3.0 }),
    typography: typography({
      headingSizesPt: { h1: 16, h2: 14, h3: 12 },
      headingRule: true,
      titleSizePt: 22,
      accentColor: "1F2937",
    }),
    cover: { ...DEFAULT_COVER, variant: "center" },
    headerFooter: headerFooter({ headerText: "{title}", pageNumber: "center" }),
    toc: { enabled: true, depth: 2, title: "目录" },
    table: { ...DEFAULT_TABLE, headerFill: "F2F3F5" },
    numbering: { style: "decimal" },
    listGlyph: "dot",
  },
  "business-plan": {
    id: "business-plan",
    label: "商业计划书 / 项目方案",
    description: "商务版式：深蓝强调色、封面、执行摘要、方案对比表、实施路径、风险与预算。",
    category: "business",
    aliases: ["proposal", "business", "plan", "项目方案", "方案", "商业计划书", "计划书"],
    keywords: ["商业计划", "方案", "项目", "预算", "融资", "市场", "商业模式", "实施路径", "proposal"],
    page: page({ top: 2.54, right: 2.2, bottom: 2.54, left: 3.0 }),
    typography: typography({
      bodySizePt: 11,
      lineTwips: 340,
      headingSizesPt: { h1: 16, h2: 14, h3: 12 },
      headingColors: { h1: "1F4E79", h2: "1F4E79", h3: "2E5C8A" },
      headingRule: true,
      accentColor: "1F4E79",
      tableSizePt: 10.5,
    }),
    cover: { ...DEFAULT_COVER, variant: "banner", titleSizePt: 28, subtitleSizePt: 15 },
    headerFooter: headerFooter({ headerText: "{title}", pageNumber: "right" }),
    toc: { enabled: true, depth: 2, title: "目录" },
    table: { ...DEFAULT_TABLE, headerFill: "DEEAF6", headerColor: "1F4E79" },
    numbering: { style: "decimal" },
    listGlyph: "dot",
  },
  "work-report": {
    id: "work-report",
    label: "企业工作报告 / 总结",
    description: "标准企业报告版式：中性标题层级、数据表、要点列表、页码页脚。默认模板。",
    category: "work",
    aliases: ["report", "summary", "工作报告", "总结", "汇报"],
    keywords: ["报告", "总结", "复盘", "汇报", "季度", "年度", "工作总结", "经营分析"],
    page: page({ top: 2.54, right: 2.2, bottom: 2.54, left: 2.8 }),
    typography: typography({ bodySizePt: 12, headingRule: true }),
    cover: { ...DEFAULT_COVER, variant: "center" },
    headerFooter: headerFooter({ pageNumber: "center" }),
    toc: { enabled: false, depth: 2, title: "目录" },
    table: { ...DEFAULT_TABLE },
    numbering: { style: "chapter-cn" },
    listGlyph: "dot",
  },
  "research-report": {
    id: "research-report",
    label: "社会调研报告",
    description: "调研版式：背景、对象与方法、调研发现、数据分析、结论与建议；突出图表与数据来源。",
    category: "academic",
    aliases: ["survey", "research", "调研报告", "调研", "社会调查"],
    keywords: ["调研", "调查", "问卷", "访谈", "样本", "走访", "社会", "研究", "数据分析"],
    page: page({ top: 2.54, right: 2.4, bottom: 2.54, left: 2.8 }),
    typography: typography({
      bodySizePt: 12,
      headingSizePt: undefined,
      headingSizesPt: { h1: 15, h2: 13.5, h3: 12 },
      accentColor: "1F4E79",
    } as Partial<TypographySpec>),
    cover: { ...DEFAULT_COVER, variant: "center" },
    headerFooter: headerFooter({ headerText: "{title}", pageNumber: "center" }),
    toc: { enabled: true, depth: 2, title: "目录" },
    table: { ...DEFAULT_TABLE, headerFill: "E8EEF5" },
    numbering: { style: "chapter-cn" },
    listGlyph: "dot",
  },
  "meeting-minutes": {
    id: "meeting-minutes",
    label: "会议纪要",
    description: "纪要版式：会议信息网格、议题与结论、待办事项（责任人/时间），紧凑行距、无封面。",
    category: "work",
    aliases: ["minutes", "meeting", "会议纪要", "纪要"],
    keywords: ["会议纪要", "会议", "纪要", "议题", "参会", "待办", "决议", "周会", "评审会"],
    page: page({ top: 2.2, right: 2.2, bottom: 2.2, left: 2.6 }),
    typography: typography({
      bodySizePt: 11,
      lineTwips: 320,
      indentChars: 0,
      headingSizesPt: { h1: 14, h2: 12.5, h3: 11 },
      headingRule: true,
      titleSizePt: 18,
      accentColor: "1F2937",
    }),
    cover: { ...DEFAULT_COVER, enabled: false },
    headerFooter: headerFooter({ headerText: "会议纪要", pageNumber: "center" }),
    toc: { enabled: false, depth: 2, title: "目录" },
    table: { ...DEFAULT_TABLE, headerFill: "E7E6E6" },
    numbering: { style: "none" },
    listGlyph: "dot",
  },
  "tech-design": {
    id: "tech-design",
    label: "技术设计文档",
    description: "技术版式：十进制多级标题（1 / 1.1 / 1.1.1）、代码块、接口与部署章节、目录与页码。",
    category: "general",
    aliases: ["tech", "design", "technical-design", "技术设计", "设计文档", "技术方案"],
    keywords: ["技术设计", "技术方案", "架构", "接口", "部署", "数据库设计", "API", "系统设计", "模块设计"],
    page: page({ top: 2.54, right: 2.54, bottom: 2.54, left: 2.54 }),
    typography: typography({
      bodySizePt: 10.5,
      lineTwips: 320,
      indentChars: 0,
      headingSizesPt: { h1: 15, h2: 13, h3: 11.5 },
      headingRule: true,
      accentColor: "1F4E79",
    }),
    cover: { ...DEFAULT_COVER, variant: "center", titleSizePt: 24 },
    headerFooter: headerFooter({ headerText: "{title} · 技术设计", pageNumber: "right" }),
    toc: { enabled: true, depth: 3, title: "目录" },
    table: { ...DEFAULT_TABLE, headerFill: "E8EEF5" },
    numbering: { style: "decimal" },
    listGlyph: "dot",
  },
  resume: {
    id: "resume",
    label: "简历 / 个人介绍",
    description: "简历版式：窄边距、紧凑字号、信息行与信息网格、经历时间线，单页到两页。",
    category: "general",
    aliases: ["cv", "resume", "简历", "个人介绍"],
    keywords: ["简历", "求职", "应聘", "个人介绍", "resume", "cv"],
    page: page({ top: 1.9, right: 2.0, bottom: 1.9, left: 2.0 }),
    typography: typography({
      bodySizePt: 10.5,
      lineTwips: 300,
      indentChars: 0,
      paragraphAfterPt: 3,
      justify: false,
      headingSizesPt: { h1: 14, h2: 12, h3: 10.5 },
      headingRule: true,
      titleSizePt: 18,
      captionSizePt: 9,
      tableSizePt: 9.5,
      accentColor: "1F2937",
    }),
    cover: { ...DEFAULT_COVER, enabled: false, titleSizePt: 18 },
    headerFooter: headerFooter({ headerText: "", headerRule: false, pageNumber: "center", pageTotal: false, footerSizePt: 8 }),
    toc: { enabled: false, depth: 1, title: "目录" },
    table: { ...DEFAULT_TABLE, headerFill: "F2F3F5", fontSizePt: 9.5 },
    numbering: { style: "none" },
    listGlyph: "dot",
  },
  notice: {
    id: "notice",
    label: "正式通知 / 公文",
    description: "公文版式：仿宋正文、规范页边距、居中标题、页脚页码，无封面无目录。",
    category: "work",
    aliases: ["brief", "notice", "official", "通知", "公文", "公告", "通报"],
    keywords: ["通知", "公告", "通报", "公文", "函", "决定", "请示", "批复"],
    page: page({ top: 3.7, right: 2.6, bottom: 3.5, left: 2.8 }),
    typography: typography({
      bodyFontEastAsia: "仿宋",
      bodySizePt: 16,
      lineRule: "exact",
      lineTwips: 560,
      indentChars: 200,
      paragraphAfterPt: 0,
      headingSizesPt: { h1: 16, h2: 16, h3: 16 },
      headingColors: { h1: "000000", h2: "000000", h3: "000000" },
      headingRule: false,
      titleSizePt: 22,
      subtitleSizePt: 14,
      captionSizePt: 12,
      tableSizePt: 12,
      accentColor: "000000",
    }),
    cover: { ...DEFAULT_COVER, enabled: false, variant: "plain", titleSizePt: 22 },
    headerFooter: headerFooter({
      headerText: "",
      headerRule: false,
      pageNumber: "center",
      pageNumberFormat: "dash",
      pageTotal: false,
      footerSizePt: 10.5,
    }),
    toc: { enabled: false, depth: 1, title: "目录" },
    table: { ...DEFAULT_TABLE, headerFill: "F2F2F2", fontSizePt: 12 },
    numbering: { style: "chapter-cn" },
    listGlyph: "dot",
  },
};

/**
 * Resolved view over a template set: the built-ins, or the built-ins with a
 * deployment's JSON overrides applied (see template-overrides.ts). Keeping the
 * index next to the templates means an override that changes a label or adds an
 * alias is immediately resolvable by id/label/alias.
 */
export interface DocTemplateRegistry {
  templates: Record<DocumentTemplateId, DocTemplate>;
  /** Lower-case template id / label / alias -> template id. */
  aliasIndex: ReadonlyMap<string, DocumentTemplateId>;
}

/** Builds the id/label/alias index for a template set (last definition wins). */
export function createTemplateRegistry(
  templates: Record<DocumentTemplateId, DocTemplate>,
): DocTemplateRegistry {
  const aliasIndex = new Map<string, DocumentTemplateId>();
  for (const template of Object.values(templates)) {
    aliasIndex.set(template.id, template.id);
    aliasIndex.set(template.label.toLowerCase(), template.id);
    for (const alias of template.aliases) aliasIndex.set(alias.toLowerCase(), template.id);
  }
  return { templates, aliasIndex };
}

/** Built-in registry used when no override JSON has been loaded. */
export const DEFAULT_TEMPLATE_REGISTRY: DocTemplateRegistry = createTemplateRegistry(DOC_TEMPLATES);

export function getDocTemplate(
  id: string | undefined,
  registry: DocTemplateRegistry = DEFAULT_TEMPLATE_REGISTRY,
): DocTemplate {
  const fallback = registry.templates["work-report"];
  if (!id) return fallback;
  return registry.templates[registry.aliasIndex.get(id.trim().toLowerCase()) ?? "work-report"] ?? fallback;
}

export function isTemplateId(value: string): value is DocumentTemplateId {
  return (DOC_TEMPLATES as Record<string, DocTemplate>)[value] !== undefined;
}

function keywordScore(text: string, template: DocTemplate): number {
  const haystack = text.toLowerCase();
  let score = 0;
  for (const keyword of template.keywords) {
    if (haystack.includes(keyword.toLowerCase())) score += keyword.length >= 3 ? 2 : 1;
  }
  for (const alias of template.aliases) {
    if (haystack.includes(alias.toLowerCase())) score += 1;
  }
  return score;
}

/** Infers a template from free text (request brief or title). */
export function matchTemplateByText(
  text: string,
  registry: DocTemplateRegistry = DEFAULT_TEMPLATE_REGISTRY,
): DocumentTemplateId | undefined {
  if (!text.trim()) return undefined;
  let best: { id: DocumentTemplateId; score: number } | undefined;
  for (const template of Object.values(registry.templates)) {
    const score = keywordScore(text, template);
    if (score > 0 && (!best || score > best.score)) best = { id: template.id, score };
  }
  return best?.id;
}

export interface TemplateResolution {
  template: DocTemplate;
  /** Why this template was chosen (logs + tool result). */
  reason: "explicit" | "style" | "keyword" | "default";
}

/**
 * Explicit id/alias > style alias > keyword inference > default.
 * A user-uploaded .docx template is handled before this (its package replaces
 * the visual layer entirely), so it is not part of this function.
 */
export function resolveTemplate(
  input: {
    requested?: string;
    styleHint?: string;
    titleHint?: string;
    briefHint?: string;
  },
  registry: DocTemplateRegistry = DEFAULT_TEMPLATE_REGISTRY,
): TemplateResolution {
  const requested = input.requested?.trim();
  if (requested) {
    const id = registry.aliasIndex.get(requested.toLowerCase());
    if (id) return { template: registry.templates[id], reason: "explicit" };
  }
  const style = input.styleHint?.trim();
  if (style) {
    const id = registry.aliasIndex.get(style.toLowerCase());
    if (id) return { template: registry.templates[id], reason: "style" };
  }
  const keywordMatch = matchTemplateByText([input.titleHint, input.briefHint].filter(Boolean).join(" "), registry);
  if (keywordMatch) return { template: registry.templates[keywordMatch], reason: "keyword" };
  return { template: registry.templates["work-report"], reason: "default" };
}

/** Resolves page setup overrides (IR / section) onto the template geometry. */
export function resolvePage(
  templatePage: PageSpec,
  override?: PageSetup,
): PageSpec & { widthTwips: number; heightTwips: number } {
  const size = override?.size ?? templatePage.size;
  const orientation = override?.orientation ?? templatePage.orientation;
  const base =
    size === "A3"
      ? { widthTwips: 16838, heightTwips: 23811 }
      : size === "Letter"
        ? { widthTwips: 12240, heightTwips: 15840 }
        : { widthTwips: 11906, heightTwips: 16838 };
  const landscape = orientation === "landscape";
  const margins = { ...templatePage.margins };
  if (override?.margins) {
    for (const key of ["top", "right", "bottom", "left"] as const) {
      const cm = override.margins[key];
      if (typeof cm === "number") margins[key] = Math.round(cm * 567);
    }
  }
  return {
    ...templatePage,
    size,
    orientation,
    margins,
    widthTwips: landscape ? base.heightTwips : base.widthTwips,
    heightTwips: landscape ? base.widthTwips : base.heightTwips,
  };
}
