import {
  ACADEMIC_AUTO_MODES,
  ACADEMIC_AUTO_RULE_EVENTS,
  ACADEMIC_CITATION_STYLES,
  ACADEMIC_DOCUMENT_KINDS,
  ACADEMIC_LANGUAGES,
  ACADEMIC_READING_STATUSES,
  ACADEMIC_STAGES,
  ACADEMIC_STAGE_LABELS,
  defaultManuscriptSections,
  normalizeDoi,
  wordCount,
  type AcademicDocument,
  type AcademicDocumentExport,
  type AcademicDocumentKind,
  type AcademicDocumentRepository,
  type AcademicDocumentSource,
  type AcademicAutoMode,
  type AcademicAutoRule,
  type AcademicCitationStyle,
  type AcademicLanguage,
  type AcademicEvent,
  type AcademicEventRepository,
  type AcademicLiteratureEntry,
  type AcademicLiteratureInput,
  type AcademicLiteraturePatch,
  type AcademicLiteratureRepository,
  type AcademicReadingStatus,
  type AcademicPlanTask,
  type AcademicPlanTaskDoneSource,
  type AcademicProject,
  type AcademicProjectCreate,
  type AcademicProjectPatch,
  type AcademicProjectRepository,
  type AcademicSectionInput,
  type AcademicStage,
  type AcademicStageState,
  type AcademicStageStatus,
} from "../../repository/academic.js";
import type { LiteratureClient, LiteratureHit, LiteratureSearchOptions } from "../../clients/literature-client.js";
import { createLogger } from "../../logger.js";
import { describeValidationFailures, type ResearchValidationService } from "./research-validation.js";
import type { ResearchStageGateService } from "./research-stage-gates.js";
import { defaultSectionsForKind } from "./manuscript-templates.js";
import { appendLatexReferences, appendMarkdownReferences } from "./bibliography.js";

const log = createLogger("ACADEMIC");

/**
 * HTTP-facing academic workspace service.
 *
 * Layer: service. It owns the user-facing orchestration the agent tools also
 * perform — ownership checks, validation, event writing and view shaping — and
 * exposes plain JSON DTOs for the REST routes. Repositories stay the only data
 * access; the literature network client is injected.
 *
 * Invariants:
 * - every method takes uid first and treats a foreign row as "not found" (404),
 * never as a permission error that leaks existence;
 * - verification semantics match the academic_literature tool: verified=true
 * only after a Crossref hit whose title matches the stored one;
 * - events are appended for user-visible mutations so the activity feed (and a
 * future cross-device view) can reconstruct what happened.
 */

/** Domain error mapped directly onto an HTTP status by the route layer. */
export class AcademicError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AcademicError";
  }
}

/** Project row shown in lists — no uid, plus the two counters the UI displays. */
export interface AcademicProjectSummary {
  id: string;
  title: string;
  paperType: AcademicProject["paperType"];
  field: string;
  targetJournal?: string;
  deadline?: string;
  researchQuestion?: string;
  objectives?: string[];
  keywords?: string[];
  contributions?: string[];
  methodology?: string;
  ethicsNote?: string;
  venueRequirements?: string;
  language: AcademicLanguage;
  citationStyle: AcademicCitationStyle;
  stage: AcademicStage;
  stages: Record<AcademicStage, AcademicStageState>;
  /** automation policy; always materialized (legacy rows read as "off") */
  autoMode: AcademicAutoMode;
  literatureCount: number;
  documentCount: number;
  /** 回收站时间戳；存在表示已在回收站。 */
  archivedAt?: number;
  createdAt: number;
  updatedAt: number;
}

/** Project detail payload: summary + per-stage plans/advice + recent activity. */
export interface AcademicProjectDetail {
  project: AcademicProjectSummary;
  plans: Partial<Record<AcademicStage, AcademicPlanTask[]>>;
  advice: Partial<Record<AcademicStage, string>>;
  events: AcademicEvent[];
}

export interface AcademicDocumentSummary {
  id: string;
  kind: AcademicDocumentKind;
  title: string;
  sectionCount: number;
  wordCount: number;
  /** original user-uploaded Word file (Word import path only; docs/manuscript-docx.md §1) */
  source?: AcademicDocumentSource;
  /** latest generated Word saved back into the cloud drive (§2.3) */
  lastExport?: AcademicDocumentExport;
  updatedAt: number;
}

export interface AcademicLiteraturePage {
  entries: AcademicLiteratureEntry[];
  total: number;
}

export interface AcademicVerifyResult {
  entry: AcademicLiteratureEntry;
  verified: boolean;
  message: string;
}

/** 永久删除项目时的级联清理接口（ProjectPurgeService 提供）。 */
export interface ProjectPurger {
  purge(uid: string, projectId: string): Promise<{ deleted: true; counts: Record<string, unknown> }>;
}

export interface AcademicServiceDeps {
  projects: AcademicProjectRepository;
  literature: AcademicLiteratureRepository;
  documents: AcademicDocumentRepository;
  events: AcademicEventRepository;
  client: LiteratureClient;
  /**
   * Optional academic integrity gate (services/research/research-validation.ts). When the
   * composition root injects it, Markdown/LaTeX exports refuse to run on a
   * failed report unless the caller explicitly forces the export.
   */
  validation?: Pick<ResearchValidationService, "validate">;
  /**
   * Optional stage-gate service (services/research/research-stage-gates.ts). The REST
   * routes hold their own reference for the /gates endpoints; the service keeps
   * the dependency so a future orchestration path can evaluate gates without
   * importing the concrete class.
   */
  gates?: ResearchStageGateService;
  /** Optional cascade purge service; absent = purgeProject returns 503. */
  purge?: ProjectPurger;
}

const MAX_TITLE = 200;
const MAX_TEXT = 200_000;
const DEFAULT_LITERATURE_PAGE = 30;
const DEFAULT_EVENT_LIMIT = 20;

// ---------------------------------------------------------------------------
// Validation helpers (throw AcademicError(400) with a user-readable message)
// ---------------------------------------------------------------------------

function requireString(value: unknown, field: string, max = MAX_TITLE): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AcademicError(400, field + " 不能为空");
  }
  const trimmed = value.trim();
  if (trimmed.length > max) throw new AcademicError(400, field + " 过长（上限 " + max + " 字符）");
  return trimmed;
}

function optionalString(value: unknown, field: string, max = MAX_TITLE): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new AcademicError(400, field + " 必须是字符串");
  const trimmed = value.trim();
  if (trimmed.length > max) throw new AcademicError(400, field + " 过长（上限 " + max + " 字符）");
  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalYear(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1500 || n > 2100) throw new AcademicError(400, "年份不合法");
  return n;
}

function parseStage(value: unknown, field = "stage"): AcademicStage {
  if (typeof value !== "string" || !(ACADEMIC_STAGES as readonly string[]).includes(value)) {
    throw new AcademicError(400, field + " 不合法（可选：" + ACADEMIC_STAGES.join(" / ") + "）");
  }
  return value as AcademicStage;
}

function parseStatus(value: unknown): AcademicStageStatus {
  const statuses: AcademicStageStatus[] = ["locked", "active", "submitted", "approved", "frozen"];
  if (typeof value !== "string" || !statuses.includes(value as AcademicStageStatus)) {
    throw new AcademicError(400, "阶段状态不合法（可选：" + statuses.join(" / ") + "）");
  }
  return value as AcademicStageStatus;
}

/** Bounded string array for project keywords/objectives/contributions and literature tags. */
function optionalStringArray(value: unknown, field: string, maxItems: number, maxLen: number): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new AcademicError(400, field + " 必须是数组");
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw new AcademicError(400, field + " 的元素必须是字符串");
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (trimmed.length > maxLen) throw new AcademicError(400, field + " 的单个元素过长（上限 " + maxLen + " 字符）");
    if (result.length >= maxItems) break;
    result.push(trimmed);
  }
  return result;
}

/** Project working language: zh / en. */
function parseLanguage(value: unknown): AcademicLanguage | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !(ACADEMIC_LANGUAGES as readonly string[]).includes(value)) {
    throw new AcademicError(400, "language 不合法（可选：" + ACADEMIC_LANGUAGES.join(" / ") + "）");
  }
  return value as AcademicLanguage;
}

/** Citation style used by bibliography generation: plain / apa / ieee / gb7714. */
function parseCitationStyle(value: unknown): AcademicCitationStyle | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !(ACADEMIC_CITATION_STYLES as readonly string[]).includes(value)) {
    throw new AcademicError(400, "citationStyle 不合法（可选：" + ACADEMIC_CITATION_STYLES.join(" / ") + "）");
  }
  return value as AcademicCitationStyle;
}

/** Library reading status: unread / reading / read. */
function parseReadingStatus(value: unknown): AcademicReadingStatus | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !(ACADEMIC_READING_STATUSES as readonly string[]).includes(value)) {
    throw new AcademicError(400, "readingStatus 不合法（可选：" + ACADEMIC_READING_STATUSES.join(" / ") + "）");
  }
  return value as AcademicReadingStatus;
}

function parsePaperType(value: unknown): AcademicProject["paperType"] | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const types = ["journal", "thesis", "fund"] as const;
  if (typeof value !== "string" || !types.includes(value as (typeof types)[number])) {
    throw new AcademicError(400, "paperType 不合法（可选：journal / thesis / fund）");
  }
  return value as (typeof types)[number];
}

/** Project automation mode: off / assist / auto (anything else is a 400). */
function parseAutoMode(value: unknown): AcademicAutoMode | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !(ACADEMIC_AUTO_MODES as readonly string[]).includes(value)) {
    throw new AcademicError(400, "autoMode 不合法（可选：" + ACADEMIC_AUTO_MODES.join(" / ") + "）");
  }
  return value as AcademicAutoMode;
}

/**
 * autoRule attached to a plan task. Only the documented event names are
 * accepted, and match.sectionKey/minRuns are bounded and type-checked, so a
 * malformed rule can never reach the gate evaluator.
 */
function parseAutoRule(value: unknown, field: string): AcademicAutoRule | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new AcademicError(400, field + " 必须是对象");
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.event !== "string" ||
    !(ACADEMIC_AUTO_RULE_EVENTS as readonly string[]).includes(raw.event)
  ) {
    throw new AcademicError(
      400,
      field + ".event 不合法（可选：" + ACADEMIC_AUTO_RULE_EVENTS.join(" / ") + "）",
    );
  }
  const rule: AcademicAutoRule = { event: raw.event as AcademicAutoRule["event"] };
  if (raw.match !== undefined) {
    if (typeof raw.match !== "object" || raw.match === null || Array.isArray(raw.match)) {
      throw new AcademicError(400, field + ".match 必须是对象");
    }
    const matchRaw = raw.match as Record<string, unknown>;
    const match: { sectionKey?: string; minRuns?: number } = {};
    if (matchRaw.sectionKey !== undefined) {
      if (typeof matchRaw.sectionKey !== "string" || matchRaw.sectionKey.trim() === "") {
        throw new AcademicError(400, field + ".match.sectionKey 必须是非空字符串");
      }
      match.sectionKey = matchRaw.sectionKey.trim().slice(0, 80);
    }
    if (matchRaw.minRuns !== undefined) {
      const n = Number(matchRaw.minRuns);
      if (!Number.isInteger(n) || n < 1) throw new AcademicError(400, field + ".match.minRuns 必须是正整数");
      match.minRuns = n;
    }
    if (match.sectionKey !== undefined || match.minRuns !== undefined) rule.match = match;
  }
  return rule;
}

/** Provenance of a task tick (user / event / agent); absent stays absent. */
function parseDoneSource(value: unknown, field: string): AcademicPlanTaskDoneSource | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const sources: AcademicPlanTaskDoneSource[] = ["user", "event", "agent"];
  if (typeof value !== "string" || !sources.includes(value as AcademicPlanTaskDoneSource)) {
    throw new AcademicError(400, field + " 不合法（可选：" + sources.join(" / ") + "）");
  }
  return value as AcademicPlanTaskDoneSource;
}

function parseDocumentKind(value: unknown): AcademicDocumentKind {
  if (typeof value !== "string" || !(ACADEMIC_DOCUMENT_KINDS as readonly string[]).includes(value)) {
    throw new AcademicError(400, "文档类型不合法（可选：" + ACADEMIC_DOCUMENT_KINDS.join(" / ") + "）");
  }
  return value as AcademicDocumentKind;
}

function parseDeadline(value: unknown): string | undefined {
  const raw = optionalString(value, "deadline", 10);
  if (raw === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new AcademicError(400, "deadline 格式应为 YYYY-MM-DD");
  return raw;
}

function parseLimit(value: unknown, fallback: number, max: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

function parseOffset(value: unknown): number {
  if (value === undefined || value === null || value === "") return 0;
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

/** Title comparison for verification: punctuation/case-insensitive prefix or substring. */
function normalizeTitle(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

function titlesMatch(left: string, right: string): boolean {
  const a = normalizeTitle(left);
  const b = normalizeTitle(right);
  if (!a || !b) return true;
  return a === b || a.includes(b) || b.includes(a);
}

function escapeLatex(text: string): string {
  const map: Record<string, string> = {
    "\\": "\\textbackslash{}",
    "&": "\\&",
    "%": "\\%",
    "$": "\\$",
    "#": "\\#",
    "_": "\\_",
    "{": "\\{",
    "}": "\\}",
    "~": "\\textasciitilde{}",
    "^": "\\textasciicircum{}",
  };
  return text.replace(/[\\&%$#_{}~^]/g, (ch) => map[ch] ?? ch);
}

function toBibtex(entry: AcademicLiteratureEntry): string {
  const fields = ["  title = {" + entry.title + "}"];
  if (entry.authors.length > 0) fields.push("  author = {" + entry.authors.join(" and ") + "}");
  if (entry.year) fields.push("  year = {" + entry.year + "}");
  if (entry.venue) fields.push("  journal = {" + entry.venue + "}");
  if (entry.doi) fields.push("  doi = {" + entry.doi + "}");
  if (entry.url) fields.push("  url = {" + entry.url + "}");
  return "@article{" + entry.citeKey + ",\n" + fields.join(",\n") + "\n}";
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class AcademicService {
  constructor(private readonly deps: AcademicServiceDeps) {}

  // ---- projects -----------------------------------------------------------

  async listProjects(
    uid: string,
    query?: unknown,
  ): Promise<{ projects: AcademicProjectSummary[] }> {
    const q = (query ?? {}) as { archived?: unknown };
    const archivedMode =
      typeof q.archived === "string" ? q.archived.toLowerCase() : q.archived === true ? "only" : "none";
    const projects = await this.deps.projects.list(uid);
    const visible = projects.filter((project) => {
      if (archivedMode === "all") return true;
      if (archivedMode === "only") return project.archivedAt !== undefined;
      return project.archivedAt === undefined;
    });
    const summaries = await Promise.all(visible.map((project) => this.summarize(uid, project)));
    return { projects: summaries.sort((a, b) => b.updatedAt - a.updatedAt) };
  }

  async createProject(uid: string, body: unknown): Promise<AcademicProjectDetail> {
    const input = this.parseProjectCreate(body);
    const project = await this.deps.projects.create(uid, input);
    await this.appendEvent(uid, project.id, "project.created", { title: project.title });
    return this.projectDetail(uid, project.id);
  }

  async getProject(uid: string, projectId: string): Promise<AcademicProjectDetail> {
    return this.projectDetail(uid, projectId, true);
  }

  async updateProject(
    uid: string,
    projectId: string,
    body: unknown,
    expectedUpdatedAt?: number,
  ): Promise<AcademicProjectDetail> {
    const project = await this.requireProject(uid, projectId);
    if (expectedUpdatedAt !== undefined && project.updatedAt !== expectedUpdatedAt) {
      throw new AcademicError(409, "项目已被其他修改更新，请刷新后重试");
    }
    const patch = this.parseProjectPatch(body);
    const updated = await this.deps.projects.update(uid, projectId, patch);
    if (!updated) throw new AcademicError(404, "项目不存在或无权访问");
    if (patch.stage !== undefined || patch.stages !== undefined) {
      const stage = patch.stage ?? project.stage;
      await this.appendEvent(uid, projectId, "stage.updated", {
        stage,
        status: updated.stages[stage]?.status ?? "active",
      });
    } else {
      await this.appendEvent(uid, projectId, "project.updated", {});
    }
    return this.projectDetail(uid, projectId);
  }

  /** 移入回收站（软删除）；列表默认不再返回，可 restore 恢复。 */
  async deleteProject(
    uid: string,
    projectId: string,
  ): Promise<{ deleted: true; archived: true; archivedAt: number }> {
    const project = await this.requireProject(uid, projectId, true);
    const archivedAt = project.archivedAt ?? Date.now();
    if (project.archivedAt === undefined) {
      await this.deps.projects.setArchived(uid, projectId, archivedAt);
      await this.appendEvent(uid, projectId, "project.archived", { archivedAt });
    }
    log.info("[ACADEMIC] project archived project_id=%s", projectId);
    return { deleted: true, archived: true, archivedAt };
  }

  async restoreProject(uid: string, projectId: string): Promise<AcademicProjectDetail> {
    const project = await this.requireProject(uid, projectId, true);
    if (project.archivedAt !== undefined) {
      await this.deps.projects.setArchived(uid, projectId, null);
      await this.appendEvent(uid, projectId, "project.restored", {});
    }
    return this.projectDetail(uid, projectId);
  }

  /** 永久删除：先级联清理子数据，再删除项目行；未装配 purge 服务时 503。 */
  async purgeProject(
    uid: string,
    projectId: string,
  ): Promise<{ deleted: true; counts: Record<string, unknown> }> {
    await this.requireProject(uid, projectId, true);
    if (!this.deps.purge) throw new AcademicError(503, "项目永久删除服务未启用");
    const result = await this.deps.purge.purge(uid, projectId);
    log.info("[ACADEMIC] project purged project_id=%s", projectId);
    return result;
  }

  // ---- literature ---------------------------------------------------------

  async listLiterature(uid: string, projectId: string, query: unknown): Promise<AcademicLiteraturePage> {
    await this.requireProject(uid, projectId);
    const q = (query ?? {}) as { limit?: unknown; offset?: unknown };
    const limit = parseLimit(q.limit, DEFAULT_LITERATURE_PAGE, 100);
    const offset = parseOffset(q.offset);
    const [entries, total] = await Promise.all([
      this.deps.literature.list(uid, projectId),
      this.deps.literature.count(uid, projectId),
    ]);
    entries.sort((a, b) => b.importedAt - a.importedAt);
    return { entries: entries.slice(offset, offset + limit), total };
  }

  async addLiterature(uid: string, projectId: string, body: unknown): Promise<{ entry: AcademicLiteratureEntry; duplicate: boolean }> {
    await this.requireProject(uid, projectId);
    const input = this.parseLiteratureInput(body);
    const result = await this.deps.literature.add(uid, projectId, input);
    await this.appendEvent(uid, projectId, "literature.added", {
      citeKey: result.entry.citeKey,
      duplicate: result.duplicate,
    });
    return result;
  }

  async verifyLiterature(uid: string, projectId: string, ref: string): Promise<AcademicVerifyResult> {
    await this.requireProject(uid, projectId);
    const trimmed = requireString(ref, "ref", 300);
    let entry = await this.deps.literature.get(uid, projectId, trimmed);
    if (!entry) entry = await this.deps.literature.findByDoi(uid, projectId, trimmed);
    if (!entry) throw new AcademicError(404, "文献不存在或无权访问");
    const doi = normalizeDoi(entry.doi) || (normalizeDoi(trimmed) && /^10\.\d{4,9}\//.test(normalizeDoi(trimmed)) ? normalizeDoi(trimmed) : "");
    if (!doi) {
      return { entry, verified: entry.verified, message: "该文献没有 DOI，无法在线核验；请人工核对出处后再引用。" };
    }
    let hit: LiteratureHit | null;
    try {
      hit = await this.deps.client.lookupDoi(doi);
    } catch (err) {
      return { entry, verified: entry.verified, message: "核验失败：文献服务暂时不可用（" + (err instanceof Error ? err.message : String(err)) + "），可稍后重试。" };
    }
    if (!hit) {
      return { entry, verified: false, message: "Crossref 未收录该 DOI，保持未核验；请核对 DOI 是否正确。" };
    }
    if (!titlesMatch(entry.title, hit.title)) {
      return { entry, verified: false, message: "DOI 命中但标题不一致，未标记核验；请人工核对文献元数据。" };
    }
    const updated = await this.deps.literature.setVerified(uid, projectId, entry.id, true);
    const finalEntry = updated ?? entry;
    await this.appendEvent(uid, projectId, "literature.verified", { citeKey: finalEntry.citeKey, doi });
    return { entry: finalEntry, verified: true, message: "已核验：" + finalEntry.title + "（DOI: " + doi + "）" };
  }

  async removeLiterature(uid: string, projectId: string, ref: string): Promise<{ deleted: boolean }> {
    await this.requireProject(uid, projectId);
    const trimmed = requireString(ref, "ref", 300);
    // Accept id, citeKey and DOI alike: the repositories' remove() only resolves
    // id/citeKey, so a DOI is mapped to its entry first.
    const entry =
      (await this.deps.literature.get(uid, projectId, trimmed)) ??
      (await this.deps.literature.findByDoi(uid, projectId, trimmed));
    if (!entry) throw new AcademicError(404, "文献不存在或无权访问");
    const deleted = await this.deps.literature.remove(uid, projectId, entry.id);
    if (!deleted) throw new AcademicError(404, "文献不存在或无权访问");
    await this.appendEvent(uid, projectId, "literature.removed", { citeKey: entry.citeKey });
    return { deleted: true };
  }

  async exportBibtex(uid: string, projectId: string): Promise<{ bibtex: string }> {
    await this.requireProject(uid, projectId);
    const entries = await this.deps.literature.list(uid, projectId);
    entries.sort((a, b) => a.importedAt - b.importedAt);
    return { bibtex: entries.map(toBibtex).join("\n\n") };
  }

  async searchLiterature(uid: string, query: unknown): Promise<{ hits: LiteratureHit[] }> {
    const q = (query ?? {}) as { q?: unknown; query?: unknown; limit?: unknown; source?: unknown };
    const raw = typeof q.q === "string" ? q.q : typeof q.query === "string" ? q.query : "";
    const text = requireString(raw, "q", 300);
    const options: LiteratureSearchOptions = { limit: parseLimit(q.limit, 5, 10) };
    if (q.source === "auto" || q.source === "crossref" || q.source === "openalex" || q.source === "arxiv") {
      options.source = q.source;
    }
    try {
      return { hits: await this.deps.client.search(text, options) };
    } catch (err) {
      throw new AcademicError(502, "文献检索失败：" + (err instanceof Error ? err.message : String(err)));
    }
  }

  // ---- documents ----------------------------------------------------------

  async listDocuments(uid: string, projectId: string): Promise<{ documents: AcademicDocumentSummary[] }> {
    await this.requireProject(uid, projectId);
    const docs = await this.deps.documents.listDocuments(uid, projectId);
    const documents = docs
      .map((doc) => ({
        id: doc.id,
        kind: doc.kind,
        title: doc.title,
        sectionCount: doc.sections.length,
        wordCount: doc.sections.reduce((sum, section) => sum + wordCount(section.content), 0),
        // Optional Word bookkeeping: the writing tab shows "来自: <source>" and
        // "最近回存: <lastExport>" straight from the list payload.
        ...(doc.source !== undefined ? { source: doc.source } : {}),
        ...(doc.lastExport !== undefined ? { lastExport: doc.lastExport } : {}),
        updatedAt: doc.updatedAt,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return { documents };
  }

  async createDocument(uid: string, projectId: string, body: unknown): Promise<{ document: AcademicDocument }> {
    await this.requireProject(uid, projectId);
    const b = (body ?? {}) as { kind?: unknown; title?: unknown };
    const kind = parseDocumentKind(b.kind);
    const title = requireString(b.title, "title");
    const document = await this.deps.documents.createDocument(uid, projectId, {
      kind,
      title,
      sections: defaultSectionsForKind(kind),
    });
    await this.appendEvent(uid, projectId, "manuscript.document_created", { documentId: document.id, kind, title });
    return { document };
  }

  async getDocument(uid: string, documentId: string): Promise<{ document: AcademicDocument }> {
    const document = await this.deps.documents.getDocument(uid, documentId);
    if (!document) throw new AcademicError(404, "文档不存在或无权访问");
    return { document };
  }

  async saveSection(
    uid: string,
    documentId: string,
    body: unknown,
    expectedUpdatedAt?: number,
  ): Promise<{ document: AcademicDocument }> {
    const b = (body ?? {}) as { key?: unknown; title?: unknown; content?: unknown; order?: unknown };
    const title = requireString(b.title, "title");
    const input: AcademicSectionInput = { title };
    const existing = await this.deps.documents.getDocument(uid, documentId);
    if (!existing) throw new AcademicError(404, "文档不存在或无权访问");
    if (expectedUpdatedAt !== undefined && existing.updatedAt !== expectedUpdatedAt) {
      throw new AcademicError(409, "文档已被其他修改更新，请刷新后重试");
    }
    let sectionKey = typeof b.key === "string" && b.key.trim() ? b.key.trim().slice(0, 80) : undefined;
    if (!sectionKey) {
      // Match an existing heading by title so renaming keeps the same section
      // instead of creating a slug/hash twin (the tool's save semantics).
      sectionKey = existing.sections.find((section) => section.title.trim() === title)?.key;
    }
    if (sectionKey) input.key = sectionKey;
    if (typeof b.content === "string") {
      if (b.content.length > MAX_TEXT) throw new AcademicError(400, "正文过长（上限 200000 字符）");
      input.content = b.content;
    }
    if (b.order !== undefined) {
      const order = Number(b.order);
      if (!Number.isInteger(order) || order < 0) throw new AcademicError(400, "order 必须是非负整数");
      input.order = order;
    }
    const document = await this.deps.documents.upsertSection(uid, documentId, input);
    if (!document) throw new AcademicError(404, "文档不存在或无权访问");
    await this.appendEvent(uid, document.projectId, "manuscript.section_saved", {
      documentId,
      sectionKey: input.key ?? document.sections.find((section) => section.title.trim() === title)?.key ?? "",
    });
    return { document };
  }

  async deleteSection(uid: string, documentId: string, sectionKey: string): Promise<{ document: AcademicDocument }> {
    const document = await this.deps.documents.deleteSection(uid, documentId, requireString(sectionKey, "sectionKey", 80));
    if (!document) throw new AcademicError(404, "文档不存在或无权访问");
    await this.appendEvent(uid, document.projectId, "manuscript.section_deleted", { documentId, sectionKey });
    return { document };
  }

  /**
   * Markdown/LaTeX export. The optional options.force is the explicit override
   * for the integrity gate: an injected validation service must pass (or the
   * caller must force) before any export text is produced.
   */
  /**
   * Audit a submission (called by the /submit endpoint and the manuscript
   * submit tool after the submission approval has been consumed).
   */
  async recordSubmission(
    uid: string,
    projectId: string,
    documentId: string,
    fileName: string,
    approvalId?: string,
  ): Promise<void> {
    await this.requireProject(uid, projectId);
    await this.appendEvent(uid, projectId, "manuscript.submitted", {
      documentId,
      fileName,
      ...(approvalId ? { approvalId } : {}),
    });
  }

  /** 项目备份：项目、文献、稿件、事件（审计导出）。 */
  async exportProject(
    uid: string,
    projectId: string,
  ): Promise<{
    version: 1;
    exportedAt: string;
    project: AcademicProject;
    literature: AcademicLiteratureEntry[];
    documents: AcademicDocument[];
    events: AcademicEvent[];
  }> {
    const project = await this.requireProject(uid, projectId);
    const [literature, documents, events] = await Promise.all([
      this.deps.literature.list(uid, projectId),
      this.deps.documents.listDocuments(uid, projectId),
      this.deps.events.listEvents(uid, projectId, 500),
    ]);
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      project,
      literature,
      documents,
      events,
    };
  }

  async exportDocument(
    uid: string,
    documentId: string,
    format: string | undefined,
    options: { force?: boolean } = {},
  ): Promise<{ text: string; title: string }> {
    const { document } = await this.getDocument(uid, documentId);
    const kind = format ?? "markdown";
    // Format check first: an unknown format is a 400 regardless of gate state.
    if (kind !== "markdown" && kind !== "latex") throw new AcademicError(400, "format 仅支持 markdown / latex");
    await this.assertExportValid(uid, document.projectId, documentId, kind, options.force === true);
    const sections = [...document.sections].sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
    const project = await this.deps.projects.get(uid, document.projectId);
    const entries = await this.deps.literature.list(uid, document.projectId);
    const citationStyle = project?.citationStyle;
    if (kind === "latex") {
      const body = sections
        .map((section) => "\\section{" + escapeLatex(section.title) + "}\n" + escapeLatex(section.content) + "\n")
        .join("\n");
      const text = "\\documentclass[12pt]{article}\n\\usepackage{ctex}\n\\title{" + escapeLatex(document.title) + "}\n\\begin{document}\n\\maketitle\n" + body + "\\end{document}\n";
      return { text: appendLatexReferences(text, entries, citationStyle, escapeLatex), title: document.title };
    }
    const body = sections.map((section) => "## " + section.title + "\n\n" + (section.content.trim() || "（暂无正文）")).join("\n\n");
    const markdown = "# " + document.title + "\n\n" + body + "\n";
    return { text: appendMarkdownReferences(markdown, entries, citationStyle), title: document.title };
  }

  // ---- exports ------------------------------------------------------------

  /**
   * Integrity gate for text exports: an injected validation service must pass,
   * otherwise the export is a 409 carrying the Chinese failure list. force is
   * the explicit override and leaves an export.forced audit event behind, so a
   * forced export can always be told apart from a clean one.
   */
  private async assertExportValid(
    uid: string,
    projectId: string,
    documentId: string,
    format: string,
    force: boolean,
  ): Promise<void> {
    const validation = this.deps.validation;
    if (!validation) return;
    const report = await validation.validate(uid, projectId, documentId);
    if (report.pass) return;
    if (!force) {
      throw new AcademicError(
        409,
        "导出被拒绝：学术校验未通过，未生成导出内容。\n" +
          describeValidationFailures(report) +
          "\n请先修正以上问题；如确需强制导出，请传 force=true（会写入 export.forced 审计事件）。",
      );
    }
    await this.appendEvent(uid, projectId, "export.forced", {
      documentId,
      format,
      missing: report.citations.missing,
      unverified: report.citations.unverified,
      invalidRefs: report.runs.invalidRefs,
      withoutEvidenceRef: report.results.withoutEvidenceRef,
      unreproducible: report.runs.unreproducible,
    });
  }

  // ---- events -------------------------------------------------------------

  async listEvents(uid: string, projectId: string, query: unknown): Promise<{ events: AcademicEvent[] }> {
    await this.requireProject(uid, projectId);
    const q = (query ?? {}) as { limit?: unknown; offset?: unknown };
    const limit = parseLimit(q.limit, DEFAULT_EVENT_LIMIT, 50);
    const offset = parseOffset(q.offset);
    return { events: await this.deps.events.listEvents(uid, projectId, limit, offset) };
  }

  // ---- internals ----------------------------------------------------------

  private async requireProject(
    uid: string,
    projectId: string,
    allowArchived = false,
  ): Promise<AcademicProject> {
    const id = requireString(projectId, "projectId", 64);
    const project = await this.deps.projects.get(uid, id);
    if (!project) throw new AcademicError(404, "项目不存在或无权访问");
    if (!allowArchived && project.archivedAt !== undefined) {
      throw new AcademicError(404, "项目已在回收站，请先恢复后再操作");
    }
    return project;
  }

  private async projectDetail(
    uid: string,
    projectId: string,
    allowArchived = false,
  ): Promise<AcademicProjectDetail> {
    const project = await this.requireProject(uid, projectId, allowArchived);
    const [literatureCount, documentCount, events] = await Promise.all([
      this.deps.literature.count(uid, projectId),
      this.deps.documents.countDocuments(uid, projectId),
      this.deps.events.listEvents(uid, projectId, 10),
    ]);
    return {
      project: this.summarizeFrom(project, literatureCount, documentCount),
      plans: project.plans,
      advice: project.advice,
      events,
    };
  }

  private async summarize(uid: string, project: AcademicProject): Promise<AcademicProjectSummary> {
    const [literatureCount, documentCount] = await Promise.all([
      this.deps.literature.count(uid, project.id),
      this.deps.documents.countDocuments(uid, project.id),
    ]);
    return this.summarizeFrom(project, literatureCount, documentCount);
  }

  private summarizeFrom(project: AcademicProject, literatureCount: number, documentCount: number): AcademicProjectSummary {
    const summary: AcademicProjectSummary = {
      id: project.id,
      title: project.title,
      paperType: project.paperType,
      field: project.field,
      stage: project.stage,
      stages: project.stages,
      autoMode: project.autoMode ?? "off",
      language: project.language ?? "zh",
      citationStyle: project.citationStyle ?? "plain",
      literatureCount,
      documentCount,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    };
    if (project.archivedAt !== undefined) summary.archivedAt = project.archivedAt;
    if (project.targetJournal) summary.targetJournal = project.targetJournal;
    if (project.deadline) summary.deadline = project.deadline;
    if (project.researchQuestion) summary.researchQuestion = project.researchQuestion;
    if (project.objectives && project.objectives.length > 0) summary.objectives = project.objectives;
    if (project.keywords && project.keywords.length > 0) summary.keywords = project.keywords;
    if (project.contributions && project.contributions.length > 0) summary.contributions = project.contributions;
    if (project.methodology) summary.methodology = project.methodology;
    if (project.ethicsNote) summary.ethicsNote = project.ethicsNote;
    if (project.venueRequirements) summary.venueRequirements = project.venueRequirements;
    return summary;
  }

  private parseProjectCreate(body: unknown): AcademicProjectCreate {
    const b = (body ?? {}) as Record<string, unknown>;
    const input: AcademicProjectCreate = { title: requireString(b.title, "title") };
    const paperType = parsePaperType(b.paperType);
    if (paperType) input.paperType = paperType;
    const field = optionalString(b.field, "field", 80);
    if (field) input.field = field;
    const journal = optionalString(b.targetJournal, "targetJournal", 120);
    if (journal) input.targetJournal = journal;
    const deadline = parseDeadline(b.deadline);
    if (deadline) input.deadline = deadline;
    const autoMode = parseAutoMode(b.autoMode);
    if (autoMode) input.autoMode = autoMode;
    const researchQuestion = optionalString(b.researchQuestion, "researchQuestion", 2000);
    if (researchQuestion) input.researchQuestion = researchQuestion;
    const objectives = optionalStringArray(b.objectives, "objectives", 10, 500);
    if (objectives && objectives.length > 0) input.objectives = objectives;
    const keywords = optionalStringArray(b.keywords, "keywords", 20, 50);
    if (keywords && keywords.length > 0) input.keywords = keywords;
    const contributions = optionalStringArray(b.contributions, "contributions", 10, 500);
    if (contributions && contributions.length > 0) input.contributions = contributions;
    const methodology = optionalString(b.methodology, "methodology", 4000);
    if (methodology) input.methodology = methodology;
    const ethicsNote = optionalString(b.ethicsNote, "ethicsNote", 4000);
    if (ethicsNote) input.ethicsNote = ethicsNote;
    const venueRequirements = optionalString(b.venueRequirements, "venueRequirements", 4000);
    if (venueRequirements) input.venueRequirements = venueRequirements;
    const language = parseLanguage(b.language);
    if (language) input.language = language;
    const citationStyle = parseCitationStyle(b.citationStyle);
    if (citationStyle) input.citationStyle = citationStyle;
    return input;
  }

  private parseProjectPatch(body: unknown): AcademicProjectPatch {
    const b = (body ?? {}) as Record<string, unknown>;
    const patch: AcademicProjectPatch = {};
    if (b.title !== undefined) patch.title = requireString(b.title, "title");
    const paperType = parsePaperType(b.paperType);
    if (paperType) patch.paperType = paperType;
    if (b.field !== undefined) patch.field = optionalString(b.field, "field", 80) ?? "";
    if (b.targetJournal !== undefined) patch.targetJournal = optionalString(b.targetJournal, "targetJournal", 120) ?? "";
    const deadline = parseDeadline(b.deadline);
    if (deadline) patch.deadline = deadline;
    const autoMode = parseAutoMode(b.autoMode);
    if (autoMode) patch.autoMode = autoMode;
    if (b.researchQuestion !== undefined) patch.researchQuestion = optionalString(b.researchQuestion, "researchQuestion", 2000) ?? "";
    if (b.objectives !== undefined) patch.objectives = optionalStringArray(b.objectives, "objectives", 10, 500) ?? [];
    if (b.keywords !== undefined) patch.keywords = optionalStringArray(b.keywords, "keywords", 20, 50) ?? [];
    if (b.contributions !== undefined) patch.contributions = optionalStringArray(b.contributions, "contributions", 10, 500) ?? [];
    if (b.methodology !== undefined) patch.methodology = optionalString(b.methodology, "methodology", 4000) ?? "";
    if (b.ethicsNote !== undefined) patch.ethicsNote = optionalString(b.ethicsNote, "ethicsNote", 4000) ?? "";
    if (b.venueRequirements !== undefined) patch.venueRequirements = optionalString(b.venueRequirements, "venueRequirements", 4000) ?? "";
    const language = parseLanguage(b.language);
    if (language) patch.language = language;
    const citationStyle = parseCitationStyle(b.citationStyle);
    if (citationStyle) patch.citationStyle = citationStyle;
    if (b.stage !== undefined) patch.stage = parseStage(b.stage);

    if (b.stages !== undefined) {
      if (typeof b.stages !== "object" || b.stages === null) throw new AcademicError(400, "stages 必须是对象");
      const stages: Partial<Record<AcademicStage, AcademicStageState>> = {};
      for (const [key, raw] of Object.entries(b.stages as Record<string, unknown>)) {
        const stage = parseStage(key, "stages." + key);
        const value = (raw ?? {}) as Record<string, unknown>;
        stages[stage] = {
          status: parseStatus(value.status),
          updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : Date.now(),
          ...(typeof value.note === "string" && value.note.trim() ? { note: value.note.trim().slice(0, 500) } : {}),
        };
      }
      patch.stages = stages;
    }

    if (b.plans !== undefined) {
      if (typeof b.plans !== "object" || b.plans === null) throw new AcademicError(400, "plans 必须是对象");
      const plans: Partial<Record<AcademicStage, AcademicPlanTask[]>> = {};
      for (const [key, raw] of Object.entries(b.plans as Record<string, unknown>)) {
        const stage = parseStage(key, "plans." + key);
        if (!Array.isArray(raw)) throw new AcademicError(400, "plans." + key + " 必须是数组");
        plans[stage] = raw.map((item, index) => {
          const task = (item ?? {}) as Record<string, unknown>;
          const field = "plans." + key + "[" + index + "]";
          // autoRule/doneSource round-trip through PATCH (the UI re-sends whole
          // plan arrays when ticking a checkbox), so the evaluator never loses a
          // configured rule just because a task was toggled.
          const autoRule = parseAutoRule(task.autoRule, field + ".autoRule");
          const doneSource = parseDoneSource(task.doneSource, field + ".doneSource");
          return {
            id: typeof task.id === "string" && task.id ? task.id : stage + "-" + (index + 1) + "-" + Date.now().toString(36),
            title: requireString(task.title, field + ".title", 200),
            done: task.done === true,
            ...(typeof task.note === "string" && task.note.trim() ? { note: task.note.trim().slice(0, 500) } : {}),
            ...(autoRule !== undefined ? { autoRule } : {}),
            ...(doneSource !== undefined ? { doneSource } : {}),
          };
        });
      }
      patch.plans = plans;
    }

    if (b.advice !== undefined) {
      if (typeof b.advice !== "object" || b.advice === null) throw new AcademicError(400, "advice 必须是对象");
      const advice: Partial<Record<AcademicStage, string>> = {};
      for (const [key, raw] of Object.entries(b.advice as Record<string, unknown>)) {
        const stage = parseStage(key, "advice." + key);
        if (typeof raw !== "string") throw new AcademicError(400, "advice." + key + " 必须是字符串");
        advice[stage] = raw.slice(0, 20_000);
      }
      patch.advice = advice;
    }

    if (Object.keys(patch).length === 0) throw new AcademicError(400, "没有可更新的字段");
    return patch;
  }

  private parseLiteratureInput(body: unknown): AcademicLiteratureInput {
    const b = (body ?? {}) as Record<string, unknown>;
    const input: AcademicLiteratureInput = { title: requireString(b.title, "title", 500) };
    const authors = Array.isArray(b.authors)
      ? b.authors.filter((author): author is string => typeof author === "string" && author.trim().length > 0).map((author) => author.trim().slice(0, 200))
      : undefined;
    if (authors && authors.length > 0) input.authors = authors;
    const year = optionalYear(b.year);
    if (year !== undefined) input.year = year;
    const venue = optionalString(b.venue, "venue", 300);
    if (venue) input.venue = venue;
    const doi = optionalString(b.doi, "doi", 300);
    if (doi) input.doi = doi;
    const url = optionalString(b.url, "url", 1000);
    if (url) input.url = url;
    const abstract = optionalString(b.abstract, "abstract", 20_000);
    if (abstract) input.abstract = abstract;
    const tags = optionalStringArray(b.tags, "tags", 20, 40);
    if (tags && tags.length > 0) input.tags = tags;
    const notes = optionalString(b.notes, "notes", 20_000);
    if (notes) input.notes = notes;
    const readingStatus = parseReadingStatus(b.readingStatus);
    if (readingStatus) input.readingStatus = readingStatus;
    const keywords = optionalStringArray(b.keywords, "keywords", 20, 50);
    if (keywords && keywords.length > 0) input.keywords = keywords;
    input.source = "manual";
    return input;
  }

  /** PATCH literature metadata (tags/notes/readingStatus/keywords). */
  async updateLiterature(
    uid: string,
    projectId: string,
    ref: string,
    body: unknown,
  ): Promise<{ entry: AcademicLiteratureEntry }> {
    await this.requireProject(uid, projectId);
    const trimmed = requireString(ref, "ref", 300);
    const entry =
      (await this.deps.literature.get(uid, projectId, trimmed)) ??
      (await this.deps.literature.findByDoi(uid, projectId, trimmed));
    if (!entry) throw new AcademicError(404, "文献不存在或无权访问");
    const patch = this.parseLiteraturePatch(body);
    const updated = await this.deps.literature.update(uid, projectId, entry.id, patch);
    if (!updated) throw new AcademicError(404, "文献不存在或无权访问");
    await this.appendEvent(uid, projectId, "literature.updated", {
      citeKey: updated.citeKey,
      fields: Object.keys(patch),
    });
    return { entry: updated };
  }

  private parseLiteraturePatch(body: unknown): AcademicLiteraturePatch {
    const b = (body ?? {}) as Record<string, unknown>;
    const patch: AcademicLiteraturePatch = {};
    if (b.tags !== undefined) patch.tags = optionalStringArray(b.tags, "tags", 20, 40) ?? [];
    if (b.notes !== undefined) patch.notes = optionalString(b.notes, "notes", 20_000) ?? "";
    if (b.readingStatus !== undefined) {
      const status = parseReadingStatus(b.readingStatus);
      if (!status) throw new AcademicError(400, "readingStatus 不合法（可选：" + ACADEMIC_READING_STATUSES.join(" / ") + "）");
      patch.readingStatus = status;
    }
    if (b.keywords !== undefined) patch.keywords = optionalStringArray(b.keywords, "keywords", 20, 50) ?? [];
    if (Object.keys(patch).length === 0) {
      throw new AcademicError(400, "没有可更新的字段（支持 tags / notes / readingStatus / keywords）");
    }
    return patch;
  }

  private async appendEvent(
    uid: string,
    projectId: string,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.deps.events.append(uid, projectId, type, payload, "user");
    } catch (err) {
      // The event feed is an audit convenience: a failed append must not turn a
      // successful mutation into an HTTP error for the user.
      log.warn("[ACADEMIC] event append failed type=%s project_id=%s: %s", type, projectId, err instanceof Error ? err.message : err);
    }
  }
}
