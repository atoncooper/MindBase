import { createHash } from "node:crypto";
import type { ExtractedEntity, ExtractedRelation, ExtractionResult, ResolvedEntity, ResolvedExtraction, ResolvedRelation } from "./types.js";

/**
 * KG resolver — normalization + validation of raw LLM extractions, a faithful
 * port of app/services/kg/resolver.py (pure functions, independently testable).
 *
 * Anti-hallucination is the core contract: every relation MUST carry an
 * original-text quote of at least minQuoteChars, endpoints must resolve to
 * known entities (unknown ones become `other` stubs to preserve recall),
 * self-loops are dropped, per-batch dedup + hard caps apply.
 */

/** Canonical entity type enum (aligned with the Neo4j Entity.type values). */
export const CANONICAL_TYPES = new Set([
  "person",
  "org",
  "concept",
  "tech",
  "tool",
  "book",
  "event",
  "method",
  "place",
  "other",
]);

/** Chinese/English alias → canonical type. */
const TYPE_ALIAS_MAP: Record<string, string> = {
  人物: "person", 人名: "person", 人: "person", 作者: "person",
  up主: "person", up: "person", 专家: "person", 讲师: "person",
  组织: "org", 机构: "org", 公司: "org", 团队: "org", 企业: "org",
  概念: "concept", 理论: "concept", 术语: "concept", 学科: "concept",
  技术: "tech", 框架: "tech", 语言: "tech", 协议: "tech",
  算法: "tech", 模型: "tech", 架构: "tech", 标准: "tech",
  工具: "tool", 软件: "tool", 库: "tool", 平台: "tool",
  产品: "tool", 服务: "tool", 网站: "tool",
  书: "book", 书籍: "book", 论文: "book", 著作: "book", 教材: "book",
  事件: "event", 会议: "event", 历史事件: "event",
  方法: "method", 方法论: "method", 流程: "method", 实践: "method",
  技巧: "method", 策略: "method",
  地点: "place", 位置: "place", 国家: "place", 城市: "place",
  其他: "other",
  people: "person", company: "org", organization: "org",
  technology: "tech", framework: "tech", library: "tool",
  software: "tool", paper: "book", conference: "event",
};

export const DEFAULT_MIN_QUOTE_CHARS = 8;
export const DEFAULT_MAX_ENTITIES = 30;
export const DEFAULT_MAX_RELATIONS = 40;
export const MAX_NAME_LEN = 100;

/** Entity-name normalization key: lowercase + whitespace collapse.
 * The SINGLE implementation — eid and the graph merge key both derive from it. */
export function normalizeName(name: string): string {
  return (name ?? "")
    .trim()
    .split(/\s+/)
    .filter((part) => part !== "")
    .join(" ")
    .toLowerCase();
}

/** Deterministic entity id: sha1(normalized name) hex, first 16 chars.
 * Must stay byte-compatible with Python's eid_for_name (sha1 over utf-8). */
export function eidForName(name: string): string {
  return createHash("sha1").update(normalizeName(name), "utf8").digest("hex").slice(0, 16);
}

/** Any input → canonical entity type; unrecognized falls back to `other`. */
export function normalizeEntityType(raw: string | undefined | null): string {
  const key = (raw ?? "").trim().toLowerCase();
  if (!key) return "other";
  if (CANONICAL_TYPES.has(key)) return key;
  const mapped = TYPE_ALIAS_MAP[key];
  if (mapped && CANONICAL_TYPES.has(mapped)) return mapped;
  return "other";
}

export interface ResolveOptions {
  minQuoteChars?: number;
  maxEntities?: number;
  maxRelations?: number;
}

/** Clean an LLM extraction into graph-ready form:
 * entity dedup by normalized key → relation endpoint resolution (stub
 * completion) → quote enforcement → caps. */
export function resolveExtraction(
  result: ExtractionResult,
  opts: ResolveOptions = {},
): ResolvedExtraction {
  const minQuoteChars = opts.minQuoteChars ?? DEFAULT_MIN_QUOTE_CHARS;
  const maxEntities = opts.maxEntities ?? DEFAULT_MAX_ENTITIES;
  const maxRelations = opts.maxRelations ?? DEFAULT_MAX_RELATIONS;

  const entities: ResolvedEntity[] = [];
  const byKey = new Map<string, ResolvedEntity>();

  for (const ent of result.entities ?? []) {
    const name = (ent.name ?? "").trim();
    if (!name || name.length > MAX_NAME_LEN) continue;
    const key = normalizeName(name);
    if (!key) continue;
    const desc = (ent.description ?? "").trim();
    const quote = (ent.quote ?? "").trim().slice(0, 300);
    const existing = byKey.get(key);
    if (!existing) {
      const resolved: ResolvedEntity = {
        eid: eidForName(name),
        name,
        nameLower: key,
        type: normalizeEntityType(ent.type),
        description: desc,
        quote,
      };
      byKey.set(key, resolved);
      entities.push(resolved);
    } else {
      if (!existing.description && desc) existing.description = desc;
      if (!existing.quote && quote) existing.quote = quote;
    }
  }
  const cappedEntities = entities.slice(0, maxEntities);

  const entityEid = (rawName: string): string | undefined => {
    const name = (rawName ?? "").trim();
    const key = normalizeName(name);
    if (!key || name.length > MAX_NAME_LEN) return undefined;
    const known = byKey.get(key);
    if (known) return known.eid;
    // Unknown endpoint → stub entity (appended beyond the cap, mirroring
    // Python) so relation recall survives under-referenced names.
    const stub: ResolvedEntity = {
      eid: eidForName(name),
      name,
      nameLower: key,
      type: "other",
      description: "",
      quote: "",
    };
    byKey.set(key, stub);
    cappedEntities.push(stub);
    return stub.eid;
  };

  const relations: ResolvedRelation[] = [];
  let droppedRelations = 0;
  const seenRel = new Set<string>();
  for (const rel of (result.relations ?? []) as ExtractedRelation[]) {
    if (relations.length >= maxRelations) break;
    const srcEid = entityEid(rel.src);
    const dstEid = entityEid(rel.dst);
    const quote = (rel.quote ?? "").trim().slice(0, 300);
    const relType = (rel.relationType ?? "").trim().slice(0, 50);
    if (!srcEid || !dstEid || srcEid === dstEid || !relType || quote.length < minQuoteChars) {
      droppedRelations += 1;
      continue;
    }
    const dedupKey = `${srcEid}|${dstEid}|${relType}`;
    if (seenRel.has(dedupKey)) continue;
    seenRel.add(dedupKey);
    relations.push({ srcEid, dstEid, relType, quote });
  }

  return { entities: cappedEntities, relations, droppedRelations };
}
