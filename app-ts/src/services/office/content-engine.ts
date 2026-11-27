import { generateText } from "ai";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { PromptRegistry } from "../../agent/prompts/loader.js";
import { config } from "../../config/index.js";
import { createGatewayModel } from "../../llm/provider.js";
import {
  DOCUMENT_TEMPLATE_IDS,
  IR_LIMITS,
  validateDocumentIR,
  type DocumentIR,
  type DocumentMeta,
  type DocumentTemplateId,
  type IRBlock,
  type IRSection,
} from "./ir.js";
import { getDocTemplate } from "./templates.js";
import {
  QUALITY_PASS_SCORE,
  checkDocumentQuality,
  type QualityFinding,
  type QualityReport,
} from "./content-quality.js";
import {
  runFactCheck,
  type FactCheckPort,
  type FactCheckResult,
} from "./fact-check.js";

/**
 * Staged content engine for Word generation.
 *
 * One LLM call per design goal is not enough: a single-shot "write me a report"
 * prompt produces AI-flavored filler. This engine splits authoring into explicit
 * stages and only hands IR to the renderer after an editorial pass and a rule
 * based quality gate:
 *
 *   plan     -> outline JSON (title / sections / per-section goal + block plan)
 *   sections -> one JSON block list per section (small, focused context)
 *   edit     -> whole-document revision (remove filler, de-duplicate, add facts)
 *   quality  -> checkDocumentQuality; below the pass line one targeted repair
 *   factCheck-> optional numeric-claim verification (findings only; never edits)
 *
 * Every stage retries on invalid JSON / invalid IR with the error fed back to the
 * model (maxRepair times, default 2). Model failures map to
 * ContentEngineError("model") so callers never leak gateway errors to users.
 *
 * Prompt copy lives in prompts/office/*.md (repo rule: no LLM copy in code).
 */

export interface TextGenerationPort {
  generate(input: {
    purpose: string;
    system: string;
    user: string;
    temperature?: number;
    maxOutputTokens?: number;
    json?: boolean;
  }): Promise<string>;
}

export interface ComposeInput {
  brief: string;
  templateId: DocumentTemplateId;
  audience?: string;
  constraints?: string;
  facts?: string;
  language?: "zh";
  sectionTarget?: number;
  /** Optional fact-check backend; runs after the quality stage when enabled. */
  factCheck?: FactCheckPort;
}

export interface StageLog {
  stage: "plan" | "sections" | "edit" | "quality" | "factCheck";
  attempt: number;
  ok: boolean;
  detail?: string;
}

export interface ComposeResult {
  document: DocumentIR;
  stages: StageLog[];
  quality: QualityReport;
  /** Present only when the caller passed an enabled fact-check port. */
  factCheck?: FactCheckResult;
}

export type ContentEngineErrorCode = "disabled" | "model" | "invalid";

export class ContentEngineError extends Error {
  readonly code: ContentEngineErrorCode;

  constructor(code: ContentEngineErrorCode, message: string) {
    super(message);
    this.name = "ContentEngineError";
    this.code = code;
  }
}

/** Tunables with a single home (section target and retry budgets). */
export const CONTENT_ENGINE_DEFAULTS = {
  /** Retries per stage on invalid JSON / invalid IR (2 => up to 3 attempts). */
  maxRepair: 2,
  /** Planned chapters when the caller does not say. */
  sectionTarget: 5,
  minSections: 3,
  maxSections: 12,
  planTemperature: 0.4,
  sectionTemperature: 0.6,
  editTemperature: 0.2,
  fixTemperature: 0.2,
  planMaxOutputTokens: 4000,
  sectionMaxOutputTokens: 5000,
  editMaxOutputTokens: 8000,
  /** Hard gateway deadline for one stage call. */
  timeoutMs: 180_000,
} as const;

// ---------------------------------------------------------------------------
// Prompt access (prompts/office/*.md via PromptRegistry.render)
// ---------------------------------------------------------------------------

let promptRegistry: PromptRegistry | undefined;
let cachedStrategy: string | undefined;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function getPromptRegistry(): PromptRegistry {
  if (promptRegistry) return promptRegistry;
  const candidates: string[] = [];
  try {
    candidates.push(resolve(config.prompts.dir));
  } catch {
    // config unavailable: fall through to the module-relative path
  }
  // src/services/office/content-engine.ts -> <app-ts>/prompts
  candidates.push(fileURLToPath(new URL("../../../prompts/", import.meta.url)));
  let lastError: unknown;
  for (const dir of candidates) {
    try {
      promptRegistry = PromptRegistry.load(dir);
      return promptRegistry;
    } catch (err) {
      lastError = err;
    }
  }
  throw new ContentEngineError("disabled", "Office 内容提示词加载失败：" + messageOf(lastError));
}

function renderPrompt(name: string, vars: Record<string, string>): string {
  try {
    return getPromptRegistry().render(name, vars);
  } catch (err) {
    if (err instanceof ContentEngineError) throw err;
    throw new ContentEngineError("disabled", "Office 内容提示词不可用（" + name + "）：" + messageOf(err));
  }
}

function strategySection(): string {
  if (cachedStrategy === undefined) cachedStrategy = renderPrompt("office/writing-strategies", {});
  return cachedStrategy;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampRepair(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return CONTENT_ENGINE_DEFAULTS.maxRepair;
  return Math.max(0, Math.min(5, Math.floor(value)));
}

function clampSectionTarget(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return CONTENT_ENGINE_DEFAULTS.sectionTarget;
  return Math.max(
    CONTENT_ENGINE_DEFAULTS.minSections,
    Math.min(CONTENT_ENGINE_DEFAULTS.maxSections, Math.floor(value)),
  );
}

/** Extracts the first JSON value from model text (tolerates code fences / prose). */
function parseJsonValue(raw: string): unknown {
  let text = raw.trim();
  if (text === "") throw new Error("模型输出为空");
  const fence = text.match(/[\x60]{3}(?:json)?\s*([\s\S]*?)[\x60]{3}/i);
  if (fence && fence[1] !== undefined && fence[1].trim() !== "") text = fence[1].trim();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // fall through to brace extraction
  }
  const objectStart = text.indexOf("{");
  const arrayStart = text.indexOf("[");
  let start = -1;
  if (objectStart >= 0 && (arrayStart < 0 || objectStart < arrayStart)) start = objectStart;
  else if (arrayStart >= 0) start = arrayStart;
  if (start < 0) throw new Error("模型输出里没有 JSON 对象");
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  const end = text.lastIndexOf(close);
  if (end <= start) throw new Error("模型输出的 JSON 不完整");
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch (err) {
    throw new Error("JSON 解析失败：" + messageOf(err));
  }
}

const ALLOWED_BLOCK_TYPES = new Set<string>([
  "heading",
  "paragraph",
  "line",
  "orderedList",
  "unorderedList",
  "table",
  "image",
  "caption",
  "quote",
  "codeBlock",
  "formula",
  "reference",
  "toc",
  "pageBreak",
  "sectionBreak",
  "divider",
  "callout",
  "kv",
  "metrics",
]);

function parseBlocks(raw: string): IRBlock[] {
  const value = parseJsonValue(raw);
  const candidate = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.blocks)
      ? value.blocks
      : undefined;
  if (!candidate) throw new Error('章节内容必须是块数组或 {"blocks": [...]}');
  if (candidate.length === 0) throw new Error("章节内容为空");
  return candidate.slice(0, IR_LIMITS.blocksPerSection).map((item, index) => {
    if (!isRecord(item)) throw new Error("blocks[" + index + "] 必须是对象");
    return item as unknown as IRBlock;
  });
}

function validateBlocks(blocks: IRBlock[]): IRBlock[] {
  blocks.forEach((block, index) => {
    if (!isRecord(block)) throw new Error("blocks[" + index + "] 必须是对象");
    const type = block.type;
    if (typeof type !== "string" || !ALLOWED_BLOCK_TYPES.has(type)) {
      throw new Error("blocks[" + index + "] 块类型不允许：" + String(type));
    }
    if ((type === "paragraph" || type === "heading" || type === "callout") && (typeof block.text !== "string" || block.text.trim() === "")) {
      throw new Error("blocks[" + index + "] 缺少 text");
    }
  });
  return blocks;
}

interface PlanSection {
  heading: string;
  goal: string;
  blockPlan: string[];
}

interface DocumentPlan {
  title: string;
  subtitle?: string;
  meta?: DocumentMeta;
  sections: PlanSection[];
}

function parsePlan(raw: string): DocumentPlan {
  const value = parseJsonValue(raw);
  if (!isRecord(value)) throw new Error("大纲必须是 JSON 对象");
  const title = typeof value.title === "string" ? value.title.trim() : "";
  if (title === "") throw new Error("大纲缺少 title");
  const rawSections = Array.isArray(value.sections) ? value.sections : [];
  if (rawSections.length === 0) throw new Error("大纲缺少 sections");
  const sections: PlanSection[] = rawSections.slice(0, IR_LIMITS.sections).map((entry, index) => {
    if (!isRecord(entry)) throw new Error("sections[" + index + "] 必须是对象");
    const heading = typeof entry.heading === "string" ? entry.heading.trim() : "";
    if (heading === "") throw new Error("sections[" + index + "] 缺少 heading");
    const goal = typeof entry.goal === "string" ? entry.goal.trim() : "";
    const blockPlan = Array.isArray(entry.blockPlan)
      ? entry.blockPlan.filter((item): item is string => typeof item === "string").slice(0, 12)
      : [];
    return { heading: heading.slice(0, 200), goal: goal.slice(0, 500), blockPlan };
  });
  const subtitle =
    typeof value.subtitle === "string" && value.subtitle.trim() !== "" ? value.subtitle.trim().slice(0, 300) : undefined;
  const meta = isRecord(value.meta) ? (value.meta as DocumentMeta) : undefined;
  return {
    title: title.slice(0, 300),
    ...(subtitle ? { subtitle } : {}),
    ...(meta ? { meta } : {}),
    sections,
  };
}

function parseDocument(raw: string): DocumentIR {
  return validateDocumentIR(parseJsonValue(raw));
}

/** Repair context fed to a retried stage; the instruction text itself lives in the prompt files. */
function repairNote(error: string): string {
  return error === "" ? "（无）" : error;
}

function formatFindings(findings: QualityFinding[]): string {
  const rank: Record<QualityFinding["severity"], number> = { error: 0, warning: 1, info: 2 };
  const ordered = findings.slice().sort((a, b) => rank[a.severity] - rank[b.severity]);
  if (ordered.length === 0) return "（无）";
  return ordered
    .slice(0, 12)
    .map((finding, index) => {
      const location =
        finding.sectionIndex !== undefined ? "（第 " + (finding.sectionIndex + 1) + " 章）" : "";
      const excerpt = finding.excerpt ? "，示例：" + finding.excerpt : "";
      return index + 1 + ". [" + finding.severity + "] " + finding.message + location + excerpt;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Stage runner
// ---------------------------------------------------------------------------

type GenerateInput = Parameters<TextGenerationPort["generate"]>[0];

interface JsonStageRequest<T> {
  stage: StageLog["stage"];
  label: string;
  maxRepair: number;
  /** Attempt number of the first try (1 for the main pass, 2 for the quality fix). */
  firstAttempt?: number;
  build: (repair: string) => GenerateInput;
  parse: (raw: string) => T;
  validate?: (value: T) => T;
}

async function callModel(llm: TextGenerationPort, input: GenerateInput): Promise<string> {
  try {
    return await llm.generate(input);
  } catch (err) {
    if (err instanceof ContentEngineError) throw err;
    throw new ContentEngineError("model", "文档内容生成失败：模型服务暂不可用或调用出错，请稍后重试");
  }
}

async function runJsonStage<T>(
  llm: TextGenerationPort,
  stages: StageLog[],
  request: JsonStageRequest<T>,
): Promise<T> {
  let lastError = "";
  const firstAttempt = request.firstAttempt ?? 1;
  const totalAttempts = request.maxRepair + 1;
  for (let round = 0; round < totalAttempts; round += 1) {
    const attempt = firstAttempt + round;
    const raw = await callModel(llm, request.build(lastError));
    try {
      const parsed = request.parse(raw);
      const value = request.validate ? request.validate(parsed) : parsed;
      stages.push({ stage: request.stage, attempt, ok: true, detail: request.label });
      return value;
    } catch (err) {
      lastError = messageOf(err);
      stages.push({
        stage: request.stage,
        attempt,
        ok: false,
        detail: request.label + "：" + lastError.slice(0, 300),
      });
    }
  }
  throw new ContentEngineError(
    "invalid",
    request.label + " 输出不合法（已重试 " + request.maxRepair + " 次）：" + lastError,
  );
}

// ---------------------------------------------------------------------------
// Public composition pipeline
// ---------------------------------------------------------------------------

/**
 * Runs the full plan -> sections -> edit -> quality pipeline and returns a
 * validated DocumentIR plus the stage trail and quality report.
 *
 * Throws ContentEngineError("invalid") when the model keeps producing input the
 * IR rejects, and ContentEngineError("model") when the generation port fails.
 */
export async function composeDocument(
  input: ComposeInput,
  deps: { llm: TextGenerationPort; maxRepair?: number },
): Promise<ComposeResult> {
  const brief = (input.brief ?? "").trim();
  if (brief === "") throw new ContentEngineError("invalid", "缺少写作需求（brief），无法生成文档");
  if (!DOCUMENT_TEMPLATE_IDS.includes(input.templateId)) {
    throw new ContentEngineError("invalid", "不支持的文档类型：" + String(input.templateId));
  }
  const maxRepair = clampRepair(deps.maxRepair);
  const sectionTarget = clampSectionTarget(input.sectionTarget);
  const stages: StageLog[] = [];
  const template = getDocTemplate(input.templateId);
  const strategy = strategySection();
  const factsText = input.facts && input.facts.trim() !== "" ? input.facts.trim().slice(0, 8000) : "（未提供）";
  const audienceText = input.audience && input.audience.trim() !== "" ? input.audience.trim().slice(0, 500) : "（未指定）";
  const constraintsText = input.constraints && input.constraints.trim() !== "" ? input.constraints.trim().slice(0, 2000) : "（无）";

  // 1. Plan: outline with per-section goal and block plan.
  const planSystem = renderPrompt("office/plan", {
    TEMPLATE_ID: template.id,
    TEMPLATE_LABEL: template.label,
    TEMPLATE_DESCRIPTION: template.description,
    STRATEGY: strategy,
  });
  const plan = await runJsonStage<DocumentPlan>(deps.llm, stages, {
    stage: "plan",
    label: "文档大纲",
    maxRepair,
    build: (repair) => ({
      purpose: "office_content_plan",
      system: planSystem,
      user: renderPrompt("office/plan-user", {
        BRIEF: brief.slice(0, 6000),
        AUDIENCE: audienceText,
        CONSTRAINTS: constraintsText,
        FACTS: factsText,
        SECTION_TARGET: String(sectionTarget),
        REPAIR_NOTE: repairNote(repair),
      }),
      temperature: CONTENT_ENGINE_DEFAULTS.planTemperature,
      maxOutputTokens: CONTENT_ENGINE_DEFAULTS.planMaxOutputTokens,
      json: true,
    }),
    parse: parsePlan,
  });

  // 2. Sections: one focused call per chapter, then assemble draft IR.
  const sectionSystem = renderPrompt("office/section", {
    TEMPLATE_LABEL: template.label,
    STRATEGY: strategy,
  });
  const assembled: IRSection[] = [];
  for (let index = 0; index < plan.sections.length; index += 1) {
    const planSection = plan.sections[index];
    const blocks = await runJsonStage<IRBlock[]>(deps.llm, stages, {
      stage: "sections",
      label: "第 " + (index + 1) + " 章「" + planSection.heading + "」",
      maxRepair,
      build: (repair) => ({
        purpose: "office_content_section",
        system: sectionSystem,
        user: renderPrompt("office/section-user", {
          DOC_TITLE: plan.title,
          DOC_SUMMARY: plan.subtitle ?? "",
          SECTION_INDEX: String(index + 1),
          SECTION_TOTAL: String(plan.sections.length),
          HEADING: planSection.heading,
          GOAL: planSection.goal === "" ? "（未指定）" : planSection.goal,
          BLOCK_PLAN: planSection.blockPlan.length > 0 ? planSection.blockPlan.join(" / ") : "paragraph",
          FACTS: factsText,
          REPAIR_NOTE: repairNote(repair),
        }),
        temperature: CONTENT_ENGINE_DEFAULTS.sectionTemperature,
        maxOutputTokens: CONTENT_ENGINE_DEFAULTS.sectionMaxOutputTokens,
        json: true,
      }),
      parse: parseBlocks,
      validate: validateBlocks,
    });
    assembled.push({ heading: planSection.heading, blocks });
  }

  const draft: DocumentIR = {
    version: 1,
    template: input.templateId,
    title: plan.title,
    ...(plan.subtitle ? { subtitle: plan.subtitle } : {}),
    ...(plan.meta ? { meta: plan.meta } : {}),
    sections: assembled,
  };

  // 3. Edit: editorial pass over the whole document JSON.
  const editSystem = renderPrompt("office/edit", {
    TEMPLATE_LABEL: template.label,
    STRATEGY: strategy,
  });
  const edited = await runJsonStage<DocumentIR>(deps.llm, stages, {
    stage: "edit",
    label: "终审编辑",
    maxRepair,
    build: (repair) => ({
      purpose: "office_content_edit",
      system: editSystem,
      user: renderPrompt("office/edit-user", {
        DOCUMENT_JSON: JSON.stringify(draft),
        FACTS: factsText,
        REPAIR_NOTE: repairNote(repair),
      }),
      temperature: CONTENT_ENGINE_DEFAULTS.editTemperature,
      maxOutputTokens: CONTENT_ENGINE_DEFAULTS.editMaxOutputTokens,
      json: true,
    }),
    parse: parseDocument,
  });
  let document: DocumentIR = { ...edited, template: input.templateId };

  // 4. Quality: rule gate + at most one targeted repair below the pass line.
  let quality = checkDocumentQuality(document, { templateId: input.templateId });
  stages.push({
    stage: "quality",
    attempt: 1,
    ok: quality.score >= QUALITY_PASS_SCORE,
    detail: "质量评分 " + quality.score,
  });
  if (quality.score < QUALITY_PASS_SCORE && maxRepair > 0) {
    const fixSystem = renderPrompt("office/quality-fix", {
      TEMPLATE_LABEL: template.label,
      STRATEGY: strategy,
    });
    const fixAttempts = maxRepair + 1;
    try {
      const fixed = await runJsonStage<DocumentIR>(deps.llm, stages, {
        stage: "quality",
        label: "质量修订",
        maxRepair,
        firstAttempt: 2,
        build: (repair) => ({
          purpose: "office_content_fix",
          system: fixSystem,
          user: renderPrompt("office/quality-fix-user", {
            FINDINGS: formatFindings(quality.findings),
            DOCUMENT_JSON: JSON.stringify(document),
            FACTS: factsText,
            REPAIR_NOTE: repairNote(repair),
          }),
          temperature: CONTENT_ENGINE_DEFAULTS.fixTemperature,
          maxOutputTokens: CONTENT_ENGINE_DEFAULTS.editMaxOutputTokens,
          json: true,
        }),
        parse: parseDocument,
      });
      document = { ...fixed, template: input.templateId };
      quality = checkDocumentQuality(document, { templateId: input.templateId });
      stages.push({
        stage: "quality",
        attempt: 2 + fixAttempts,
        ok: quality.score >= QUALITY_PASS_SCORE,
        detail: "质量修订后评分 " + quality.score,
      });
    } catch (err) {
      if (!(err instanceof ContentEngineError)) throw err;
      // A failed repair must not throw away an otherwise valid document.
      stages.push({
        stage: "quality",
        attempt: 2 + fixAttempts,
        ok: false,
        detail: "质量修订失败，保留原稿：" + err.message,
      });
    }
  }

  // 5. Fact check (optional): report unsupported/uncertain numeric claims so a
  // human/agent can act on them. It never edits the document and never blocks
  // generation: a missing/disabled port or a failed verify call degrades to
  // available=false with a Chinese explanation.
  let factCheck: FactCheckResult | undefined;
  if (input.factCheck?.enabled) {
    factCheck = await runFactCheck(document, input.factCheck);
    stages.push({
      stage: "factCheck",
      attempt: 1,
      ok: factCheck.available,
      detail: factCheck.text,
    });
  }

  return {
    document,
    stages,
    quality,
    ...(factCheck !== undefined ? { factCheck } : {}),
  };
}

// ---------------------------------------------------------------------------
// Production adapter (gateway -> TextGenerationPort)
// ---------------------------------------------------------------------------

/**
 * Production TextGenerationPort backed by the Higress gateway (the only place
 * provider credentials live). All upstream failures become
 * ContentEngineError("model") with Chinese guidance so raw provider errors never
 * reach users.
 */
export function createGatewayTextGenerator(
  opts: { purpose?: string; model?: string; uid?: string } = {},
): TextGenerationPort {
  return {
    async generate(input: GenerateInput): Promise<string> {
      if (!config.aiGateway.baseUrl || !config.aiGateway.apiKey) {
        throw new ContentEngineError("disabled", "AI 网关未配置（缺少 AI_GATEWAY__API_KEY），无法生成文档内容");
      }
      try {
        const model = createGatewayModel(opts.purpose ?? input.purpose ?? "office_content", {
          uid: opts.uid,
          model: opts.model,
          temperature: input.temperature,
        });
        const result = await generateText({
          model,
          system: input.system,
          prompt: input.user,
          temperature: input.temperature,
          maxOutputTokens: input.maxOutputTokens,
          abortSignal: AbortSignal.timeout(CONTENT_ENGINE_DEFAULTS.timeoutMs),
        });
        return result.text;
      } catch (err) {
        if (err instanceof ContentEngineError) throw err;
        throw new ContentEngineError("model", "文档内容生成失败：模型服务暂不可用，请稍后重试");
      }
    },
  };
}
