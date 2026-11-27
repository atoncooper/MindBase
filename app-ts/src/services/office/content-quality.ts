import {
  documentPlainText,
  type DocumentIR,
  type IRBlock,
  type IRSection,
} from "./ir.js";

/**
 * Content quality checker for generated Word documents.
 *
 * Pure rules (no I/O, no LLM): the Content Engine scores what the model wrote
 * before handing the IR to the DOCX renderer, and the findings are fed back into
 * a targeted repair turn. The rules specifically target "AI 腔" tells: connector
 * stuffing, repeated sentences, hollow paragraphs, mechanically cloned chapters,
 * unsourced data claims and genre conventions (resume / minutes / notice / …).
 *
 * All numeric thresholds live in QUALITY_THRESHOLDS so the scoring stays stable
 * and tunable in one place.
 */

export interface QualityFinding {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  sectionIndex?: number;
  blockIndex?: number;
  excerpt?: string;
}

export interface QualityReport {
  /** 0-100 (100 = clean). */
  score: number;
  findings: QualityFinding[];
  stats: {
    chars: number;
    paragraphs: number;
    headings: number;
    tables: number;
    lists: number;
    connectorsPer1000: number;
    duplicateSentences: number;
  };
}

/** 内容质量合格线：低于该分数时内容引擎会追加一次针对性修订。 */
export const QUALITY_PASS_SCORE = 70;

/** 判定阈值（集中管理，避免散落在规则里）。 */
export const QUALITY_THRESHOLDS = {
  /** 千字连接词频率达到该值记 warning。 */
  connectorPer1000Warning: 8,
  /** 千字连接词频率达到该值记 error（AI 腔明显）。 */
  connectorPer1000Error: 14,
  /** 单段连接词出现次数达到该值视为堆砌。 */
  connectorClusterPerParagraph: 3,
  /** 连接词频率判定所需的最小正文字数。 */
  connectorMinChars: 200,
  /** 参与重复检测的最短规范化句子长度。 */
  duplicateSentenceMinChars: 10,
  /** 同一句出现次数达到该值记 error（否则 warning）。 */
  duplicateSentencePerGroupError: 3,
  /** n-gram 重复检测的片段长度。 */
  ngramSize: 4,
  /** n-gram 出现次数达到该值才算机械重复。 */
  ngramMinOccurrences: 4,
  /** 最多报告的重复 n-gram 数量。 */
  ngramMaxFindings: 3,
  /** 空心段落的短段阈值（字符数）。 */
  shortParagraphChars: 16,
  /** 命中套话模板的段落最长字符数（超过视为有实质内容，不判空心）。 */
  hollowMaxChars: 90,
  /** 空心段落最多报告的条数。 */
  hollowMaxFindings: 10,
  /** 机械结构检测所需最少章节数。 */
  mechanicalMinSections: 3,
  /** 章节块类型序列一致的最低占比。 */
  mechanicalSimilarity: 0.75,
  /** 章节篇幅接近：最大/最小字数比值上限。 */
  mechanicalMaxLengthRatio: 1.2,
  /** 无依据数据最多报告的条数。 */
  unsupportedDataMaxFindings: 5,
  /** 简历段落长度上限（字符）。 */
  resumeMaxParagraphChars: 150,
} as const;

/** AI 腔连接词/套话开头的固定表达。 */
export const CONNECTOR_WORDS: readonly string[] = [
  "首先",
  "其次",
  "再次",
  "然后",
  "最后",
  "综上所述",
  "总而言之",
  "总的来说",
  "总之",
  "值得注意的是",
  "需要指出的是",
  "不难发现",
  "显而易见",
  "众所周知",
  "由此可见",
  "简而言之",
  "让我们",
  "希望对你有帮助",
  "希望对您有帮助",
  "希望本文能",
  "在当今社会",
  "随着时代的发展",
  "一方面",
  "另一方面",
  "此外",
  "同时",
  "因此",
];

export const QUALITY_CODES = {
  connectorOveruse: "connector_overuse",
  connectorCluster: "connector_cluster",
  duplicateSentence: "duplicate_sentence",
  ngramRepetition: "ngram_repetition",
  hollowParagraph: "hollow_paragraph",
  mechanicalStructure: "mechanical_structure",
  unsupportedData: "unsupported_data",
  docTypeMissing: "doc_type_missing",
  docTypeMismatch: "doc_type_mismatch",
} as const;

export type QualityCode = (typeof QUALITY_CODES)[keyof typeof QUALITY_CODES];

const HOLLOW_PATTERNS: readonly RegExp[] = [
  /本节(?:主要)?(?:介绍|阐述|说明|讨论|分析)/,
  /本文(?:主要)?(?:介绍|阐述|研究|探讨|分析)/,
  /具有(?:重要|深远|重大|积极)(?:意义|作用|价值)/,
  /起到(?:了)?(?:重要|关键|积极|推动)(?:作用|意义)/,
  /为[^。；]{0,12}(?:奠定|提供)[^。；]{0,8}(?:基础|参考|依据)/,
  /众所周知/,
  /不难发现/,
  /显而易见/,
  /值得注意的是/,
  /综上所述/,
  /总而言之/,
  /希望对(?:你|您)有(?:所)?帮助/,
  /让我们一起/,
];

const DATA_CLAIM_PATTERN = /\d+(?:\.\d+)?\s*(?:%|％|倍|万|亿|千|百万|个百分点)/;

const EVIDENCE_PATTERN =
  /来源|数据|统计|调研|调查报告|报告|报表|根据|依据|样本|问卷|实验|测算|估算|引用|文献|出处|资料|白皮书|访谈|口径/;

const SEVERITY_PENALTY: Record<QualityFinding["severity"], number> = {
  error: 15,
  warning: 6,
  info: 1,
};

interface RequirementGroup {
  label: string;
  patterns: readonly RegExp[];
}

const MEETING_MINUTES_GROUPS: readonly RequirementGroup[] = [
  { label: "时间", patterns: [/时间|日期|时段/, /\d{4}\s*年\s*\d{1,2}\s*月/, /\d{1,2}:\d{2}/] },
  { label: "地点", patterns: [/地点|会议室|会场|线上|地址|办公区/] },
  { label: "参会人员", patterns: [/参会|出席|参加|列席|与会/] },
  { label: "结论", patterns: [/结论|决议|决定|达成|共识/] },
  { label: "责任人/待办", patterns: [/待办|责任人|行动项|跟进|负责|下一步/] },
];

const NOTICE_GROUPS: readonly RequirementGroup[] = [
  { label: "事项", patterns: [/事项|事宜|内容|现将/] },
  { label: "时间", patterns: [/时间|日期|期限|截止|\d{4}\s*年\s*\d{1,2}\s*月/] },
  { label: "要求", patterns: [/要求|请|须|应|不得|务必/] },
];

const ACADEMIC_HEADING_GROUPS: readonly RequirementGroup[] = [
  { label: "方法", patterns: [/方法|研究设计|实验设计|实验|模型|数据来源/] },
  { label: "结果", patterns: [/结果|发现|分析|实验|实证/] },
  { label: "结论", patterns: [/结论|讨论|总结|展望|建议/] },
];

const TECH_DESIGN_GROUPS: readonly RequirementGroup[] = [
  { label: "架构", patterns: [/架构|系统结构|模块|总体设计/] },
  { label: "接口", patterns: [/接口|API|协议|契约/] },
  { label: "部署", patterns: [/部署|上线|运维|发布|环境/] },
];

const BUSINESS_PLAN_GROUPS: readonly RequirementGroup[] = [
  { label: "目标", patterns: [/目标|愿景|定位|价值主张/] },
  { label: "实施", patterns: [/实施|路径|计划|步骤|里程碑/] },
  { label: "风险", patterns: [/风险|挑战|应对|不确定性/] },
  { label: "预算", patterns: [/预算|成本|投入|资金|财务/] },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Canonical form for duplicate/repetition comparison: lowercase, all whitespace
 * and punctuation/symbols removed (CJK characters, letters and digits stay).
 */
export function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[\p{P}\p{S}]/gu, "");
}

/** Splits Chinese/English prose into sentences (also on newlines and semicolons). */
export function splitSentences(text: string): string[] {
  return text
    .split(/[。！？!?；;\n\r]+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== "");
}

function connectorPattern(): RegExp {
  const source = CONNECTOR_WORDS.slice()
    .sort((a, b) => b.length - a.length)
    .map((word) => word.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&"))
    .join("|");
  return new RegExp(source, "g");
}

/** Counts AI-tone connector occurrences in a text. */
export function countConnectors(text: string): number {
  if (text === "") return 0;
  const matches = text.match(connectorPattern());
  return matches ? matches.length : 0;
}

function textParts(block: IRBlock): string[] {
  switch (block.type) {
    case "heading":
    case "paragraph":
    case "line":
    case "caption":
    case "quote":
    case "formula":
      return [block.text];
    case "orderedList":
    case "unorderedList":
      return block.items;
    case "table":
      return [...(block.headers ?? []), ...block.rows.flat()];
    case "image":
      return [block.caption ?? "", block.alt ?? ""];
    case "codeBlock":
      return [block.code];
    case "reference":
      return block.items;
    case "callout":
      return [block.title ? block.title + "：" + block.text : block.text];
    case "kv":
      return block.items.map((item) => item.label + "：" + item.value);
    case "metrics":
      return block.items.map((item) => item.label + "：" + item.value);
    default:
      return [];
  }
}

function blockPlainText(block: IRBlock): string {
  return textParts(block)
    .filter((part) => part.trim() !== "")
    .join("\n");
}

interface ProseEntry {
  sectionIndex: number;
  blockIndex: number;
  blockType: IRBlock["type"];
  text: string;
  sectionText: string;
}

function collectProse(doc: DocumentIR): ProseEntry[] {
  const entries: ProseEntry[] = [];
  doc.sections.forEach((section, sectionIndex) => {
    const sectionText = [section.heading ?? "", ...section.blocks.map((block) => blockPlainText(block))]
      .filter((part) => part.trim() !== "")
      .join("\n");
    section.blocks.forEach((block, blockIndex) => {
      if (
        block.type !== "paragraph" &&
        block.type !== "line" &&
        block.type !== "callout" &&
        block.type !== "quote"
      ) {
        return;
      }
      entries.push({
        sectionIndex,
        blockIndex,
        blockType: block.type,
        text: blockPlainText(block),
        sectionText,
      });
    });
  });
  return entries;
}

function excerptOf(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 60 ? compact.slice(0, 60) + "…" : compact;
}

function missingGroups(text: string, groups: readonly RequirementGroup[]): string[] {
  return groups.filter((group) => !group.patterns.some((pattern) => pattern.test(text))).map((group) => group.label);
}

function sectionHeadingText(doc: DocumentIR): string {
  const parts: string[] = [doc.title, doc.subtitle ?? ""];
  for (const section of doc.sections) {
    if (section.heading) parts.push(section.heading);
    for (const block of section.blocks) {
      if (block.type === "heading") parts.push(block.text);
    }
  }
  return parts.filter((part) => part.trim() !== "").join("\n");
}

function sectionChars(section: IRSection): number {
  const text = [section.heading ?? "", ...section.blocks.map((block) => blockPlainText(block))].join("");
  return text.replace(/\s+/g, "").length;
}

/**
 * Scores a DocumentIR and reports quality findings. Unknown templateId = only
 * the generic (AI-tone / repetition / structure) rules run; genre rules are
 * skipped so the checker never assumes a genre it was not told about.
 */
export function checkDocumentQuality(doc: DocumentIR, opts: { templateId?: string } = {}): QualityReport {
  const findings: QualityFinding[] = [];
  const add = (finding: QualityFinding): void => {
    findings.push(finding);
  };

  const fullText = documentPlainText(doc);
  const cleanChars = fullText.replace(/\s+/g, "").length;
  const prose = collectProse(doc);
  const paragraphEntries = prose.filter((entry) => entry.blockType === "paragraph");

  const blocks = doc.sections.flatMap((section) => section.blocks);
  const paragraphs = blocks.filter((block) => block.type === "paragraph").length;
  const headings =
    doc.sections.filter((section) => (section.heading ?? "").trim() !== "").length +
    blocks.filter((block) => block.type === "heading").length;
  const tables = blocks.filter((block) => block.type === "table").length;
  const lists = blocks.filter((block) => block.type === "orderedList" || block.type === "unorderedList").length;

  const connectors = countConnectors(fullText);
  const connectorsPer1000 = cleanChars > 0 ? round2((connectors / cleanChars) * 1000) : 0;

  // Rule 1: AI-tone connector density + per-paragraph clustering.
  if (cleanChars >= QUALITY_THRESHOLDS.connectorMinChars && connectorsPer1000 >= QUALITY_THRESHOLDS.connectorPer1000Error) {
    add({
      code: QUALITY_CODES.connectorOveruse,
      severity: "error",
      message:
        "AI 腔连接词过密：每千字 " +
        connectorsPer1000 +
        " 处（阈值 " +
        QUALITY_THRESHOLDS.connectorPer1000Warning +
        "），共 " +
        connectors +
        " 处（首先/其次/综上所述/值得注意的是 等），建议改为直接陈述事实与因果关系。",
      excerpt: excerptOf(fullText.slice(0, 120)),
    });
  } else if (
    cleanChars >= QUALITY_THRESHOLDS.connectorMinChars &&
    connectorsPer1000 >= QUALITY_THRESHOLDS.connectorPer1000Warning
  ) {
    add({
      code: QUALITY_CODES.connectorOveruse,
      severity: "warning",
      message:
        "AI 腔连接词偏多：每千字 " +
        connectorsPer1000 +
        " 处（阈值 " +
        QUALITY_THRESHOLDS.connectorPer1000Warning +
        "），共 " +
        connectors +
        " 处，建议删减过渡词、直接给信息。",
    });
  }
  let clusterFindings = 0;
  for (const entry of paragraphEntries) {
    if (clusterFindings >= 6) break;
    const count = countConnectors(entry.text);
    if (count < QUALITY_THRESHOLDS.connectorClusterPerParagraph) continue;
    clusterFindings += 1;
    add({
      code: QUALITY_CODES.connectorCluster,
      severity: "warning",
      message: "段落连接词堆砌：同一段出现 " + count + " 处连接词，读起来像模板化生成。",
      sectionIndex: entry.sectionIndex,
      blockIndex: entry.blockIndex,
      excerpt: excerptOf(entry.text),
    });
  }

  // Rule 2: duplicate sentences (normalized) across the whole document.
  const sentenceGroups = new Map<string, { count: number; sample: string }>();
  for (const sentence of splitSentences(fullText)) {
    const normalized = normalizeForComparison(sentence);
    if (normalized.length < QUALITY_THRESHOLDS.duplicateSentenceMinChars) continue;
    const existing = sentenceGroups.get(normalized);
    if (existing) existing.count += 1;
    else sentenceGroups.set(normalized, { count: 1, sample: sentence.trim() });
  }
  const duplicateGroups = [...sentenceGroups.values()]
    .filter((group) => group.count > 1)
    .sort((a, b) => b.count - a.count);
  let duplicateSentences = 0;
  for (const group of duplicateGroups) duplicateSentences += group.count - 1;
  duplicateGroups.slice(0, 5).forEach((group) => {
    add({
      code: QUALITY_CODES.duplicateSentence,
      severity: group.count >= QUALITY_THRESHOLDS.duplicateSentencePerGroupError ? "error" : "warning",
      message: "重复表达：同一句在全文出现 " + group.count + " 次，建议合并或改写。",
      excerpt: excerptOf(group.sample),
    });
  });

  // Rule 3: high-frequency 4-gram repetition (mechanical phrasing).
  const normalizedText = normalizeForComparison(fullText);
  const gramLength = QUALITY_THRESHOLDS.ngramSize;
  const gramPositions = new Map<string, number[]>();
  for (let index = 0; index + gramLength <= normalizedText.length; index += 1) {
    const gram = normalizedText.slice(index, index + gramLength);
    if (new Set(gram).size < 3) continue;
    // ASCII-only 4-grams are word fragments ("docu", "ment") in mixed text; only
    // Chinese phrases indicate mechanical phrasing.
    if (!/[\u4e00-\u9fff]/.test(gram)) continue;
    const positions = gramPositions.get(gram);
    if (positions) positions.push(index);
    else gramPositions.set(gram, [index]);
  }
  const repeatedGrams = [...gramPositions.entries()]
    .filter(([, positions]) => positions.length >= QUALITY_THRESHOLDS.ngramMinOccurrences)
    .sort((a, b) => b[1].length - a[1].length);
  const covered = new Set<number>();
  let ngramFindings = 0;
  for (const [gram, positions] of repeatedGrams) {
    if (ngramFindings >= QUALITY_THRESHOLDS.ngramMaxFindings) break;
    const uncovered = positions.filter((start) => {
      for (let offset = 0; offset < gramLength; offset += 1) {
        if (covered.has(start + offset)) return false;
      }
      return true;
    });
    if (uncovered.length < 2) continue;
    for (const start of uncovered) {
      for (let offset = 0; offset < gramLength; offset += 1) covered.add(start + offset);
    }
    ngramFindings += 1;
    add({
      code: QUALITY_CODES.ngramRepetition,
      severity: "warning",
      message: "机械重复：短语「" + gram + "」在全文重复出现 " + positions.length + " 次，建议换成不同表达。",
      excerpt: gram,
    });
  }

  // Rule 4: hollow paragraphs (too short / pure slogan / filler templates).
  let hollowFindings = 0;
  for (const entry of paragraphEntries) {
    if (hollowFindings >= QUALITY_THRESHOLDS.hollowMaxFindings) break;
    const text = entry.text.trim();
    if (text === "") continue;
    const hasConcrete = /\d/.test(text) || /[A-Za-z]{3,}/.test(text);
    const tooShort = text.length <= QUALITY_THRESHOLDS.shortParagraphChars && !hasConcrete;
    const matchesHollow = HOLLOW_PATTERNS.some((pattern) => pattern.test(text));
    const hollowTemplate = matchesHollow && text.length <= QUALITY_THRESHOLDS.hollowMaxChars;
    if (!tooShort && !hollowTemplate) continue;
    hollowFindings += 1;
    add({
      code: QUALITY_CODES.hollowParagraph,
      severity: "warning",
      message: tooShort
        ? "空心段落：内容过短且没有具体信息（事实、数据、动作或结论）。"
        : "空心段落：命中「本节介绍了…/具有重要意义/众所周知…」等套话，需补具体信息或删除。",
      sectionIndex: entry.sectionIndex,
      blockIndex: entry.blockIndex,
      excerpt: excerptOf(text),
    });
  }

  // Rule 5: mechanically cloned chapters (same block-type sequence + similar length).
  const nonEmptySections = doc.sections.filter((section) => section.blocks.length > 0);
  if (nonEmptySections.length >= QUALITY_THRESHOLDS.mechanicalMinSections) {
    const signatures = nonEmptySections.map((section) =>
      section.blocks
        .filter((block) => block.type !== "pageBreak" && block.type !== "sectionBreak" && block.type !== "divider")
        .map((block) => block.type)
        .join(">"),
    );
    const signatureCounts = new Map<string, number>();
    for (const signature of signatures) {
      signatureCounts.set(signature, (signatureCounts.get(signature) ?? 0) + 1);
    }
    let dominantSignature = "";
    let dominantCount = 0;
    for (const [signature, count] of signatureCounts) {
      if (count > dominantCount) {
        dominantSignature = signature;
        dominantCount = count;
      }
    }
    const requiredCount = Math.max(
      QUALITY_THRESHOLDS.mechanicalMinSections,
      Math.ceil(nonEmptySections.length * QUALITY_THRESHOLDS.mechanicalSimilarity),
    );
    if (dominantSignature !== "" && dominantCount >= requiredCount) {
      const lengths = nonEmptySections.map((section) => sectionChars(section));
      const shortest = Math.min(...lengths);
      const longest = Math.max(...lengths);
      const ratio = shortest > 0 ? longest / shortest : Number.POSITIVE_INFINITY;
      if (ratio <= QUALITY_THRESHOLDS.mechanicalMaxLengthRatio) {
        add({
          code: QUALITY_CODES.mechanicalStructure,
          severity: "warning",
          message:
            "机械结构：多个章节的块类型序列与篇幅高度一致（" +
            dominantCount +
            " 章几乎同构），应让章节结构跟随内容而不是套模板。",
          excerpt: excerptOf(nonEmptySections[0].heading ?? ""),
        });
      }
    }
  }

  // Rule 6: numeric claims without provenance markers in the paragraph/chapter.
  let dataFindings = 0;
  for (const entry of prose) {
    if (dataFindings >= QUALITY_THRESHOLDS.unsupportedDataMaxFindings) break;
    if (!DATA_CLAIM_PATTERN.test(entry.text)) continue;
    if (EVIDENCE_PATTERN.test(entry.text)) continue;
    if (EVIDENCE_PATTERN.test(entry.sectionText)) continue;
    dataFindings += 1;
    add({
      code: QUALITY_CODES.unsupportedData,
      severity: "info",
      message: "无依据数据：出现百分比/倍数/万·亿级数字，但同段与本章节都没有来源、统计、调研等出处标记，建议补出处或改为定性表述。",
      sectionIndex: entry.sectionIndex,
      blockIndex: entry.blockIndex,
      excerpt: excerptOf(entry.text),
    });
  }

  // Rule 7: genre conventions.
  const templateId = opts.templateId ?? doc.template;
  if (templateId === "meeting-minutes") {
    const missing = missingGroups(fullText, MEETING_MINUTES_GROUPS);
    if (missing.length > 0) {
      add({
        code: QUALITY_CODES.docTypeMissing,
        severity: "warning",
        message: "会议纪要缺少必要信息：" + missing.join("、") + "（应含时间/地点/参会/结论/责任人或待办）。",
      });
    }
  } else if (templateId === "notice") {
    const missing = missingGroups(fullText, NOTICE_GROUPS);
    if (missing.length > 0) {
      add({
        code: QUALITY_CODES.docTypeMissing,
        severity: "warning",
        message: "通知缺少必要要素：" + missing.join("、") + "（应含事项/时间/要求）。",
      });
    }
  } else if (templateId === "academic") {
    const missing = missingGroups(sectionHeadingText(doc), ACADEMIC_HEADING_GROUPS);
    if (missing.length > 0) {
      add({
        code: QUALITY_CODES.docTypeMissing,
        severity: "warning",
        message: "学术论文缺少必要章节标题：" + missing.join("、") + "（应含方法/结果/结论类标题）。",
      });
    }
  } else if (templateId === "tech-design") {
    const missing = missingGroups(fullText, TECH_DESIGN_GROUPS);
    if (missing.length > 0) {
      add({
        code: QUALITY_CODES.docTypeMissing,
        severity: "warning",
        message: "技术设计文档缺少关键内容：" + missing.join("、") + "（应有架构/接口/部署类内容）。",
      });
    }
  } else if (templateId === "business-plan") {
    const missing = missingGroups(fullText, BUSINESS_PLAN_GROUPS);
    if (missing.length > 0) {
      add({
        code: QUALITY_CODES.docTypeMissing,
        severity: "warning",
        message: "商业计划书缺少关键内容：" + missing.join("、") + "（应有目标/实施/风险/预算类内容）。",
      });
    }
  } else if (templateId === "resume") {
    if (doc.cover === true) {
      add({
        code: QUALITY_CODES.docTypeMismatch,
        severity: "warning",
        message: "简历不应生成封面页（cover=true），建议关闭封面、突出个人信息与经历。",
      });
    }
    let longParagraphs = 0;
    for (const entry of paragraphEntries) {
      if (longParagraphs >= 3) break;
      if (entry.text.replace(/\s+/g, "").length <= QUALITY_THRESHOLDS.resumeMaxParagraphChars) continue;
      longParagraphs += 1;
      add({
        code: QUALITY_CODES.docTypeMismatch,
        severity: "warning",
        message:
          "简历段落过长（超过 " +
          QUALITY_THRESHOLDS.resumeMaxParagraphChars +
          " 字），简历应以要点化经历为主，避免大段叙述。",
        sectionIndex: entry.sectionIndex,
        blockIndex: entry.blockIndex,
        excerpt: excerptOf(entry.text),
      });
    }
  }

  const penalty = findings.reduce((sum, finding) => sum + SEVERITY_PENALTY[finding.severity], 0);
  const score = Math.max(0, Math.min(100, Math.round(100 - penalty)));

  return {
    score,
    findings,
    stats: {
      chars: cleanChars,
      paragraphs,
      headings,
      tables,
      lists,
      connectorsPer1000,
      duplicateSentences,
    },
  };
}
