import type {
  AcademicDocument,
  AcademicDocumentRepository,
  AcademicLiteratureRepository,
  AcademicProjectRepository,
} from "../../repository/academic.js";
import type { AcademicEvidenceRepository } from "../../repository/academic-evidence.js";
import { parseCitationKeys, stripCitationSyntax } from "./research-citations.js";

/**
 * Academic integrity report (contract: docs/research-ui-api.md §3, v1.1).
 *
 * The v1.1 additions are additive on purpose: every pre-existing field keeps its
 * shape and meaning so existing UI consumers stay compatible, while:
 * - runs.invalidRefs lists [[run:<id>]] references that do not exist in the
 * project evidence ledger or whose run did not succeed;
 * - sectionsWithNumbers / sectionsMissingRunRef are advisory text heuristics
 * (all body sections, bibliography excluded) and do NOT gate pass.
 */
export interface ResearchValidationReport {
  pass: boolean;
  citations: { total: number; missing: string[]; unverified: string[] };
  runs: { total: number; unreproducible: string[]; invalidRefs: string[] };
  results: { sections: string[]; withoutEvidenceRef: string[] };
  /** Chapter titles whose body contains digits (bibliography/参考文献 sections excluded). Advisory only. */
  sectionsWithNumbers: string[];
  /**
   * Chapter titles that contain numbers but no [[run:<id>]] reference. Advisory
   * only: result sections among them are hard failures via
   * results.withoutEvidenceRef, non-result sections are warnings.
   */
  sectionsMissingRunRef: string[];
  /** 数字-证据匹配（仅结果章节，advisory）：在 succeeded run 的 stdout/指标中查找同值。 */
  numbers: {
    total: number;
    matched: number;
    unmatched: Array<{ section: string; value: string }>;
  };
  /** 表格证据（advisory）：包含 Markdown 表格的结果章节，及其中没有 [[run]] 的章节。 */
  tables: {
    sections: string[];
    withoutEvidence: string[];
  };
}

/** Matches one [[run:<id>]] evidence reference (run ids are uuid-ish: [A-Za-z0-9_-]). */
const RUN_REF = /\[\[run:([a-zA-Z0-9_-]+)\]\]/g;

/** Result-number token: decimal/integer with optional percent (years were stripped with citations). */
const NUMBER_TOKEN = /\d+(?:\.\d+)?%?/g;

/** Markdown table row (leading pipe), used only for the advisory table check. */
const TABLE_ROW = /^\s*\|.*\|\s*$/m;

/** A chapter that lists references rather than reporting results (never needs run evidence). */
function isBibliographySection(title: string): boolean {
  return /参考文献|参考书目|references|bibliography/i.test(title);
}

function isResultsSection(title: string): boolean {
  return /结果|result|实验|experiment/i.test(title);
}

/**
 * Chinese, field-named failure list for export gates: both the agent tool text
 * and the service 409 details are built from it, so the two layers cannot drift.
 * Only hard failures (pass conditions) are listed; the advisory sections* fields
 * are intentionally absent.
 */
export function describeValidationFailures(report: ResearchValidationReport): string {
  const lines: string[] = [];
  if (report.citations.missing.length > 0) {
    lines.push("缺失引用（missing）：" + report.citations.missing.join("、"));
  }
  if (report.citations.unverified.length > 0) {
    lines.push("未核验引用（unverified）：" + report.citations.unverified.join("、"));
  }
  if (report.runs.invalidRefs.length > 0) {
    lines.push("无效实验引用（invalidRefs）：" + report.runs.invalidRefs.join("、"));
  }
  if (report.results.withoutEvidenceRef.length > 0) {
    lines.push("结果章节缺少证据引用（withoutEvidenceRef）：" + report.results.withoutEvidenceRef.join("、"));
  }
  if (report.runs.unreproducible.length > 0) {
    lines.push("成功 run 缺少脚本 hash（unreproducible）：" + report.runs.unreproducible.join("、"));
  }
  return lines.length > 0 ? lines.join("\n") : "（无具体问题）";
}

/**
 * Academic integrity checks over a manuscript + evidence ledger:
 * - every citation key must exist and be verified (single parser: research-citations.ts);
 * - every succeeded run must carry a script hash (reproducibility);
 * - every [[run:<id>]] reference must resolve to a succeeded run;
 * - results sections with numbers must reference a run via [[run:<id>]].
 */
export class ResearchValidationService {
  constructor(
    private readonly projects: AcademicProjectRepository,
    private readonly documents: AcademicDocumentRepository,
    private readonly literature: AcademicLiteratureRepository,
    private readonly evidence: AcademicEvidenceRepository,
  ) {}

  async validate(uid: string, projectId: string, documentId?: string): Promise<ResearchValidationReport> {
    const project = await this.projects.get(uid, projectId);
    if (!project) throw new Error("项目不存在或无权访问");
    const docs: AcademicDocument[] = documentId
      ? ([await this.documents.getDocument(uid, documentId)].filter(Boolean) as AcademicDocument[])
      : await this.documents.listDocuments(uid, projectId);
    const library = await this.literature.list(uid, projectId);
    const byKey = new Map(library.map((entry) => [entry.citeKey.toLowerCase(), entry]));
    const runs = await this.evidence.listRuns(uid, projectId, { limit: 100 });

    const allKeys = new Set<string>();
    const resultSections: string[] = [];
    const withoutEvidenceRef: string[] = [];
    const sectionsWithNumbers: string[] = [];
    const sectionsMissingRunRef: string[] = [];
    // Referenced run ids in first-appearance order across every scanned section.
    const referencedRuns: string[] = [];
    const seenRefs = new Set<string>();
    const tableSections: string[] = [];
    const tablesWithoutEvidence: string[] = [];
    const unmatchedNumbers: Array<{ section: string; value: string }> = [];
    let matchedNumbers = 0;
    let totalNumbers = 0;
    for (const doc of docs) {
      for (const section of doc.sections) {
        for (const key of parseCitationKeys(section.content)) allKeys.add(key);
        const refs = [...section.content.matchAll(RUN_REF)].map((match) => match[1]);
        for (const runId of refs) {
          if (seenRefs.has(runId)) continue;
          seenRefs.add(runId);
          referencedRuns.push(runId);
        }
        // Digit heuristic for the whole manuscript body: citation keys
        // (zhang2024) and [[run:<id>]] tokens are stripped first, otherwise a
        // chapter that merely cites work would look numeric; bibliography
        // chapters are excluded because their years/volumes are not results.
        const bodyText = stripCitationSyntax(section.content).replace(RUN_REF, " ");
        const hasNumbers = /\d/.test(bodyText);
        const isBibliography = isBibliographySection(section.title);
        if (hasNumbers && !isBibliography) sectionsWithNumbers.push(section.title);
        if (hasNumbers && !isBibliography && refs.length === 0) sectionsMissingRunRef.push(section.title);
        if (isResultsSection(section.title)) {
          resultSections.push(section.title);
          if (hasNumbers && refs.length === 0) withoutEvidenceRef.push(section.title);
          if (TABLE_ROW.test(section.content)) {
            tableSections.push(section.title);
            if (refs.length === 0) tablesWithoutEvidence.push(section.title);
          }
          // 数字证据匹配（advisory）：只检查结果章节里的数字是否出现在某个
          // succeeded run 的 stdout/指标中；找不到仅提示，不阻断导出。
          if (hasNumbers) {
            const tokens = [...bodyText.matchAll(NUMBER_TOKEN)].map((match) => match[0]);
            for (const token of tokens) {
              totalNumbers += 1;
              if (this.numberInRuns(token, runs)) matchedNumbers += 1;
              else unmatchedNumbers.push({ section: section.title, value: token });
            }
          }
        }
      }
    }
    const missing: string[] = [];
    const unverified: string[] = [];
    for (const key of allKeys) {
      const entry = byKey.get(key.toLowerCase());
      if (!entry) missing.push(key);
      else if (!entry.verified) unverified.push(key);
    }

    const runById = new Map(runs.map((run) => [run.id, run] as const));
    const invalidRefs = referencedRuns.filter((runId) => {
      const run = runById.get(runId);
      return run === undefined || run.status !== "succeeded";
    });
    const unreproducible = runs
      .filter((run) => run.status === "succeeded" && !run.scriptSha256)
      .map((run) => run.id);

    return {
      pass:
        missing.length === 0 &&
        unverified.length === 0 &&
        unreproducible.length === 0 &&
        withoutEvidenceRef.length === 0 &&
        invalidRefs.length === 0,
      citations: { total: allKeys.size, missing, unverified },
      runs: { total: runs.length, unreproducible, invalidRefs },
      results: { sections: resultSections, withoutEvidenceRef },
      sectionsWithNumbers,
      sectionsMissingRunRef,
      numbers: {
        total: totalNumbers,
        matched: matchedNumbers,
        unmatched: unmatchedNumbers.slice(0, 100),
      },
      tables: { sections: tableSections, withoutEvidence: tablesWithoutEvidence },
    };
  }

  /** 数字是否出现在 succeeded run 的 stdout 或指标值中（字符串/数值容差匹配）。 */
  private numberInRuns(token: string, runs: Awaited<ReturnType<AcademicEvidenceRepository["listRuns"]>>): boolean {
    const percent = token.endsWith("%");
    const raw = percent ? token.slice(0, -1) : token;
    const value = Number(raw);
    if (!Number.isFinite(value)) return false;
    for (const run of runs) {
      if (run.status !== "succeeded") continue;
      if (percent) {
        if (run.metrics?.some((metric) => Math.abs(metric.value - value) < 1e-9)) return true;
      }
      const text = run.stdoutPreview ?? "";
      if (text.includes(token)) return true;
      if (!Number.isFinite(value)) continue;
      const nums = [...text.matchAll(/[-+]?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
      if (nums.some((candidate) => Math.abs(candidate - value) < 1e-9)) return true;
    }
    return false;
  }
}
