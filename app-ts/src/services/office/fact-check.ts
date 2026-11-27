import type { DocumentIR } from "./ir.js";
import { normalizeForComparison, splitSentences } from "./content-quality.js";

/**
 * Fact-check stage for generated Word documents.
 *
 * The content engine writes data-heavy prose (percentages, multiples, 万/亿
 * magnitudes, counts). The quality gate can only flag "unsourced numbers"; it
 * has no way to know whether a claim is true. This module adds the missing
 * stage without coupling the engine to any specific verifier:
 *
 *   collectClaims(doc)  -> numeric claim sentences (deduped, capped)
 *   runFactCheck(doc, port) -> one FactCheckPort.verify call + Chinese summary
 *
 * The port is injected (LLM gateway, search API, human review queue ...), so the
 * engine and its tests stay offline and dependency-free. A missing/disabled
 * port or a failed verify call degrades to an explicit "not checked" message
 * instead of blocking document generation, and **the document is never edited
 * automatically** — findings are reported for a human/agent to act on.
 */

/** A sentence is worth checking when it carries a number/percentage/magnitude. */
const NUMERIC_CLAIM_PATTERN = /\d|%|％|百分之|倍|万|亿/;

/** Caps keep one verify call bounded regardless of document size. */
export const FACT_CHECK_LIMITS = {
  /** Max claim sentences sent to the port. */
  maxClaims: 30,
  /** Max characters kept per claim sentence. */
  maxClaimChars: 300,
  /** Max findings spelled out in the summary text. */
  maxDetailFindings: 12,
} as const;

export type FactCheckVerdict = "supported" | "unsupported" | "uncertain";

export interface FactCheckVerdictItem {
  claim: string;
  verdict: FactCheckVerdict;
  /** Free-text explanation from the verifier. */
  note?: string;
  /** Where the evidence came from (URL / document / dataset name). */
  source?: string;
}

/** Injected verification backend (LLM + tools, search API, manual queue, fake). */
export interface FactCheckPort {
  readonly enabled: boolean;
  verify(input: { claims: string[]; context?: string }): Promise<{ checked: FactCheckVerdictItem[] }>;
}

export interface FactCheckResult {
  /** false = no usable port / call failed; findings are empty then. */
  available: boolean;
  /** Claim sentences submitted for verification. */
  checkedCount: number;
  findings: FactCheckVerdictItem[];
  /** Chinese summary for the compose result / agent / UI. */
  text: string;
}

export interface FactCheckOptions {
  /** Extra document context handed to the verifier (default: title + section headings). */
  context?: string;
  /** Override the claim cap (1..FACT_CHECK_LIMITS.maxClaims). */
  maxClaims?: number;
}

/** Human-readable verdict labels used in the summary text. */
export const FACT_CHECK_VERDICT_LABEL: Readonly<Record<FactCheckVerdict, string>> = {
  supported: "有依据",
  unsupported: "无依据",
  uncertain: "待确认",
};

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function clampMaxClaims(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return FACT_CHECK_LIMITS.maxClaims;
  return Math.max(1, Math.min(FACT_CHECK_LIMITS.maxClaims, Math.floor(value)));
}

/**
 * Prose-like block texts eligible for claim extraction.
 *
 * Headings, captions, code, formulas and references are deliberately skipped:
 * a year in a section title ("2026 年第三季度") is not a factual assertion.
 * Table rows, list items, kv/metrics values are included because that is where
 * reports usually hide unsourced numbers.
 */
function claimSources(doc: DocumentIR): string[] {
  const parts: string[] = [];
  for (const section of doc.sections) {
    for (const block of section.blocks) {
      switch (block.type) {
        case "paragraph":
        case "line":
        case "quote":
          parts.push(block.text);
          break;
        case "callout":
          parts.push(block.text);
          break;
        case "orderedList":
        case "unorderedList":
          parts.push(...block.items);
          break;
        case "table":
          for (const row of block.rows) parts.push(row.join("，"));
          break;
        case "kv":
          for (const item of block.items) parts.push(item.label + "：" + item.value);
          break;
        case "metrics":
          for (const item of block.items) {
            parts.push(item.label + "：" + item.value + (item.note ? "（" + item.note + "）" : ""));
          }
          break;
        default:
          break;
      }
    }
  }
  return parts;
}

/**
 * Extracts numeric claim sentences from the document body.
 *
 * Sentences are split on Chinese/English sentence punctuation, normalized for
 * duplicate detection, and capped at FACT_CHECK_LIMITS.maxClaims. Pure function:
 * no I/O, no mutation, stable order (document order).
 */
export function collectClaims(doc: DocumentIR): string[] {
  const claims: string[] = [];
  const seen = new Set<string>();
  for (const part of claimSources(doc)) {
    for (const sentence of splitSentences(part)) {
      const claim = sentence.replace(/\s+/g, " ").trim();
      if (claim === "" || !NUMERIC_CLAIM_PATTERN.test(claim)) continue;
      const key = normalizeForComparison(claim);
      if (key === "" || seen.has(key)) continue;
      seen.add(key);
      claims.push(
        claim.length > FACT_CHECK_LIMITS.maxClaimChars
          ? claim.slice(0, FACT_CHECK_LIMITS.maxClaimChars) + "…"
          : claim,
      );
      if (claims.length >= FACT_CHECK_LIMITS.maxClaims) return claims;
    }
  }
  return claims;
}

/** Default verifier context: document title/subtitle + section headings. */
function describeDocument(doc: DocumentIR): string | undefined {
  const headings = doc.sections
    .map((section) => (section.heading ?? "").trim())
    .filter((heading) => heading !== "")
    .slice(0, 8);
  const text = [doc.title, doc.subtitle ?? "", ...headings]
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join("；");
  if (text === "") return undefined;
  return (text.length > 500 ? text.slice(0, 500) + "…" : text);
}

function normalizeFindings(
  checked: unknown,
  claims: string[],
): FactCheckVerdictItem[] {
  if (!Array.isArray(checked)) return [];
  const allowed = new Set<FactCheckVerdict>(["supported", "unsupported", "uncertain"]);
  const detailByClaim = new Map<string, FactCheckVerdictItem>();
  for (const entry of checked) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const claim = typeof record.claim === "string" ? record.claim.trim() : "";
    if (claim === "") continue;
    const verdict = typeof record.verdict === "string" && allowed.has(record.verdict as FactCheckVerdict)
      ? (record.verdict as FactCheckVerdict)
      : "uncertain";
    const note = typeof record.note === "string" && record.note.trim() !== "" ? record.note.trim().slice(0, 500) : undefined;
    const source = typeof record.source === "string" && record.source.trim() !== "" ? record.source.trim().slice(0, 300) : undefined;
    const item: FactCheckVerdictItem = {
      claim,
      verdict,
      ...(note !== undefined ? { note } : {}),
      ...(source !== undefined ? { source } : {}),
    };
    detailByClaim.set(claim, item);
  }
  if (detailByClaim.size > 0) return [...detailByClaim.values()];
  // Malformed/empty response: keep one explicit "uncertain" per submitted claim
  // so callers never mistake "no findings" for "everything verified".
  return claims.map((claim) => ({
    claim,
    verdict: "uncertain" as const,
    note: "核对服务未返回该断言的结论",
  }));
}

function buildSummaryText(claimsCount: number, findings: FactCheckVerdictItem[]): string {
  if (findings.length === 0) {
    return "事实核对：已提交 " + claimsCount + " 条数据性断言，核对服务未返回任何结论；正文未改动。";
  }
  const supported = findings.filter((item) => item.verdict === "supported").length;
  const unsupported = findings.filter((item) => item.verdict === "unsupported").length;
  const uncertain = findings.filter((item) => item.verdict === "uncertain").length;
  const lines = [
    "事实核对：已核对 " +
      findings.length +
      " / " +
      claimsCount +
      " 条数据性断言（有依据 " +
      supported +
      " 条、无依据 " +
      unsupported +
      " 条、待确认 " +
      uncertain +
      " 条）。",
  ];
  const attention = findings.filter((item) => item.verdict !== "supported");
  if (attention.length === 0) {
    lines.push("所有数据性断言均有依据。");
    return lines.join("\n");
  }
  lines.push("需要人工确认的断言（正文未自动改动）：");
  for (const item of attention.slice(0, FACT_CHECK_LIMITS.maxDetailFindings)) {
    const tags = [FACT_CHECK_VERDICT_LABEL[item.verdict]];
    if (item.source) tags.push("来源：" + item.source);
    if (item.note) tags.push("说明：" + item.note);
    lines.push("- [" + tags.join("；") + "] " + item.claim);
  }
  if (attention.length > FACT_CHECK_LIMITS.maxDetailFindings) {
    lines.push("- …其余 " + (attention.length - FACT_CHECK_LIMITS.maxDetailFindings) + " 条见核对结果。");
  }
  return lines.join("\n");
}

/**
 * Runs the fact-check stage: extract claims -> one port call -> Chinese summary.
 *
 * Degrades instead of throwing in every failure mode (no port, disabled port,
 * verify rejection) so a verifier outage can never block document generation.
 * The document is only read, never edited.
 */
export async function runFactCheck(
  doc: DocumentIR,
  port: FactCheckPort | undefined,
  options: FactCheckOptions = {},
): Promise<FactCheckResult> {
  const maxClaims = clampMaxClaims(options.maxClaims);
  const claims = collectClaims(doc).slice(0, maxClaims);

  if (!port || port.enabled !== true) {
    const pending = claims.length > 0 ? "（待核对 " + claims.length + " 条）" : "";
    return {
      available: false,
      checkedCount: 0,
      findings: [],
      text: "事实核对不可用：未启用事实核对服务，本次未核对正文中的数据性断言" + pending + "；正文未改动，可稍后重试。",
    };
  }

  if (claims.length === 0) {
    return {
      available: true,
      checkedCount: 0,
      findings: [],
      text: "事实核对：正文未发现含数字、百分比、倍数或万/亿量级的断言，无需核对。",
    };
  }

  const context = options.context ?? describeDocument(doc);
  try {
    const response = await port.verify({ claims, ...(context !== undefined ? { context } : {}) });
    const findings = normalizeFindings(response?.checked, claims);
    return {
      available: true,
      checkedCount: claims.length,
      findings,
      text: buildSummaryText(claims.length, findings),
    };
  } catch (err) {
    return {
      available: false,
      checkedCount: 0,
      findings: [],
      text: "事实核对未完成：核对服务调用失败，本次未核对任何断言，正文保持原样（" + messageOf(err) + "）。",
    };
  }
}
