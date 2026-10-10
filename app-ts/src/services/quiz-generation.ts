import { randomUUID } from "node:crypto";
import { z } from "zod";
import { generateObject } from "ai";
import { config } from "../config/index.js";
import { createGatewayModel } from "../llm/provider.js";
import { aiTelemetry } from "../llm/tracing.js";
import { createLogger } from "../logger.js";
import type { PromptRegistry } from "../agent/prompts/loader.js";
import type { SessionSummaryService } from "./session-summary.js";
import type { AgentQuestionPayload, AppQuizClient, WrongAnswerEntry } from "./app-quiz-client.js";
import type { RAGService } from "../rag/service.js";
import type { Document } from "../rag/types.js";

const log = createLogger("QUIZ_GEN");

/**
 * Quiz generation from a chat session summary — port of
 * app/services/quiz_from_summary.py + the generation core of
 * app/agent/quiz/graph.py (batch prompts, answer-tracing validation,
 * downgrade-free lean path). Question CONTENT is persisted through app-quiz's
 * internal API (app-ts owns the AI orchestration only).
 */

export interface Chunk {
  title: string;
  content: string;
  /** provenance (folder / pages modes); the summary mode has none */
  bvid?: string;
  pageIndex?: number;
  pageTitle?: string;
}

export type QuizQuestionDict = Record<string, unknown>;

export const MIN_SUMMARY_CHARS = 200;
const CHUNK_TARGET_CHARS = 600;
const CHUNK_MAX_CHARS = 3000;
const MAX_BATCH_COUNT = 20;
const MAX_BATCH_SIZE = 20;
const MAX_CHUNK_CHARS = 4000;
const MAX_CONTEXT_CHARS = 16000;
const ALLOWED_DIFFICULTIES = ["easy", "medium", "hard"];

// ── pure helpers (ported; unit-tested) ───────────────────────────────

/** Split summary markdown into pseudo-chunks (python split_summary_to_chunks). */
export function splitSummaryToChunks(
  summary: string,
  targetChars = CHUNK_TARGET_CHARS,
  maxChunks = 20,
): Chunk[] {
  const paragraphs = summary
    .split("\n\n")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const chunks: string[] = [];
  let buf = "";
  for (const para of paragraphs) {
    if (para.length > CHUNK_MAX_CHARS) {
      if (buf) {
        chunks.push(buf);
        buf = "";
      }
      for (let i = 0; i < para.length; i += CHUNK_MAX_CHARS) {
        const piece = para.slice(i, i + CHUNK_MAX_CHARS).trim();
        if (piece) chunks.push(piece);
      }
      continue;
    }
    if (buf && buf.length + para.length + 1 > targetChars) {
      chunks.push(buf);
      buf = para;
    } else {
      buf = (buf + "\n" + para).trim();
    }
  }
  if (buf) chunks.push(buf);

  return chunks
    .filter((c) => c.length >= 80)
    .slice(0, maxChunks)
    .map((c) => ({ title: "会话总结", content: c }));
}

/** 60% single choice / 20% multi choice / 20% short answer. */
export function defaultTypeDistribution(questionCount: number): Record<string, number> {
  let single = Math.max(1, Math.round(questionCount * 0.6));
  let multi = questionCount > 1 ? Math.max(1, questionCount - single) : 0;
  let short = 0;
  if (questionCount > 2) {
    multi = Math.max(1, Math.round((questionCount - single) / 2));
    short = questionCount - single - multi;
  }
  const dist: Record<string, number> = { single_choice: single, multi_choice: multi, short_answer: short };
  const total = Object.values(dist).reduce((a, b) => a + b, 0);
  if (total !== questionCount) dist.single_choice += questionCount - total;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(dist)) if (v > 0) out[k] = v;
  return out;
}

function optionLabel(value: string): string {
  const m = /^\s*([A-Za-z])(?:[.．、\s]+|$)/.exec(value);
  return m ? m[1].toUpperCase() : "";
}

function stripOptionLabel(value: string): string {
  return value.replace(/^\s*[A-Za-z](?:[.．、\s]+|$)/, "").trim();
}

function optionMaps(options: unknown[]): { labelMap: Record<string, string | undefined>; textSet: Set<string> } {
  const labelMap: Record<string, string | undefined> = {};
  const textSet = new Set<string>();
  options.forEach((option, index) => {
    const raw = String(option).trim();
    const text = stripOptionLabel(raw);
    if (!text) return;
    textSet.add(text);
    const label = optionLabel(raw) || String.fromCharCode("A".charCodeAt(0) + index);
    labelMap[label] = text;
  });
  return { labelMap, textSet };
}

/** Resolve the correct-answer texts; [] when the answer cannot be resolved. */
export function answerTexts(q: QuizQuestionDict): string[] {
  const options = Array.isArray(q["options"]) ? (q["options"] as unknown[]) : [];
  const { labelMap, textSet } = optionMaps(options);
  const correct = q["correct_answer"];
  const answers = Array.isArray(correct) ? correct : [correct];
  const texts: string[] = [];
  const seen = new Set<string>();
  for (const answer of answers) {
    const raw = String(answer).trim();
    const label = optionLabel(raw);
    let text: string | undefined;
    if (label) {
      text = labelMap[label];
      if (text === undefined) return [];
      const stripped = stripOptionLabel(raw);
      if (raw.toUpperCase() !== label && stripped !== text) return [];
    } else {
      text = stripOptionLabel(raw);
      if (!textSet.has(text)) return [];
    }
    if (seen.has(text)) return [];
    seen.add(text);
    texts.push(text);
  }
  return texts.filter((t) => t.length > 1);
}

export function traceTokens(text: string): Set<string> {
  const normalized = text.toLowerCase();
  const tokens = new Set<string>();
  for (const m of normalized.matchAll(/[a-z0-9_-]{2,}/g)) tokens.add(m[0]);
  for (const m of normalized.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const seq = m[0];
    for (let i = 0; i < seq.length - 1; i += 1) tokens.add(seq.slice(i, i + 2));
  }
  return tokens;
}

/** Each answer term must independently trace back to the source chunk. */
export function isTracedToSource(terms: string[], source: string): boolean {
  if (terms.length === 0) return false;
  const sourceLower = source.toLowerCase();
  const sourceTokens = traceTokens(source);
  let validated = 0;
  for (const term of terms) {
    if (term.length < 2) continue;
    const termLower = term.toLowerCase();
    if (termLower.length >= 3 && sourceLower.includes(termLower)) {
      validated += 1;
      continue;
    }
    const tt = traceTokens(term);
    let overlap = false;
    for (const t of tt) {
      if (sourceTokens.has(t)) {
        overlap = true;
        break;
      }
    }
    if (overlap) {
      validated += 1;
      continue;
    }
    return false;
  }
  return validated > 0;
}

/**
 * Validate one generated question against its source chunk. Trace failure is
 * NOT a hard reject: the question is flagged _low_confidence and kept
 * (Python parity).
 */
export function validateQuestion(
  q: QuizQuestionDict,
  chunks: Chunk[],
  opts: { trace?: boolean } = {},
): boolean {
  const trace = opts.trace !== false;
  if (!q["question"]) return false;
  const chunkIdx = typeof q["source_chunk_index"] === "number" ? q["source_chunk_index"] : 0;
  if (!Number.isInteger(chunkIdx) || chunkIdx < 0 || chunkIdx >= chunks.length) return false;

  const qtype = typeof q["type"] === "string" ? q["type"] : "";
  let traceTerms: string[] = [];
  if (qtype === "single_choice" || qtype === "multi_choice") {
    const options = Array.isArray(q["options"]) ? (q["options"] as unknown[]) : [];
    const correct = q["correct_answer"];
    if (options.length < 4 || !correct) return false;
    traceTerms = answerTexts(q);
    if (traceTerms.length === 0) return false;
    if (qtype === "multi_choice") {
      if (!Array.isArray(correct) || correct.length < 2 || correct.length > 4) return false;
      if (traceTerms.length !== correct.length) return false;
    }
  } else if (qtype === "short_answer") {
    const keywords = Array.isArray(q["keywords"]) ? (q["keywords"] as unknown[]) : [];
    const answerText = typeof q["answer_template"] === "string" ? q["answer_template"] : "";
    if (keywords.length < 3 || !answerText) return false;
    traceTerms = keywords.map((k) => String(k));
  } else if (qtype === "essay") {
    const rubric = Array.isArray(q["scoring_rubric"]) ? (q["scoring_rubric"] as unknown[]) : [];
    const modelAnswer = typeof q["model_answer"] === "string" ? q["model_answer"] : "";
    if (!modelAnswer || rubric.length === 0) return false;
    for (const item of rubric) {
      if (item && typeof item === "object") {
        const kws = (item as { keywords?: unknown }).keywords;
        if (Array.isArray(kws)) traceTerms.push(...kws.map((k) => String(k)));
      }
    }
    traceTerms.push(modelAnswer);
  } else {
    return false;
  }

  const source = chunks[chunkIdx].content;
  traceTerms = traceTerms.filter((t) => t.length > 1);
  const traced =
    !trace ||
    (qtype === "multi_choice"
      ? traceTerms.every((term) => isTracedToSource([term], source))
      : traceTerms.length === 0 || isTracedToSource(traceTerms, source));
  if (!traced) q["_low_confidence"] = true;
  return true;
}

/** Normalize a validated question (correct_answer fallback + provenance). */
export function normalizeQuestion(q: QuizQuestionDict, chunks: Chunk[]): QuizQuestionDict {
  let out = { ...q };
  if (out["type"] === "short_answer") out = { ...out, correct_answer: out["answer_template"] };
  else if (out["type"] === "essay") out = { ...out, correct_answer: out["model_answer"] };
  const chunkIdx = typeof out["source_chunk_index"] === "number" ? out["source_chunk_index"] : 0;
  const chunk = chunks[chunkIdx];
  return {
    ...out,
    bvid: chunk?.bvid ?? "",
    page_index: chunk?.pageIndex,
    page_title: chunk?.pageTitle ?? chunk?.title ?? "",
    source_segment: chunk ? chunk.content.slice(0, 500) : "",
    question_uuid: randomUUID(),
  };
}

export function toQuestionPayload(q: QuizQuestionDict): AgentQuestionPayload {
  const correct = q["correct_answer"];
  return {
    question: String(q["question"] ?? ""),
    question_type: typeof q["type"] === "string" ? q["type"] : undefined,
    difficulty: typeof q["difficulty"] === "string" ? q["difficulty"] : undefined,
    options: Array.isArray(q["options"]) ? (q["options"] as unknown[]).map((o) => String(o)) : undefined,
    answer: typeof correct === "string" ? correct : undefined,
    correct_answer: correct,
    explanation: String(q["explanation"] ?? ""),
    keywords: Array.isArray(q["keywords"]) ? (q["keywords"] as unknown[]).map((k) => String(k)) : undefined,
    // 来源溯源 + 富字段(错题本/导出/判分依赖这些元数据)
    ...(q["bvid"] ? { bvid: String(q["bvid"]) } : {}),
    ...(Number.isInteger(q["page_index"]) ? { page_index: q["page_index"] as number } : {}),
    ...(q["page_title"] ? { page_title: String(q["page_title"]) } : {}),
    ...(q["source_segment"] ? { source_segment: String(q["source_segment"]) } : {}),
    ...(q["answer_template"] ? { answer_template: String(q["answer_template"]) } : {}),
    ...(Array.isArray(q["scoring_rubric"]) ? { scoring_rubric: q["scoring_rubric"] } : {}),
    ...(q["model_answer"] ? { model_answer: String(q["model_answer"]) } : {}),
  };
}

/**
 * Fallback extraction when the gateway model can't honor JSON-schema response
 * format (glm flash family): pull the outermost JSON array out of the raw text
 * and validate it against the same zod schema. undefined = nothing usable.
 */
export function extractQuestionArray(text: string): QuizQuestionDict[] | undefined {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    // flash 模型常见小偏差归一化:step number→string、keywords/正确答案 string→array、
    // points "10"→10(schema 各字段类型固定,模型偶发输出另一种 JSON 形态)
    const splitList = (v: unknown): unknown =>
      Array.isArray(v)
        ? v
        : typeof v === "string"
          ? v.split(/[,，、;；\s]+/).map((s) => s.trim()).filter((s) => s.length > 0)
          : v;
    for (const q of parsed as QuizQuestionDict[]) {
      if (!q || typeof q !== "object") continue;
      const rec = q as Record<string, unknown>;
      // 字段别名归一:模型偶发用 stem/question_text 代替 question
      if (rec["question"] === undefined) {
        if (typeof rec["stem"] === "string") rec["question"] = rec["stem"];
        else if (typeof rec["question_text"] === "string") rec["question"] = rec["question_text"];
      }
      if (rec["keywords"] !== undefined) rec["keywords"] = splitList(rec["keywords"]);
      if (rec["type"] === "multi_choice" && typeof rec["correct_answer"] === "string") {
        rec["correct_answer"] = splitList(rec["correct_answer"]);
      }
      const rubric = rec["scoring_rubric"];
      if (Array.isArray(rubric)) {
        for (const item of rubric) {
          if (!item || typeof item !== "object") continue;
          const r = item as Record<string, unknown>;
          if (typeof r["step"] === "number") r["step"] = String(r["step"]);
          if (r["keywords"] !== undefined) r["keywords"] = splitList(r["keywords"]);
          if (typeof r["points"] === "string" && /^\d+(\.\d+)?$/.test(r["points"] as string)) {
            r["points"] = Number(r["points"]);
          }
        }
      }
    }
    return parsed as QuizQuestionDict[];
  } catch {
    return undefined;
  }
}

// ── generation schema + LLM call ─────────────────────────────────────

const rubricSchema = z.object({
  step: z.string(),
  points: z.number(),
  keywords: z.array(z.string()).min(1).max(5),
});
const baseQuestion = {
  difficulty: z.enum(["easy", "medium", "hard"]),
  source_chunk_index: z.number().int().min(0),
  question: z.string(),
  explanation: z.string(),
  related_entities: z.array(z.string()).max(5).default([]),
};
export const quizBatchSchema = z.object({
  questions: z
    .array(
      z.discriminatedUnion("type", [
        z.object({ ...baseQuestion, type: z.literal("single_choice"), options: z.array(z.string()).min(4).max(4), correct_answer: z.string() }),
        z.object({ ...baseQuestion, type: z.literal("multi_choice"), options: z.array(z.string()).min(4).max(6), correct_answer: z.array(z.string()).min(2).max(4) }),
        z.object({ ...baseQuestion, type: z.literal("short_answer"), keywords: z.array(z.string()).min(3).max(5), answer_template: z.string() }),
        z.object({ ...baseQuestion, type: z.literal("essay"), model_answer: z.string(), scoring_rubric: z.array(rubricSchema).min(1).max(6) }),
      ]),
    )
    .min(1)
    .max(20),
});

export type QuizBatchGenerator = (args: { system: string; prompt: string; uid: string }) => Promise<QuizQuestionDict[]>;

const defaultGenerator: QuizBatchGenerator = async (args) => {
  const { object } = await generateObject({
    // 结构化输出对 JSON Schema 遵循度要求高:固定用强遵循模型(见 config llm.quizModel)
    model: createGatewayModel("quiz", { uid: args.uid, temperature: 0.7, model: config.llm.quizModel || undefined }),
    schema: quizBatchSchema,
    system: args.system,
    prompt: args.prompt,
    maxRetries: 2,
    ...aiTelemetry("quiz.generate"),
  });
  return object.questions as unknown as QuizQuestionDict[];
};

// ── service ──────────────────────────────────────────────────────────

export class QuizGenerationError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "QuizGenerationError";
  }
}

export interface FolderOrPageSource {
  folderIds?: number[];
  pages?: Array<{ bvid: string; cid?: number; page_index?: number; page_title?: string }>;
  questionCount: number;
  difficulty: string;
  title?: string;
}

export interface QuizGenerationDeps {
  summaries: SessionSummaryService;
  appQuiz: AppQuizClient;
  /** vector store for folder/pages source retrieval (absent = source mode disabled) */
  rag?: RAGService;
  /** folder_ids → bvids (app-kg ResolveScope); absent = folder mode unsupported */
  resolveFolderScope?: (uid: string, folderIds: number[]) => Promise<string[]>;
  /** injectable for tests; default = gateway generateObject */
  generate?: QuizBatchGenerator;
  /** LLM 文案统一走 prompts/（quiz-batch-system / quiz-batch-user），代码不内嵌提示词 */
  prompts: PromptRegistry;
}

/** Diversified queries used to pull quiz material out of the vector store. */
export const QUIZ_RETRIEVAL_QUERIES = [
  "概念 定义 原理 什么是",
  "方法 步骤 流程 怎么做",
  "原因 为什么 机制 背景",
  "特点 优势 区别 对比",
  "应用 场景 案例 实例",
];

/** Folder-mode type distribution (Python quiz_generator.run_generation parity). */
export function folderTypeDistribution(questionCount: number): Record<string, number> {
  const dist: Record<string, number> = {
    single_choice: Math.max(2, Math.floor(questionCount / 3)),
    multi_choice: Math.max(1, Math.floor(questionCount / 4)),
    short_answer: Math.max(1, Math.floor(questionCount / 4)),
    essay: Math.max(1, Math.floor(questionCount / 5)),
  };
  const total = Object.values(dist).reduce((a, b) => a + b, 0);
  if (total !== questionCount) dist.single_choice += questionCount - total;
  return dist;
}

/** Dedupe + page-filter raw retrieval hits into quiz chunks. */
export function collectChunks(
  docs: Document[],
  seen: Set<string>,
  target: number,
  pageLookup?: Map<string, string>,
  out: Chunk[] = [],
): Chunk[] {
  for (const doc of docs) {
    if (out.length >= target) return out;
    const bvid = String(doc.metadata.bvid ?? "");
    const pageIndex = Number(doc.metadata.pageIndex ?? 0);
    const chunkIndex = doc.metadata.chunkIndex;
    const chunkId = doc.metadata.chunkId || bvid + ":" + (chunkIndex ?? 0);
    if (seen.has(chunkId) || doc.text.length < 100) continue;
    if (pageLookup && !pageLookup.has(bvid + ":" + pageIndex)) continue;
    seen.add(chunkId);
    out.push({
      bvid,
      pageIndex,
      pageTitle: pageLookup?.get(bvid + ":" + pageIndex) ?? doc.metadata.pageTitle ?? "",
      title: doc.metadata.title ?? "",
      content: doc.text.slice(0, 3000),
    });
  }
  return out;
}

export class QuizGenerationService {
  private readonly generate: QuizBatchGenerator;

  constructor(private readonly deps: QuizGenerationDeps) {
    this.generate = deps.generate ?? defaultGenerator;
  }

  /** Validate + create the generating row; generation runs in the background. */
  async startFromSummary(uid: string, chatSessionId: string, questionCount: number, difficulty: string): Promise<{ quiz_uuid: string; status: string }> {
    if (!Number.isInteger(questionCount) || questionCount < 1 || questionCount > 5) {
      throw new Error("question_count 须在 1-5 之间");
    }
    const diff = ALLOWED_DIFFICULTIES.includes(difficulty) ? difficulty : "medium";
    const session = await this.deps.summaries.ensureSession(uid, chatSessionId, "会话暂无消息，无法出题");
    const title = this.defaultTitle(session.title);
    const distribution = defaultTypeDistribution(questionCount);

    const created = await this.deps.appQuiz.createSet(uid, {
      title,
      difficulty: diff,
      questionCount,
      typeDistribution: distribution,
      folderIds: [],
      sourceType: "session_summary",
      chatSessionId,
      status: "generating",
      totalScore: 100,
      passingScore: 60,
    });

    void this.runGeneration(uid, chatSessionId, created.quiz_uuid, questionCount, diff);
    return { quiz_uuid: created.quiz_uuid, status: "generating" };
  }

  /**
   * Validate + create the generating row for a folder / explicit-pages source;
   * retrieval + generation run in the background (frontend polls /quiz/{uuid}).
   */
  async startFromSource(uid: string, source: FolderOrPageSource): Promise<{ quiz_uuid: string; status: string }> {
    if (!this.deps.rag) throw new QuizGenerationError("知识库检索未启用", 503);
    const folderIds = source.folderIds ?? [];
    const pages = source.pages ?? [];
    if (folderIds.length === 0 && pages.length === 0) {
      throw new QuizGenerationError("请提供 folder_ids 或 pages", 400);
    }
    if (!Number.isInteger(source.questionCount) || source.questionCount < 1 || source.questionCount > 50) {
      throw new QuizGenerationError("question_count 须在 1-50 之间", 400);
    }
    const difficulty = ALLOWED_DIFFICULTIES.includes(source.difficulty) ? source.difficulty : "medium";
    const isPages = pages.length > 0;

    // Preflight: enough retrievable chunks before creating a row (immediate 400
    // instead of a 30s poll that ends in "failed").
    const preflight = await this.retrieveSourceChunks(uid, folderIds, pages, source.questionCount);
    if (preflight.length === 0) {
      throw new QuizGenerationError(
        isPages ? "未检索到可用知识片段，请先向量化所选分P" : "收藏夹内没有已向量化的视频，请先同步并构建知识库",
        400,
      );
    }

    // Quota, two-phase: peek before creating the row, consume after it exists.
    await this.deps.appQuiz.quotaPeek(uid, "generate");
    const distribution = folderTypeDistribution(source.questionCount);
    const created = await this.deps.appQuiz.createSet(uid, {
      title: (source.title && source.title.trim()) || this.folderTitle(),
      difficulty,
      questionCount: source.questionCount,
      typeDistribution: distribution,
      folderIds: isPages ? [] : folderIds,
      sourceType: isPages ? "pages" : "folder",
      sourcePages: isPages
        ? pages.map((p) => ({
            bvid: p.bvid,
            cid: p.cid,
            page_index: p.page_index ?? 0,
            page_title: p.page_title,
          }))
        : undefined,
      status: "generating",
      totalScore: 100,
      passingScore: 60,
    });
    await this.deps.appQuiz.quotaConsume(uid, "generate");

    void this.runSourceGeneration(uid, created.quiz_uuid, folderIds, pages, source.questionCount, difficulty, distribution);
    return { quiz_uuid: created.quiz_uuid, status: "generating" };
  }

  private folderTitle(): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return "练习 " + pad(now.getUTCMonth() + 1) + "-" + pad(now.getUTCDate()) + " " + pad(now.getUTCHours()) + ":" + pad(now.getUTCMinutes());
  }

  private async runSourceGeneration(
    uid: string,
    quizUuid: string,
    folderIds: number[],
    pages: NonNullable<FolderOrPageSource["pages"]>,
    questionCount: number,
    difficulty: string,
    distribution: Record<string, number>,
  ): Promise<void> {
    try {
      const chunks = await this.retrieveSourceChunks(uid, folderIds, pages, questionCount);
      const minChunks = Math.max(1, Math.floor(questionCount / 5));
      if (chunks.length < minChunks) {
        throw new Error("可用知识片段不足: " + chunks.length + " < " + minChunks);
      }
      await this.generateAndFinalize(uid, quizUuid, chunks, questionCount, difficulty, distribution);
    } catch (err) {
      await this.failGeneration(uid, quizUuid, err);
    }
  }

  /** Milvus retrieval for folder/pages sources (diversified queries + dedupe). */
  private async retrieveSourceChunks(
    uid: string,
    folderIds: number[],
    pages: NonNullable<FolderOrPageSource["pages"]>,
    questionCount: number,
  ): Promise<Chunk[]> {
    const rag = this.deps.rag;
    if (!rag) return [];
    const target = questionCount * 2;
    let bvids: string[] = [];
    let pageLookup: Map<string, string> | undefined;
    if (pages.length > 0) {
      bvids = [...new Set(pages.map((p) => p.bvid))];
      pageLookup = new Map(pages.map((p) => [p.bvid + ":" + (p.page_index ?? 0), p.page_title ?? ""]));
    } else {
      bvids = this.deps.resolveFolderScope ? await this.deps.resolveFolderScope(uid, folderIds) : [];
    }
    if (bvids.length === 0) return [];

    const seen = new Set<string>();
    let chunks: Chunk[] = [];
    for (const query of QUIZ_RETRIEVAL_QUERIES) {
      let docs: Document[] = [];
      try {
        docs = await rag.search(query, 5, { bvids });
      } catch (err) {
        log.warn("[QUIZ_GEN] retrieval failed query=" + query + ": " + (err instanceof Error ? err.message : String(err)));
        continue;
      }
      chunks = collectChunks(docs, seen, target, pageLookup, chunks);
      if (chunks.length >= target) break;
    }
    return chunks;
  }

  /** Shared generate → validate → finalize tail (fail path marks the row failed). */
  private async generateAndFinalize(
    uid: string,
    quizUuid: string,
    chunks: Chunk[],
    questionCount: number,
    difficulty: string,
    distribution: Record<string, number>,
  ): Promise<void> {
    try {
      const generated = await this.generateQuestions({
        chunks,
        totalCount: questionCount,
        typeDistribution: distribution,
        difficulty,
        uid,
      });
      const valid = generated.filter((q) => validateQuestion(q, chunks));
      const threshold = Math.max(1, Math.floor(questionCount * 0.6));
      if (valid.length < threshold) {
        throw new Error("有效题目数量不足: " + valid.length + " < " + threshold + " (60% threshold)");
      }
      const normalized = valid.map((q) => normalizeQuestion(q, chunks));
      const status = valid.length >= questionCount ? "done" : "partial";
      const bvidCount = new Set(
        normalized.map((q) => String(q["bvid"] ?? "")).filter((b) => b.length > 0),
      ).size;
      await this.deps.appQuiz.finalizeSet(uid, quizUuid, normalized.map(toQuestionPayload), status, undefined, bvidCount);
      log.info("[QUIZ_GEN] generated quiz_uuid=" + quizUuid + " questions=" + valid.length + " status=" + status);
    } catch (err) {
      await this.failGeneration(uid, quizUuid, err);
    }
  }

  private async failGeneration(uid: string, quizUuid: string, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    log.error("[QUIZ_GEN] generation failed quiz_uuid=" + quizUuid + ": " + message);
    try {
      await this.deps.appQuiz.failSet(uid, quizUuid, message);
    } catch (failErr) {
      log.error("[QUIZ_GEN] failSet failed quiz_uuid=" + quizUuid + ": " + (failErr instanceof Error ? failErr.message : String(failErr)));
    }
  }

  private defaultTitle(sessionTitle: string | undefined): string {
    const prefix = sessionTitle ? "来自会话：" + sessionTitle : "会话总结题目";
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    // UTC, matching the Python datetime.now(timezone.utc) title suffix
    return prefix + " " + pad(now.getUTCMonth() + 1) + "-" + pad(now.getUTCDate()) + " " + pad(now.getUTCHours()) + ":" + pad(now.getUTCMinutes());
  }

  /** Background body: never throws (failures mark the quiz set failed). */
  private async runGeneration(uid: string, chatSessionId: string, quizUuid: string, questionCount: number, difficulty: string): Promise<void> {
    try {
      const summary = (await this.deps.summaries.getOrCreateContent(uid, chatSessionId)).trim();
      if (summary.length < MIN_SUMMARY_CHARS) {
        throw new Error("会话总结内容过短（" + summary.length + " 字），不足以出题");
      }
      const chunks = splitSummaryToChunks(summary);
      if (chunks.length === 0) throw new Error("会话总结无法切分出有效内容，无法出题");

      const distribution = defaultTypeDistribution(questionCount);
      const generated = await this.generateQuestions({ chunks, totalCount: questionCount, typeDistribution: distribution, difficulty, uid });
      const valid = generated.filter((q) => validateQuestion(q, chunks));
      const threshold = Math.max(1, Math.floor(questionCount * 0.6));
      if (valid.length < threshold) {
        throw new Error("有效题目数量不足: " + valid.length + " < " + threshold + " (60% threshold)");
      }
      const normalized = valid.map((q) => normalizeQuestion(q, chunks));
      const status = valid.length >= questionCount ? "done" : "partial";
      await this.deps.appQuiz.finalizeSet(uid, quizUuid, normalized.map(toQuestionPayload), status);
      log.info("[QUIZ_GEN] generated quiz_uuid=" + quizUuid + " questions=" + valid.length + " status=" + status);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("[QUIZ_GEN] generation failed quiz_uuid=" + quizUuid + ": " + message);
      try {
        await this.deps.appQuiz.failSet(uid, quizUuid, message);
      } catch (failErr) {
        log.error("[QUIZ_GEN] failSet failed quiz_uuid=" + quizUuid + ": " + (failErr instanceof Error ? failErr.message : String(failErr)));
      }
    }
  }

  /** AI 自由出题批量生成:不依赖知识库片段,主题 + 错题材料 + 难度阶梯直驱 prompt。 */
  private async generateFreeBatch(args: {
    batchCount: number;
    batchTypes: string[];
    uid: string;
    free: { topic: string; material: string; difficultyPlan: string };
  }): Promise<QuizQuestionDict[]> {
    const counts = new Map<string, number>();
    for (const t of args.batchTypes) counts.set(t, (counts.get(t) ?? 1) + 1);
    const typeDesc = [...counts.entries()].map(([k, n]) => n + "道" + k).join("、");
    const material = args.free.material.trim() || "（无附加材料，围绕主题自由发挥）";
    const prompt = this.deps.prompts.render("quiz-free-user", {
      TOPIC: args.free.topic.slice(0, 500),
      TOTAL_COUNT: String(args.batchCount),
      TYPE_DISTRIBUTION: typeDesc,
      DIFFICULTY_PLAN: args.free.difficultyPlan,
      MATERIAL: "<error_material>\n" + material.slice(0, MAX_CONTEXT_CHARS) + "\n</error_material>",
    });
    try {
      return await this.generateRepaired({
        system: this.deps.prompts.render("quiz-free-system", {}),
        prompt,
        uid: args.uid,
      });
    } catch (err) {
      log.error("[QUIZ_GEN] free structured output failed: " + (err instanceof Error ? err.message : String(err)));
      return [];
    }
  }

  /**
   * AI 出题入口(free / 错题强化)——不依赖知识库。free 模式围绕用户给定的主题
   * 自由出题;wrong_answers 模式读取错题本构建错误画像,针对薄弱知识点出由易
   * 到难的变式新题。题集仍经 app-quiz 落库(source_type=ai_free / ai_wrong)。
   */
  async startAIGenerated(
    uid: string,
    source: { mode: "free" | "wrong_answers"; topic?: string; questionCount: number; difficulty?: string; title?: string },
  ): Promise<{ quiz_uuid: string; status: string }> {
    if (!Number.isInteger(source.questionCount) || source.questionCount < 1 || source.questionCount > 20) {
      throw new QuizGenerationError("question_count 须在 1-20 之间", 400);
    }
    const difficulty = ALLOWED_DIFFICULTIES.includes(source.difficulty ?? "") ? source.difficulty! : "medium";
    const topic = (source.topic ?? "").trim();

    // 错题强化：先确认错题画像存在（无错题 → 立即 400，不产生空的 generating 行）
    let profile: { entries: WrongAnswerEntry[]; totalWrong: number } | null = null;
    if (source.mode === "wrong_answers") {
      profile = await this.buildErrorProfile(uid);
      if (!profile) throw new QuizGenerationError("暂无错题记录，先完成一次练习并提交后再来强化吧", 400);
    }

    await this.deps.appQuiz.quotaPeek(uid, "generate");
    const title =
      (source.title && source.title.trim()) ||
      (source.mode === "wrong_answers"
        ? this.aiTitle("错题强化")
        : topic
          ? this.aiTitle(topic.slice(0, 30))
          : this.aiTitle("AI 自由出题"));
    const distribution = defaultTypeDistribution(source.questionCount);
    const created = await this.deps.appQuiz.createSet(uid, {
      title,
      difficulty,
      questionCount: source.questionCount,
      typeDistribution: distribution,
      folderIds: [],
      sourceType: source.mode === "wrong_answers" ? "ai_wrong_answers" : "ai_free",
      status: "generating",
      totalScore: 100,
      passingScore: 60,
    });
    await this.deps.appQuiz.quotaConsume(uid, "generate");

    void this.runAIGeneration(uid, created.quiz_uuid, source.mode, topic, source.questionCount, difficulty, distribution, profile ?? undefined);
    return { quiz_uuid: created.quiz_uuid, status: "generating" };
  }

  private aiTitle(prefix: string): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return prefix + " " + pad(now.getUTCMonth() + 1) + "-" + pad(now.getUTCDate()) + " " + pad(now.getUTCHours()) + ":" + pad(now.getUTCMinutes());
  }

  /** 错题画像:错题本 top 条目(按错误次数排序)渲染为出题材料。无错题 → null。 */
  private async buildErrorProfile(uid: string): Promise<{ entries: WrongAnswerEntry[]; totalWrong: number } | null> {
    let entries: WrongAnswerEntry[];
    try {
      entries = await this.deps.appQuiz.wrongAnswers(uid, 20);
    } catch (err) {
      log.error("[QUIZ_GEN] wrong-answers read failed: " + (err instanceof Error ? err.message : String(err)));
      throw new QuizGenerationError("读取错题记录失败，请稍后重试", 503);
    }
    if (entries.length === 0) return null;
    entries.sort((a, b) => (b.times_wrong ?? 0) - (a.times_wrong ?? 0));
    return { entries, totalWrong: entries.length };
  }

  private static fmtAnswer(v: unknown): string {
    if (v === null || v === undefined) return "?";
    if (Array.isArray(v)) return v.map((x) => String(x)).join("、");
    return String(v).slice(0, 80);
  }

  private renderErrorProfile(entries: WrongAnswerEntry[]): string {
    const lines = entries.map((e, i) => {
      const parts = [
        (e.times_wrong > 1 ? `[错 ${e.times_wrong} 次] ` : "") + `题目：${String(e.question_text ?? "").slice(0, 150)}`,
        `用户答案：${QuizGenerationService.fmtAnswer(e.user_answer)}｜正确答案：${QuizGenerationService.fmtAnswer(e.correct_answer)}`,
        e.explanation ? `解析：${String(e.explanation).slice(0, 150)}` : "",
      ].filter(Boolean);
      return `${i + 1}. ${parts.join(" | ")}`;
    });
    return (
      `用户历史错题共 ${entries.length} 条（按错误次数降序），这些是薄弱知识点：\n` +
      lines.join("\n") +
      `\n出题要求：围绕上述薄弱知识点出同主题的变式新题（考查点一致但题干、选项、角度必须全新）；` +
      `由易到难：前 1/3 用 easy 巩固基础，中 1/3 用 medium 检验掌握，后 1/3 用 hard 综合拔高。`
    );
  }

  private async runAIGeneration(
    uid: string,
    quizUuid: string,
    mode: "free" | "wrong_answers",
    topic: string,
    questionCount: number,
    difficulty: string,
    distribution: Record<string, number>,
    profile?: { entries: WrongAnswerEntry[]; totalWrong: number },
  ): Promise<void> {
    try {
      let material = "";
      let effectiveTopic = topic || "通识综合练习";
      if (mode === "wrong_answers") {
        const resolved = profile ?? (await this.buildErrorProfile(uid));
        if (!resolved) {
          throw new QuizGenerationError("暂无错题记录，先完成一次练习并提交后再来强化吧", 400);
        }
        material = this.renderErrorProfile(resolved.entries);
        effectiveTopic = topic || "针对历史错题暴露的薄弱知识点进行强化训练";
      }
      const difficultyPlan =
        mode === "wrong_answers"
          ? "按错题画像的出题要求执行由易到难"
          : `以 ${difficulty} 为主，整体由易到难排列（先基础概念，后综合应用）`;
      const chunks: Chunk[] = [{ title: mode === "wrong_answers" ? "错题画像" : "出题主题", content: material || effectiveTopic }];
      const generated = await this.generateQuestions({
        chunks,
        totalCount: questionCount,
        typeDistribution: distribution,
        difficulty,
        uid,
        free: { topic: effectiveTopic, material, difficultyPlan },
      });
      const valid = generated.filter((q) => validateQuestion(q, chunks, { trace: false }));
      const threshold = Math.max(1, Math.floor(questionCount * 0.6));
      if (valid.length < threshold) {
        throw new Error("有效题目数量不足: " + valid.length + " < " + threshold);
      }
      const normalized = valid.map((q) => normalizeQuestion(q, chunks));
      const status = valid.length >= questionCount ? "done" : "partial";
      await this.deps.appQuiz.finalizeSet(uid, quizUuid, normalized.map(toQuestionPayload), status);
      log.info(`[QUIZ_GEN] ai quiz generated quiz_uuid=${quizUuid} mode=${mode} questions=${valid.length} status=${status}`);
    } catch (err) {
      await this.failGeneration(uid, quizUuid, err);
    }
  }

  /**
   * generate + repair: when the model's text output fails schema validation
   * (NoObjectGeneratedError), salvage the JSON array from the raw text and
   * re-validate with the same zod schema before giving up.
   */
  private async generateRepaired(args: { system: string; prompt: string; uid: string }): Promise<QuizQuestionDict[]> {
    try {
      return await this.generate(args);
    } catch (err) {
      const raw = (err as { text?: unknown }).text;
      if (typeof raw !== "string") throw err;
      const salvaged = extractQuestionArray(raw);
      if (!salvaged?.length) throw err;
      const parsed = quizBatchSchema.safeParse({ questions: salvaged });
      if (!parsed.success) {
        log.warn(
          "[QUIZ_GEN] raw-text salvage failed schema: " +
            parsed.error.issues.slice(0, 3).map((i) => i.path.join(".") + " " + i.message).join("; ") +
            " | raw=" + raw.slice(0, 300),
        );
        throw err;
      }
      log.warn("[QUIZ_GEN] salvaged questions from raw model text (" + parsed.data.questions.length + ")");
      return parsed.data.questions as unknown as QuizQuestionDict[];
    }
  }

  /** Batch generation loop (Python generate_questions parity, batchSize=5). */
  async generateQuestions(args: {
    chunks: Chunk[];
    totalCount: number;
    typeDistribution: Record<string, number>;
    difficulty: string;
    uid: string;
    batchSize?: number;
    /** AI 自由出题(free / 错题强化):不依赖知识库片段,跳过原文溯源校验 */
    free?: { topic: string; material: string; difficultyPlan: string };
  }): Promise<QuizQuestionDict[]> {
    const batchSize = args.batchSize ?? 5;
    const typeList: string[] = [];
    for (const [qtype, count] of Object.entries(args.typeDistribution)) {
      for (let i = 0; i < count; i += 1) typeList.push(qtype);
    }

    const all: QuizQuestionDict[] = [];
    const usedChunkIndices = new Set<number>();
    const seen = new Set<string>();
    const rounds = Math.floor(args.totalCount / batchSize) + 3;

    for (let round = 0; round < rounds; round += 1) {
      const remaining = args.totalCount - all.length;
      if (remaining <= 0) break;
      const batchCount = Math.min(batchSize, remaining);
      const batchTypes = typeList.slice(all.length, all.length + batchCount);
      const batch = await this.generateBatch({
        chunks: args.chunks,
        batchCount,
        batchTypes,
        difficulty: args.difficulty,
        uid: args.uid,
        usedChunkIndices,
        free: args.free,
      });
      for (const q of batch) {
        const text = String(q["question"] ?? "").trim();
        if (!text || seen.has(text)) continue;
        if (!validateQuestion(q, args.chunks, { trace: !args.free })) continue;
        seen.add(text);
        all.push(q);
        if (all.length >= args.totalCount) break;
      }
    }
    return all.slice(0, args.totalCount);
  }

  private async generateBatch(args: {
    chunks: Chunk[];
    batchCount: number;
    batchTypes: string[];
    difficulty: string;
    uid: string;
    usedChunkIndices: Set<number>;
    free?: { topic: string; material: string; difficultyPlan: string };
  }): Promise<QuizQuestionDict[]> {
    if (args.batchCount <= 0 || args.batchCount > MAX_BATCH_COUNT) return [];
    if (args.batchTypes.length > MAX_BATCH_SIZE) return [];
    if (!ALLOWED_DIFFICULTIES.includes(args.difficulty)) return [];

    if (args.free) {
      return this.generateFreeBatch({
        batchCount: args.batchCount,
        batchTypes: args.batchTypes,
        uid: args.uid,
        free: args.free,
      });
    }

    const available = args.chunks.map((_, i) => i).filter((i) => !args.usedChunkIndices.has(i));
    const pool = available.length > 0 ? available : args.chunks.map((_, i) => i);
    const selected = pool.slice(0, Math.max(3, args.batchCount));

    const parts: string[] = [];
    let contextChars = 0;
    for (const i of selected) {
      const chunk = args.chunks[i];
      const title = chunk.title.slice(0, 200);
      const body = chunk.content.slice(0, MAX_CHUNK_CHARS);
      const part = '<knowledge_chunk index="' + i + '">\n<title>' + title + "</title>\n<content>" + body + "</content>\n</knowledge_chunk>";
      if (parts.length > 0 && contextChars + part.length > MAX_CONTEXT_CHARS) break;
      parts.push(part);
      contextChars += part.length;
      args.usedChunkIndices.add(i);
    }
    const context = parts.join("\n\n");

    const counts = new Map<string, number>();
    for (const t of args.batchTypes) counts.set(t, (counts.get(t) ?? 0) + 1);
    const typeDesc = [...counts.entries()].map(([t, n]) => n + "道" + t).join("、");
    const prompt = this.deps.prompts.render("quiz-batch-user", {
      CHUNK_COUNT: String(selected.length),
      TOTAL_COUNT: String(args.batchCount),
      CONTEXT: context,
      TYPE_DISTRIBUTION: typeDesc,
      DIFFICULTY: args.difficulty,
    });

    try {
      return await this.generateRepaired({ system: this.deps.prompts.render("quiz-batch-system", {}), prompt, uid: args.uid });
    } catch (err) {
      log.error("[QUIZ_GEN] structured output failed: " + (err instanceof Error ? err.message : String(err)));
      return [];
    }
  }
}
