import { z } from "zod";
import { generateObject } from "ai";
import type { LanguageModel } from "ai";
import { createGatewayModel } from "../llm/provider.js";
import { createLogger } from "../logger.js";
import type { ExtractionResult } from "./types.js";

/**
 * KG extractor — LLM structured extraction from one page's ASR transcript,
 * port of app/services/kg/extractor.py. Single-shot generateObject (not the
 * ReAct tool-calling pattern: there is no loop here, one call per page).
 *
 * Anti-hallucination contract: every relation must quote the transcript —
 * enforcement lives in the resolver; this layer only shapes the schema and
 * the prompt. LLM failures throw so the caller can mark the page failed
 * (retryable) — never silently swallow.
 */

const log = createLogger("KG_EXTRACTOR");

export const extractedEntitySchema = z.object({
  name: z.string().describe("实体名称，尽量使用视频中出现的原文叫法"),
  type: z
    .string()
    .default("other")
    .describe("实体类型: person/org/concept/tech/tool/book/event/method/place/other"),
  description: z.string().default("").describe("一句话描述该实体在本视频中的含义或角色"),
  quote: z.string().default("").describe("原文中明确提到该实体的片段摘抄（20字以内），找不到就留空"),
});

export const extractedRelationSchema = z.object({
  src: z.string().describe("起点实体名，必须与 entities 中某个 name 一致"),
  dst: z.string().describe("终点实体名，必须与 entities 中某个 name 一致"),
  relationType: z.string().describe("关系动词短语，如 讲解了/使用了/提出了/对比了/依赖于/属于"),
  quote: z.string().describe("支持该关系的原文片段（直接摘抄，20字以内），禁止编造"),
});

export const extractionResultSchema = z.object({
  entities: z.array(extractedEntitySchema).default([]),
  relations: z.array(extractedRelationSchema).default([]),
});

export interface ExtractorOptions {
  /** injectable for tests; default = gateway model with purpose="kg" */
  model?: LanguageModel;
  systemPrompt: string;
  extractModel: string;
  maxTextChars: number;
}

export class KgExtractor {
  private readonly model?: LanguageModel;

  constructor(private readonly opts: ExtractorOptions) {
    this.model = opts.model;
  }

  /** Extract entities + relations from one page. Text is truncated to
   * maxTextChars (cost guard); throws on LLM failure (caller marks failed). */
  async extract(text: string, title: string): Promise<ExtractionResult> {
    const maxChars = this.opts.maxTextChars;
    const truncated = text.slice(0, maxChars);
    if (text.length > maxChars) {
      log.info(`[KG_EXTRACTOR] text truncated ${text.length} -> ${maxChars} chars`);
    }

    const userPrompt = `视频标题：${title || "（未知）"}\n\n文字稿：\n${truncated}`;
    const { object } = await generateObject({
      model: this.model ?? createGatewayModel("kg", { model: this.opts.extractModel, temperature: 0 }),
      schema: extractionResultSchema,
      system: this.opts.systemPrompt,
      prompt: userPrompt,
      temperature: 0,
      maxRetries: 2,
    });
    const result = object as unknown as ExtractionResult;
    log.info(`[KG_EXTRACTOR] extracted entities=${result.entities?.length ?? 0} relations=${result.relations?.length ?? 0}`);
    return {
      entities: result.entities ?? [],
      relations: (result.relations ?? []).map((r) => ({
        src: r.src,
        dst: r.dst,
        // AI SDK maps the zod field name; proto/python parity guard for snake_case models
        relationType: (r as { relationType?: string; relation_type?: string }).relationType ??
          (r as { relation_type?: string }).relation_type ?? "",
        quote: r.quote,
      })),
    };
  }
}
