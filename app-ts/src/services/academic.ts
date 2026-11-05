import {
  ACADEMIC_DOCUMENT_KINDS,
  ACADEMIC_STAGES,
  ACADEMIC_STAGE_LABELS,
  defaultManuscriptSections,
  normalizeDoi,
  wordCount,
  type AcademicDocument,
  type AcademicDocumentKind,
  type AcademicDocumentRepository,
  type AcademicEvent,
  type AcademicEventRepository,
  type AcademicLiteratureEntry,
  type AcademicLiteratureInput,
  type AcademicLiteratureRepository,
  type AcademicPlanTask,
  type AcademicProject,
  type AcademicProjectCreate,
  type AcademicProjectPatch,
  type AcademicProjectRepository,
  type AcademicSectionInput,
  type AcademicStage,
  type AcademicStageState,
  type AcademicStageStatus,
} from "../repository/academic.js";
import type { LiteratureClient, LiteratureHit, LiteratureSearchOptions } from "../auth/literature-client.js";
import { createLogger } from "../logger.js";

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
 *  - every method takes uid first and treats a foreign row as "not found" (404),
 *    never as a permission error that leaks existence;
 *  - verification semantics match the academic_literature tool: verified=true
 *    only after a Crossref hit whose title matches the stored one;
 *  - events are appended for user-visible mutations so the activity feed (and a
 *    future cross-device view) can reconstruct what happened.
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
  stage: AcademicStage;
  stages: Record<AcademicStage, AcademicStageState>;
  literatureCount: number;
  documentCount: number;
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

export interface AcademicServiceDeps {
  projects: AcademicProjectRepository;
  literature: AcademicLiteratureRepository;
  documents: AcademicDocumentRepository;
  events: AcademicEventRepository;
  client: LiteratureClient;
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

function parsePaperType(value: unknown): AcademicProject["paperType"] | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const types = ["journal", "thesis", "fund"] as const;
  if (typeof value !== "string" || !types.includes(value as (typeof types)[number])) {
    throw new AcademicError(400, "paperType 不合法（可选：journal / thesis / fund）");
  }
  return value as (typeof types)[number];
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

  async listProjects(uid: string): Promise<{ projects: AcademicProjectSummary[] }> {
    const projects = await this.deps.projects.list(uid);
    const summaries = await Promise.all(projects.map((project) => this.summarize(uid, project)));
    return { projects: summaries.sort((a, b) => b.updatedAt - a.updatedAt) };
  }

  async createProject(uid: string, body: unknown): Promise<AcademicProjectDetail> {
    const input = this.parseProjectCreate(body);
    const project = await this.deps.projects.create(uid, input);
    await this.appendEvent(uid, project.id, "project.created", { title: project.title });
    return this.projectDetail(uid, project.id);
  }

  async getProject(uid: string, projectId: string): Promise<AcademicProjectDetail> {
    return this.projectDetail(uid, projectId);
  }

  async updateProject(uid: string, projectId: string, body: unknown): Promise<AcademicProjectDetail> {
    const project = await this.requireProject(uid, projectId);
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

  async deleteProject(uid: string, projectId: string): Promise<{ deleted: true }> {
    await this.requireProject(uid, projectId);
    const removed = await this.deps.projects.remove(uid, projectId);
    if (!removed) throw new AcademicError(404, "项目不存在或无权访问");
    log.info("[ACADEMIC] project deleted project_id=%s", projectId);
    return { deleted: true };
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
    const document = await this.deps.documents.createDocument(uid, projectId, { kind, title, sections: defaultManuscriptSections() });
    await this.appendEvent(uid, projectId, "manuscript.document_created", { documentId: document.id, kind, title });
    return { document };
  }

  async getDocument(uid: string, documentId: string): Promise<{ document: AcademicDocument }> {
    const document = await this.deps.documents.getDocument(uid, documentId);
    if (!document) throw new AcademicError(404, "文档不存在或无权访问");
    return { document };
  }

  async saveSection(uid: string, documentId: string, body: unknown): Promise<{ document: AcademicDocument }> {
    const b = (body ?? {}) as { key?: unknown; title?: unknown; content?: unknown; order?: unknown };
    const title = requireString(b.title, "title");
    const input: AcademicSectionInput = { title };
    let sectionKey = typeof b.key === "string" && b.key.trim() ? b.key.trim().slice(0, 80) : undefined;
    if (!sectionKey) {
      // Match an existing heading by title so renaming keeps the same section
      // instead of creating a slug/hash twin (the tool's save semantics).
      const existing = await this.deps.documents.getDocument(uid, documentId);
      if (!existing) throw new AcademicError(404, "文档不存在或无权访问");
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

  async exportDocument(uid: string, documentId: string, format: string | undefined): Promise<{ text: string; title: string }> {
    const { document } = await this.getDocument(uid, documentId);
    const kind = format ?? "markdown";
    const sections = [...document.sections].sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
    if (kind === "latex") {
      const body = sections
        .map((section) => "\\section{" + escapeLatex(section.title) + "}\n" + escapeLatex(section.content) + "\n")
        .join("\n");
      const text = "\\documentclass[12pt]{article}\n\\usepackage{ctex}\n\\title{" + escapeLatex(document.title) + "}\n\\begin{document}\n\\maketitle\n" + body + "\\end{document}\n";
      return { text, title: document.title };
    }
    if (kind !== "markdown") throw new AcademicError(400, "format 仅支持 markdown / latex");
    const body = sections.map((section) => "## " + section.title + "\n\n" + (section.content.trim() || "（暂无正文）")).join("\n\n");
    return { text: "# " + document.title + "\n\n" + body + "\n", title: document.title };
  }

  // ---- events -------------------------------------------------------------

  async listEvents(uid: string, projectId: string, query: unknown): Promise<{ events: AcademicEvent[] }> {
    await this.requireProject(uid, projectId);
    const q = (query ?? {}) as { limit?: unknown };
    const limit = parseLimit(q.limit, DEFAULT_EVENT_LIMIT, 50);
    return { events: await this.deps.events.listEvents(uid, projectId, limit) };
  }

  // ---- internals ----------------------------------------------------------

  private async requireProject(uid: string, projectId: string): Promise<AcademicProject> {
    const id = requireString(projectId, "projectId", 64);
    const project = await this.deps.projects.get(uid, id);
    if (!project) throw new AcademicError(404, "项目不存在或无权访问");
    return project;
  }

  private async projectDetail(uid: string, projectId: string): Promise<AcademicProjectDetail> {
    const project = await this.requireProject(uid, projectId);
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
      literatureCount,
      documentCount,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    };
    if (project.targetJournal) summary.targetJournal = project.targetJournal;
    if (project.deadline) summary.deadline = project.deadline;
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
          return {
            id: typeof task.id === "string" && task.id ? task.id : stage + "-" + (index + 1) + "-" + Date.now().toString(36),
            title: requireString(task.title, "plans." + key + "[" + index + "].title", 200),
            done: task.done === true,
            ...(typeof task.note === "string" && task.note.trim() ? { note: task.note.trim().slice(0, 500) } : {}),
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
    input.source = "manual";
    return input;
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
