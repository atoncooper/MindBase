/**
 * Academic research workspace contracts: research projects, the literature
 * library, manuscript documents and the project event stream.
 *
 * Layer rules (app-ts/AGENTS.md §3):
 *  - this file = contract + pure helpers, NO I/O;
 *  - memory implementation: repository/memory/academic.ts
 *  - Mongo adapter:        repository/mongo/academic.ts
 *  - tools/services/http import ONLY this contract (never a concrete adapter).
 *
 * Multi-tenant: every read/write takes uid as its first argument. A query that
 * omits uid is a bug — uid must never appear in an LLM-facing tool schema.
 *
 * Identity / dedupe invariants both implementations must honour:
 *  - DOIs are stored normalized (normalizeDoi) so lookups and the Mongo index agree;
 *  - a literature entry is "the same paper" iff literatureDedupeKey matches:
 *    normalized DOI first, otherwise normalized title + year;
 *  - citeKeys are unique per project (case-insensitively, a/b/c suffixes);
 *  - section keys are stable and derived from the title when the caller omits one.
 *
 * The pure helpers at the bottom are the single source of truth for those rules;
 * implementations call them rather than re-deriving the semantics locally.
 */

// ---------------------------------------------------------------------------
// Project + stage state machine (mirrors mind-base-desktop AgentKind::Research)
// ---------------------------------------------------------------------------

/**
 * Canonical stage order of the research pipeline. The array order IS persisted
 * semantics: stageIndex/nextStage derive progression from it, so appending a
 * stage is safe while reordering would reinterpret every stored `stage` value.
 */
export const ACADEMIC_STAGES = ["topic", "design", "advise", "experiment", "writing", "submission"] as const;
/** One stage identifier of the research pipeline (see ACADEMIC_STAGES). */
export type AcademicStage = (typeof ACADEMIC_STAGES)[number];

/** Chinese UI labels per stage — product strings, keep them Chinese. */
export const ACADEMIC_STAGE_LABELS: Record<AcademicStage, string> = {
  topic: "选题",
  design: "研究设计",
  advise: "指导",
  experiment: "实验",
  writing: "写作",
  submission: "投稿",
};

/**
 * Stage lifecycle: locked → active → submitted → approved → frozen; rework goes
 * back to active. The contract only carries the status — the gate enforcing
 * which transition is legal lives in the academic agent tools, so every
 * repository trusts a persisted state as-is.
 */
export type AcademicStageStatus = "locked" | "active" | "submitted" | "approved" | "frozen";

/**
 * Per-stage state stored on the project. `updatedAt` is stamped by whoever
 * changes the stage (agent gate / user action) and is preserved verbatim by the
 * stores; project-level updates only refresh the project's own `updatedAt`.
 */
export interface AcademicStageState {
  status: AcademicStageStatus;
  updatedAt: number;
  /** free-form note (gate result / rework reason / user instruction) */
  note?: string;
}

/** Deliverable shape: journal article, degree thesis or grant proposal. */
export type AcademicPaperType = "journal" | "thesis" | "fund";

/** One execution task in a stage plan (the AI proposes it; the user ticks it). */
export interface AcademicPlanTask {
  id: string;
  title: string;
  done: boolean;
  note?: string;
}

/**
 * A research project root aggregate: one stage state machine, per-stage plans
 * and advice, plus the literature library and manuscript documents that are
 * scoped by its id. `uid` is the tenancy key and is never derived or rewritten
 * by an update.
 */
export interface AcademicProject {
  id: string;
  uid: string;
  title: string;
  paperType: AcademicPaperType;
  field: string;
  targetJournal?: string;
  /** ISO date (YYYY-MM-DD) */
  deadline?: string;
  /** the stage currently in focus */
  stage: AcademicStage;
  stages: Record<AcademicStage, AcademicStageState>;
  /** per-stage execution plan */
  plans: Partial<Record<AcademicStage, AcademicPlanTask[]>>;
  /** per-stage saved guidance */
  advice: Partial<Record<AcademicStage, string>>;
  createdAt: number;
  updatedAt: number;
}

/**
 * Create payload. Omitted fields default to paperType="journal", field="", no
 * targetJournal/deadline; the implementation stamps id/timestamps and starts the
 * stage machine at "topic".
 */
export interface AcademicProjectCreate {
  title: string;
  paperType?: AcademicPaperType;
  field?: string;
  targetJournal?: string;
  deadline?: string;
}

/**
 * Partial mutation. Implementations shallow-merge the record fields and merge
 * `stages` / `plans` / `advice` key-by-key (a provided stage key replaces that
 * stage's value; omitted keys are preserved).
 *
 * A provided stage state object replaces the stored one wholesale — it is not
 * deep-merged — and the stores clone patch values on write, so the caller may
 * keep mutating its own object afterwards. id/uid/createdAt are not patchable.
 */
export interface AcademicProjectPatch {
  title?: string;
  paperType?: AcademicPaperType;
  field?: string;
  targetJournal?: string;
  deadline?: string;
  stage?: AcademicStage;
  stages?: Partial<Record<AcademicStage, AcademicStageState>>;
  plans?: Partial<Record<AcademicStage, AcademicPlanTask[]>>;
  advice?: Partial<Record<AcademicStage, string>>;
}

/**
 * Project CRUD contract. Every call is uid-scoped: a row owned by another user
 * must behave exactly like a missing row (null / false), never throw. `update`
 * applies AcademicProjectPatch semantics and returns null when the project does
 * not exist under that uid.
 */
export interface AcademicProjectRepository {
  create(uid: string, input: AcademicProjectCreate): Promise<AcademicProject>;
  list(uid: string): Promise<AcademicProject[]>;
  get(uid: string, projectId: string): Promise<AcademicProject | null>;
  update(uid: string, projectId: string, patch: AcademicProjectPatch): Promise<AcademicProject | null>;
  remove(uid: string, projectId: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Literature library
// ---------------------------------------------------------------------------

/**
 * Import origins recorded on an entry. crossref/openalex/arxiv are online
 * metadata lookups, manual is the agent- or user-authored fallback, bibtex/csl
 * are bulk imports. The value is informational — no behaviour branches on it.
 */
export const ACADEMIC_LITERATURE_SOURCES = [
  "crossref",
  "openalex",
  "arxiv",
  "manual",
  "bibtex",
  "csl",
] as const;
/** One import origin of the literature library (see ACADEMIC_LITERATURE_SOURCES). */
export type AcademicLiteratureSource = (typeof ACADEMIC_LITERATURE_SOURCES)[number];

/**
 * One paper in a project's bibliography. `doi` is stored normalized (see
 * normalizeDoi) so exact-match lookup matches the Mongo index; `verified` is true
 * only after a DOI/Crossref check or an explicit user import review, and
 * `verifiedAt` is present exactly when `verified` is true (revoking deletes it).
 */
export interface AcademicLiteratureEntry {
  id: string;
  uid: string;
  projectId: string;
  /** stable citation key used by the manuscript (e.g. "zhang2024") */
  citeKey: string;
  title: string;
  authors: string[];
  year?: number;
  venue?: string;
  doi?: string;
  url?: string;
  abstract?: string;
  source: AcademicLiteratureSource;
  /** true only after a DOI/Crossref verification (or explicit user import review) */
  verified: boolean;
  verifiedAt?: number;
  importedAt: number;
}

/**
 * Add payload. `citeKey` is a suggestion only: implementations uniquify it
 * against the project library (case-insensitively) and fall back to the
 * "author+year" derivation when it is omitted or blank. `source` defaults to
 * "manual"; `doi` may be a full doi.org URL and is normalized on write.
 */
export interface AcademicLiteratureInput {
  title: string;
  authors?: string[];
  year?: number;
  venue?: string;
  doi?: string;
  url?: string;
  abstract?: string;
  /** caller-suggested key; implementations uniquify against the project library */
  citeKey?: string;
  source?: AcademicLiteratureSource;
}

/**
 * Outcome of a literature add: `entry` is always the stored row; `duplicate` is
 * true when an equivalent paper (same literatureDedupeKey) already existed, in
 * which case `entry` is the pre-existing row and nothing was written.
 */
export interface AcademicLiteratureAddResult {
  entry: AcademicLiteratureEntry;
  duplicate: boolean;
}

/**
 * Project literature library contract. Entries are scoped by (uid, projectId).
 * `add` is idempotent per literatureDedupeKey: re-importing the same paper
 * returns the stored entry with duplicate=true instead of inserting a second
 * row. `get` / `setVerified` / `remove` accept either the entry id or the
 * citeKey and return null/false for unknown or foreign references.
 *
 * `addMany` exists for the bulk-import path: implementations resolve the
 * project's identity index once for the whole batch (and duplicates *within* the
 * batch to the first occurrence), so importing N papers costs one library scan
 * instead of N. `count` is the O(1) projection used by project briefs; it must
 * not load row bodies.
 */
export interface AcademicLiteratureRepository {
  /** Single add, idempotent per literatureDedupeKey. */
  add(uid: string, projectId: string, input: AcademicLiteratureInput): Promise<AcademicLiteratureAddResult>;
  /** Batch add; results keep input order, duplicate entries carry the stored row. */
  addMany(
    uid: string,
    projectId: string,
    inputs: AcademicLiteratureInput[],
  ): Promise<AcademicLiteratureAddResult[]>;
  list(uid: string, projectId: string): Promise<AcademicLiteratureEntry[]>;
  /** Number of entries in the project library — must not load row bodies. */
  count(uid: string, projectId: string): Promise<number>;
  /** entry id OR citeKey is accepted by implementations */
  get(uid: string, projectId: string, ref: string): Promise<AcademicLiteratureEntry | null>;
  findByDoi(uid: string, projectId: string, doi: string): Promise<AcademicLiteratureEntry | null>;
  setVerified(uid: string, projectId: string, ref: string, verified: boolean): Promise<AcademicLiteratureEntry | null>;
  remove(uid: string, projectId: string, ref: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Manuscript documents
// ---------------------------------------------------------------------------

/**
 * Manuscript document kinds. `custom` is the escape hatch for anything the
 * fixed set does not describe; values are persisted and must not be renamed.
 */
export const ACADEMIC_DOCUMENT_KINDS = [
  "proposal",
  "plan",
  "draft",
  "revision",
  "cover_letter",
  "custom",
] as const;
/** One manuscript document kind (see ACADEMIC_DOCUMENT_KINDS). */
export type AcademicDocumentKind = (typeof ACADEMIC_DOCUMENT_KINDS)[number];

/** Chinese UI labels per document kind — product strings, keep them Chinese. */
export const ACADEMIC_DOCUMENT_KIND_LABELS: Record<AcademicDocumentKind, string> = {
  proposal: "开题报告",
  plan: "研究计划",
  draft: "初稿",
  revision: "修改稿",
  cover_letter: "投稿信",
  custom: "自定义",
};

/**
 * One manuscript section. `key` is the upsert identity and stays stable for the
 * lifetime of the section; `order` is display order and may legitimately have
 * gaps after edits/reorders; `updatedAt` is the last write stamp of the section.
 */
export interface AcademicSection {
  /** stable key ([`a-z0-9-_`]); derived from the title when omitted */
  key: string;
  title: string;
  content: string;
  /** display order, ascending */
  order: number;
  updatedAt: number;
}

/**
 * Section write payload. Omitted `key` is derived from the title (slug, or a
 * deterministic hash for pure-CJK titles); omitted `content` defaults to "";
 * omitted `order` uses the input position on create and the next free order
 * when appending through upsertSection.
 */
export interface AcademicSectionInput {
  key?: string;
  title: string;
  content?: string;
  order?: number;
}

/**
 * Origin of a document that was imported from a user-supplied Word file
 * (docs/manuscript-docx.md §1). The upload lives in the project cloud drive
 * (05_论文); it is also the template every later export reuses, which is what
 * preserves the user's styles/theme/headers/page setup.
 */
export interface AcademicDocumentSource {
  /** cloud-drive upload_uuid of the original .docx */
  uploadUuid: string;
  fileName: string;
  mimeType: string;
  /** 05_论文 folder id when the cloud drive reported it */
  folderId?: number;
}

/**
 * Record of the latest "save back to the cloud drive" of a generated Word file
 * (docs/manuscript-docx.md §1/§2.3). Written by the manuscript Word export;
 * informational for the UI (download link + "最近回存" line).
 */
export interface AcademicDocumentExport {
  /** cloud-drive upload_uuid of the generated .docx */
  uploadUuid: string;
  fileName: string;
  folderId?: number;
  createdAt: number;
}

/**
 * A manuscript document: an ordered list of sections plus bookkeeping stamps.
 * Sections are re-sorted by (order, key) on every write so all readers observe
 * the same order regardless of insertion history. Documents imported from an
 * existing Word file additionally carry the original upload (`source`) and,
 * once saved back, the latest export record (`lastExport`) — both optional so
 * every pre-existing row keeps its shape.
 */
export interface AcademicDocument {
  id: string;
  uid: string;
  projectId: string;
  kind: AcademicDocumentKind;
  title: string;
  sections: AcademicSection[];
  /** original user-uploaded Word file (import path); absent for documents authored in-app */
  source?: AcademicDocumentSource;
  /** latest generated Word file saved back into the project cloud drive */
  lastExport?: AcademicDocumentExport;
  createdAt: number;
  updatedAt: number;
}

/**
 * Manuscript document contract. Documents are scoped by uid (project ownership
 * is checked by callers, not re-validated here). `updateDocument` patches the
 * title plus the two optional Word bookkeeping records (source/lastExport);
 * content changes always go through upsertSection / deleteSection, which are
 * keyed by the derived section key so a retried save hits the same section
 * instead of creating a duplicate.
 */
export interface AcademicDocumentRepository {
  createDocument(
    uid: string,
    projectId: string,
    input: {
      kind: AcademicDocumentKind;
      title: string;
      sections?: AcademicSectionInput[];
      /** set only by the Word import path (docs/manuscript-docx.md §2.1) */
      source?: AcademicDocumentSource;
    },
  ): Promise<AcademicDocument>;
  listDocuments(uid: string, projectId: string): Promise<AcademicDocument[]>;
  /** Number of documents in the project — cheap projection for project briefs. */
  countDocuments(uid: string, projectId: string): Promise<number>;
  getDocument(uid: string, documentId: string): Promise<AcademicDocument | null>;
  updateDocument(
    uid: string,
    documentId: string,
    patch: { title?: string; source?: AcademicDocumentSource; lastExport?: AcademicDocumentExport },
  ): Promise<AcademicDocument | null>;
  /** upsert by section key (existing key keeps its order unless order is provided) */
  upsertSection(uid: string, documentId: string, input: AcademicSectionInput): Promise<AcademicDocument | null>;
  deleteSection(uid: string, documentId: string, sectionKey: string): Promise<AcademicDocument | null>;
}

// ---------------------------------------------------------------------------
// Project event stream (append-only audit / activity feed)
// ---------------------------------------------------------------------------

/** Who caused an event: the end user or the agent acting on their behalf. */
export type AcademicActor = "user" | "agent";

/**
 * Append-only activity/audit record for a project. `payload` is free-form but
 * must stay small and JSON-serializable (it is stored verbatim); the feed is
 * newest-first and bounded by a read-time limit — there is no update or delete
 * path for events.
 */
export interface AcademicEvent {
  id: string;
  uid: string;
  projectId: string;
  /** e.g. project.created / stage.updated / literature.imported / manuscript.section_saved */
  type: string;
  payload: Record<string, unknown>;
  actor: AcademicActor;
  createdAt: number;
}

/**
 * Project event feed contract. `append` never updates or dedupes — the stream is
 * append-only; `listEvents` returns newest-first and caps the result. The name is
 * deliberately different from the other repositories' list() so a 2-arg call
 * cannot silently resolve to the literature list at runtime.
 */
export interface AcademicEventRepository {
  append(
    uid: string,
    projectId: string,
    type: string,
    payload?: Record<string, unknown>,
    actor?: AcademicActor,
  ): Promise<AcademicEvent>;
  /** Newest-first project events. Distinct name from the other repos' list() so an
   *  accidental 2-arg call cannot resolve to the literature list at runtime. */
  listEvents(uid: string, projectId: string, limit?: number): Promise<AcademicEvent[]>;
}

// ---------------------------------------------------------------------------
// Pure helpers (shared by every implementation so semantics cannot drift)
// ---------------------------------------------------------------------------

/**
 * Fresh project stage state: the first stage active, every other stage locked,
 * all stamped with the supplied creation timestamp (pure — it does not read the
 * clock, so create() and its callers stay consistent).
 */
export function initialStageStates(at: number): Record<AcademicStage, AcademicStageState> {
  const out = {} as Record<AcademicStage, AcademicStageState>;
  for (const stage of ACADEMIC_STAGES) {
    out[stage] = { status: stage === "topic" ? "active" : "locked", updatedAt: at };
  }
  return out;
}

/** Position of a stage in ACADEMIC_STAGES (progression checks / stage gates). */
export function stageIndex(stage: AcademicStage): number {
  return ACADEMIC_STAGES.indexOf(stage);
}

/**
 * Next stage in the pipeline (null for the last one) — used by stage_update
 * gates. Returns null for an unknown stage as well, so callers cannot advance
 * from garbage input.
 */
export function nextStage(stage: AcademicStage): AcademicStage | null {
  const i = stageIndex(stage);
  return i >= 0 && i < ACADEMIC_STAGES.length - 1 ? ACADEMIC_STAGES[i + 1] : null;
}

/**
 * Canonical DOI form: trim, strip an http(s)://doi.org or dx.doi.org prefix,
 * lowercase. Empty/undefined input yields "" which callers read as "no DOI"
 * (and therefore fall back to title+year dedupe).
 * "https://doi.org/10.1/ABC" → "10.1/abc"
 */
export function normalizeDoi(raw: string | undefined): string {
  return (raw ?? "").trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").toLowerCase();
}

/**
 * Dedupe identity: DOI first, otherwise normalized title + year. The returned
 * key is prefixed ("doi:..." / "title:...|year:...") so a DOI can never collide
 * with a title key. A missing year yields "year:" — two undated papers are
 * duplicates only when their normalized titles match exactly.
 */
export function literatureDedupeKey(input: { title: string; year?: number; doi?: string }): string {
  const doi = normalizeDoi(input.doi);
  if (doi) return `doi:${doi}`;
  const title = input.title.trim().toLowerCase().replace(/\s+/g, " ");
  return `title:${title}|year:${input.year ?? ""}`;
}

/**
 * Sluggify a citation/section key: lowercase ASCII alnum + dash. Non-ASCII text
 * (e.g. CJK titles) is stripped entirely and the result is capped at 40 chars,
 * so it may be ""; callers that need a non-empty key must add their own
 * deterministic fallback (sectionKeyFromTitle does).
 */
export function slugKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/**
 * Base citation key in the familiar "author+year" style ("zhang2024").
 * The surname is the last whitespace-separated token of the first author, so
 * "San Zhang" → "zhang" while a purely CJK name has no ASCII left and becomes
 * "anon"; a missing year becomes "nd". Pure and allocation-cheap: callers doing
 * bulk work pair it with uniqueCiteKey and a cached `taken` set.
 */
export function citeKeyBase(input: { authors?: string[]; year?: number }): string {
  const first = (input.authors ?? [])[0]?.trim() ?? "";
  const tokens = first.split(/\s+/).filter(Boolean);
  const surname = (tokens[tokens.length - 1] ?? "").toLowerCase().replace(/[^a-z0-9]/g, "") || "anon";
  const year = input.year ? String(input.year) : "nd";
  return `${surname}${year}`;
}

/**
 * First free variant of `base` given the project's already-taken keys
 * (case-insensitive; callers keep `taken` lowercased). Tries the 26 a..z
 * suffixes before a time-based suffix, so it always returns a key. O(1) against
 * a caller-maintained set — this is the bulk-import seam.
 */
export function uniqueCiteKey(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 0; i < 26; i += 1) {
    const candidate = `${base}${String.fromCharCode(97 + i)}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base}${Date.now().toString(36).slice(-4)}`;
}

/**
 * Citation key in the familiar "author+year" style ("zhang2024").
 * Non-ASCII author names fall back to "anon"; duplicates get a/b/c suffixes.
 *
 * Convenience wrapper for single adds: it materializes the taken set from
 * `existing`. Bulk paths (addMany) must maintain their own set and call
 * citeKeyBase + uniqueCiteKey, otherwise key resolution degrades to O(N) per row.
 */
export function citeKeyFor(
  input: { title: string; authors?: string[]; year?: number; doi?: string },
  existing: Iterable<string> = [],
): string {
  return uniqueCiteKey(citeKeyBase(input), new Set([...existing].map((key) => key.toLowerCase())));
}

/**
 * Standard paper outline used when a document is created without explicit
 * sections. Keys are stable slugs (not title-derived) so saves and exports keep
 * addressing the same section after a heading rename; callers must clone the
 * array before mutating it (the exported constant is shared).
 */
export function defaultManuscriptSections(): AcademicSectionInput[] {
  return [
    { key: "abstract", title: "摘要", content: "", order: 0 },
    { key: "introduction", title: "引言", content: "", order: 1 },
    { key: "related-work", title: "相关工作", content: "", order: 2 },
    { key: "method", title: "方法", content: "", order: 3 },
    { key: "experiment", title: "实验", content: "", order: 4 },
    { key: "conclusion", title: "结论", content: "", order: 5 },
  ];
}

/**
 * Reading word count: CJK characters count once each, latin words count once
 * each (mixed text counts both parts, so "Hello" plus two CJK characters is 3). Used for progress
 * meters only — it is not a linguistic tokenizer. Empty/blank input yields 0.
 */
export function wordCount(text: string): number {
  if (!text) return 0;
  const cjk = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g)?.length ?? 0;
  const latin = text
    .replace(/[\u4e00-\u9fff\u3400-\u4dbf]/g, " ")
    .split(/\s+/)
    .filter((w) => /[a-z0-9]/i.test(w)).length;
  return cjk + latin;
}
