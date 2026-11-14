/**
 * In-process (memory) implementation of the four academic repositories.
 *
 * Layer: repository implementation, reached only through the contracts in
 * repository/academic.ts — services, tools and HTTP routes never import this
 * class; the composition root picks it as the fallback/test double for
 * MongoAcademicStore.
 *
 * Invariants:
 *  - process-local and non-durable: state dies with the process, so this store
 *    is for tests and for degraded boot when Mongo is unreachable;
 *  - every lookup is uid-scoped (project ids are random UUIDs, but uid still
 *    gates every read/write — a guessed id must never cross users);
 *  - reads and writes deep-copy (structuredClone), so caller-owned objects never
 *    alias stored state;
 *  - event/import timestamps are strictly monotonic, so newest-first feeds stay
 *    deterministic within a single millisecond;
 *  - write-time indexes (dedupe key / per-project ids + citeKeys) are the fast
 *    path for add/addMany/count/lookups; they store ids only, never row bodies,
 *    so the structuredClone-on-read contract above still holds;
 *  - one class object satisfies all four repository interfaces (the shared
 *    method names list/get/remove dispatch by arity, see below).
 */
import { randomUUID } from "node:crypto";
import {
  ACADEMIC_STAGES,
  citeKeyBase,
  uniqueCiteKey,
  initialStageStates,
  literatureDedupeKey,
  normalizeDoi,
  slugKey,
  type AcademicActor,
  type AcademicDocument,
  type AcademicDocumentExport,
  type AcademicDocumentRepository,
  type AcademicDocumentSource,
  type AcademicEvent,
  type AcademicEventRepository,
  type AcademicLiteratureAddResult,
  type AcademicLiteratureEntry,
  type AcademicLiteratureInput,
  type AcademicLiteratureRepository,
  type AcademicProject,
  type AcademicProjectCreate,
  type AcademicProjectPatch,
  type AcademicProjectRepository,
  type AcademicSection,
  type AcademicSectionInput,
  type AcademicStage,
  type AcademicStageState,
} from "../academic.js";

/** Paper type assumed when the caller does not choose one (web has no project console). */
const DEFAULT_PAPER_TYPE = "journal";

/** Feed size when list() is called without an explicit limit. */
const DEFAULT_EVENT_LIMIT = 20;

/**
 * Defensive deep copy used on every read and write. structuredClone keeps
 * caller-owned objects from aliasing stored state (and vice versa) without
 * hand-writing a clone helper per entity; it also covers nested plans/advice.
 */
function copy<T>(value: T): T {
  return structuredClone(value);
}

// ---------------------------------------------------------------------------
// Project patch application (semantics mirrored by the Mongo adapter)
// ---------------------------------------------------------------------------

/**
 * Builds a fresh project entity: generated id, defaults for omitted optional
 * fields, the stage machine started at "topic" and empty plans/advice. Optional
 * fields are omitted (not set to undefined) so the object graph matches what the
 * Mongo adapter round-trips.
 */
function newProject(uid: string, input: AcademicProjectCreate, at: number): AcademicProject {
  return {
    id: randomUUID(),
    uid,
    title: input.title,
    paperType: input.paperType ?? DEFAULT_PAPER_TYPE,
    field: input.field ?? "",
    ...(input.targetJournal !== undefined ? { targetJournal: input.targetJournal } : {}),
    ...(input.deadline !== undefined ? { deadline: input.deadline } : {}),
    stage: "topic",
    stages: initialStageStates(at),
    plans: {},
    advice: {},
    createdAt: at,
    updatedAt: at,
  };
}

/**
 * Shallow-merge plain fields, then merge stages/plans/advice key by key (contract
 * semantics). Works on a clone so the stored project is never mutated in place;
 * patch-provided stage/plan values are cloned again by the merge helpers, which
 * is what keeps a later mutation of the caller's patch object out of the store.
 */
function applyProjectPatch(base: AcademicProject, patch: AcademicProjectPatch, at: number): AcademicProject {
  const next = copy(base);
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.paperType !== undefined) next.paperType = patch.paperType;
  if (patch.field !== undefined) next.field = patch.field;
  if (patch.targetJournal !== undefined) next.targetJournal = patch.targetJournal;
  if (patch.deadline !== undefined) next.deadline = patch.deadline;
  if (patch.stage !== undefined) next.stage = patch.stage;
  if (patch.stages) next.stages = mergeStages(next.stages, patch.stages);
  if (patch.plans) next.plans = mergePlans(next.plans, patch.plans);
  if (patch.advice) next.advice = mergeAdvice(next.advice, patch.advice);
  next.updatedAt = at;
  return next;
}

/** Merge one stage state per provided key; a provided state replaces the old one wholesale. */
function mergeStages(
  base: Record<AcademicStage, AcademicStageState>,
  patch: Partial<Record<AcademicStage, AcademicStageState>>,
): Record<AcademicStage, AcademicStageState> {
  const merged = copy(base);
  for (const stage of ACADEMIC_STAGES) {
    const provided = patch[stage];
    if (provided !== undefined) merged[stage] = copy(provided);
  }
  return merged;
}

/** Merge one plan array per provided key; an empty array is a deliberate clear, not "no change". */
function mergePlans(
  base: AcademicProject["plans"],
  patch: NonNullable<AcademicProjectPatch["plans"]>,
): AcademicProject["plans"] {
  const merged = copy(base);
  for (const stage of ACADEMIC_STAGES) {
    const provided = patch[stage];
    if (provided !== undefined) merged[stage] = copy(provided);
  }
  return merged;
}

/** Merge one advice string per provided key (advice has no nested structure to clone deeper). */
function mergeAdvice(
  base: AcademicProject["advice"],
  patch: NonNullable<AcademicProjectPatch["advice"]>,
): AcademicProject["advice"] {
  const merged = copy(base);
  for (const stage of ACADEMIC_STAGES) {
    const provided = patch[stage];
    if (provided !== undefined) merged[stage] = provided;
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Literature helpers (semantics mirrored by the Mongo adapter)
// ---------------------------------------------------------------------------

/**
 * Caller-suggested citeKey wins; otherwise derive "author+year". `taken` is the
 * project's lowercased citeKey set maintained by the caller (O(1) per lookup), so
 * this stays cheap inside bulk imports.
 */
function resolveCiteKey(input: AcademicLiteratureInput, taken: ReadonlySet<string>): string {
  const suggested = input.citeKey?.trim();
  return uniqueCiteKey(suggested || citeKeyBase(input), taken);
}

/**
 * Builds a fresh library entry: generated id, normalized DOI, verified=false and
 * caller-supplied author arrays copied. Optional fields are omitted rather than
 * set to undefined so the stored record matches the Mongo document shape.
 */
function newLiteratureEntry(
  uid: string,
  projectId: string,
  input: AcademicLiteratureInput,
  citeKey: string,
  at: number,
): AcademicLiteratureEntry {
  // DOI is stored normalized (lowercase, scheme/prefix stripped) so findByDoi and
  // the Mongo {uid, projectId, doi} index are exact-match; the original spelling is
  // recoverable from the source URL and normalization is documented contract behavior.
  const doi = normalizeDoi(input.doi);
  return {
    id: randomUUID(),
    uid,
    projectId,
    citeKey,
    title: input.title,
    authors: input.authors ? [...input.authors] : [],
    ...(input.year !== undefined ? { year: input.year } : {}),
    ...(input.venue !== undefined ? { venue: input.venue } : {}),
    ...(doi ? { doi } : {}),
    ...(input.url !== undefined ? { url: input.url } : {}),
    ...(input.abstract !== undefined ? { abstract: input.abstract } : {}),
    source: input.source ?? "manual",
    verified: false,
    importedAt: at,
  };
}

// ---------------------------------------------------------------------------
// In-memory indexes (the fast path for dedupe / counts / per-project reads)
// ---------------------------------------------------------------------------

/**
 * Composite key for the indexes below. uid and projectId are server-generated
 * and never contain NUL, so the fixed two-field prefix cannot collide across
 * tenants; the trailing dedupe key is only ever compared inside one
 * (uid, projectId) scope.
 */
function scopeKey(uid: string, projectId: string): string {
  return `${uid}\u0000${projectId}`;
}

/** Identity probe key: (uid, projectId, literatureDedupeKey) -> entry id. */
function dedupeIndexKey(uid: string, projectId: string, dedupeKey: string): string {
  return `${uid}\u0000${projectId}\u0000${dedupeKey}`;
}

/**
 * Per-project library index: the project's entry ids plus a lowercased
 * citeKey -> entry id map. Keeping it per project means add/addMany/count/
 * findByDoi/get never scan the whole cross-user library, while uid isolation is
 * still structural (the key starts with uid, and every hit is re-checked against
 * the stored entry by callers).
 */
interface LiteratureProjectIndex {
  ids: Set<string>;
  citeKeys: Map<string, string>;
  /** normalized DOI -> entry id, so findByDoi is O(1) instead of a project scan. */
  dois: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Document/section helpers (semantics mirrored by the Mongo adapter)
// ---------------------------------------------------------------------------

/**
 * Stable section key. slugKey() strips all non-ASCII, so a pure-CJK title would
 * otherwise derive ""; the hash fallback keeps repeated saves of the same title on
 * the same section (upsert) instead of creating a new one per call.
 */
function sectionKeyFromTitle(title: string): string {
  const slug = slugKey(title);
  if (slug) return slug;
  let hash = 0;
  for (const ch of title) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return `s${hash.toString(36)}`;
}

/**
 * Disambiguates section keys inside one document write: the first occurrence
 * keeps the base key, later collisions get -2, -3, ... . The counter is bounded;
 * the time-based fallback only triggers in pathological documents and never
 * returns an empty key.
 */
function uniqueSectionKey(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/**
 * Materializes one section input: trims/derives the key, registers it in the
 * caller's taken-set (so duplicates inside the same batch get suffixed),
 * defaults content to "" and order to the batch position.
 */
function sectionFromInput(
  input: AcademicSectionInput,
  fallbackOrder: number,
  at: number,
  taken: Set<string>,
): AcademicSection {
  const explicit = input.key?.trim();
  const key = uniqueSectionKey(explicit || sectionKeyFromTitle(input.title), taken);
  taken.add(key);
  return {
    key,
    title: input.title,
    content: input.content ?? "",
    order: input.order ?? fallbackOrder,
    updatedAt: at,
  };
}

/**
 * Canonical section order: order ascending with the key as tie-break, so equal
 * orders still render deterministically. Returns a new array — the input array
 * is left untouched.
 */
function sortSections(sections: AcademicSection[]): AcademicSection[] {
  return [...sections].sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
}

/** Next free order = max(order) + 1 (0 for an empty document); existing gaps are preserved. */
function nextSectionOrder(sections: AcademicSection[]): number {
  return sections.reduce((max, section) => Math.max(max, section.order), -1) + 1;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Single in-memory object implementing the project, literature, document and
 * event repositories at once. One instance is injected wherever the four
 * contracts are needed, mirroring MongoAcademicStore so call sites and tests can
 * swap the two implementations without changes.
 *
 * Not persistent and not thread/process safe by design (the Node event loop and
 * awaited methods keep each operation atomic enough for tests); there is no TTL,
 * no migration and no recovery path — restarting the process starts empty.
 */
export class MemoryAcademicStore
  implements
    AcademicProjectRepository,
    AcademicLiteratureRepository,
    AcademicDocumentRepository,
    AcademicEventRepository
{
  private readonly projects = new Map<string, AcademicProject>();
  private readonly literature = new Map<string, AcademicLiteratureEntry>();
  private readonly documents = new Map<string, AcademicDocument>();
  private readonly events: AcademicEvent[] = [];
  /** (uid, projectId, dedupeKey) -> entry id: O(1) identity probe behind add/addMany. */
  private readonly literatureDedupe = new Map<string, string>();
  /** (uid, projectId) -> per-project library index (entry ids + citeKeys). */
  private readonly literatureProjects = new Map<string, LiteratureProjectIndex>();
  /** (uid, projectId) -> document ids, so counts/lists never scan every project's documents. */
  private readonly documentProjects = new Map<string, Set<string>>();
  /** Monotonic fallbacks: two writes in the same millisecond still sort deterministically. */
  private lastImportedAt = 0;
  private lastEventAt = 0;

  // ---- projects -----------------------------------------------------------

  /**
   * Creates a project for uid and returns a deep copy. No uniqueness check is
   * needed: the id is generated here and two projects may legitimately share a
   * title.
   */
  async create(uid: string, input: AcademicProjectCreate): Promise<AcademicProject> {
    const project = newProject(uid, input, Date.now());
    this.projects.set(project.id, project);
    return copy(project);
  }

  /**
   * The project/literature repositories share the method names list/get/remove.
   * Overloads keep a single object assignable to every interface; dispatch is by
   * arity: list(uid) = projects, list(uid, projectId) = literature. Events use a
   * distinct method name (listEvents) so a 2-arg call cannot silently resolve to
   * the literature list at runtime. The arity check is explicit (projectId
   * === undefined), not a truthiness test, so an empty projectId still means
   * "literature of project ''" rather than "all projects".
   *
   * Projects come back most-recently-updated first and literature
   * most-recently-imported first; both return [] for an unknown uid/project.
   */
  async list(uid: string): Promise<AcademicProject[]>;
  async list(uid: string, projectId: string): Promise<AcademicLiteratureEntry[]>;
  async list(uid: string, projectId?: string): Promise<AcademicProject[] | AcademicLiteratureEntry[]> {
    return projectId === undefined ? this.listProjects(uid) : this.listLiterature(uid, projectId);
  }

  /**
   * Newest-first project events (explicit limit; default feed size when omitted).
   * The limit is sanitized: non-finite -> default, negative -> empty result. Each
   * event is a deep copy so callers cannot mutate the feed.
   */
  async listEvents(uid: string, projectId: string, limit = DEFAULT_EVENT_LIMIT): Promise<AcademicEvent[]> {
    return this.listEventsInternal(uid, projectId, limit);
  }

  /**
   * Arity dispatch again: get(uid, projectId) resolves a project, get(uid,
   * projectId, ref) resolves a library entry by id or citeKey. Both are
   * uid-scoped and return null for missing or foreign records.
   */
  async get(uid: string, projectId: string): Promise<AcademicProject | null>;
  async get(uid: string, projectId: string, ref: string): Promise<AcademicLiteratureEntry | null>;
  async get(
    uid: string,
    projectId: string,
    ref?: string,
  ): Promise<AcademicProject | AcademicLiteratureEntry | null> {
    return ref === undefined ? this.getProject(uid, projectId) : this.getLiterature(uid, projectId, ref);
  }

  /**
   * Applies a partial update and returns the stored result (deep copy), or null
   * when the project does not exist under uid. createdAt is preserved; updatedAt
   * is always bumped to now.
   */
  async update(
    uid: string,
    projectId: string,
    patch: AcademicProjectPatch,
  ): Promise<AcademicProject | null> {
    const project = this.projects.get(projectId);
    if (!project || project.uid !== uid) return null;
    const next = applyProjectPatch(project, patch, Date.now());
    this.projects.set(projectId, next);
    return copy(next);
  }

  /**
   * Arity dispatch: remove(uid, projectId) deletes a project, remove(uid,
   * projectId, ref) deletes a library entry by id or citeKey. Returns false when
   * nothing was deleted (unknown id, wrong uid, already gone), so deletion is
   * idempotent from the caller's point of view.
   */
  async remove(uid: string, projectId: string): Promise<boolean>;
  async remove(uid: string, projectId: string, ref: string): Promise<boolean>;
  async remove(uid: string, projectId: string, ref?: string): Promise<boolean> {
    return ref === undefined ? this.removeProject(uid, projectId) : this.removeLiterature(uid, projectId, ref);
  }

  // ---- literature ---------------------------------------------------------

  /**
   * Imports a paper. Dedupe runs on literatureDedupeKey through the O(1) index
   * probe (no library scan), so a repeated import returns the stored entry with
   * duplicate=true and leaves it untouched (the original metadata wins). New
   * entries get a citeKey uniquified against the project's citeKey index and a
   * monotonic importedAt.
   */
  async add(
    uid: string,
    projectId: string,
    input: AcademicLiteratureInput,
  ): Promise<AcademicLiteratureAddResult> {
    const duplicate = this.duplicateLiterature(uid, projectId, literatureDedupeKey(input));
    if (duplicate) return { entry: copy(duplicate), duplicate: true };
    const index = this.projectLibrary(uid, projectId);
    // Materialize the lowercased key set once (O(N_project)); addMany reuses one set
    // for the whole batch instead of rebuilding it per row.
    const taken = new Set([...index.citeKeys.keys()].map((key) => key.toLowerCase()));
    const entry = newLiteratureEntry(
      uid,
      projectId,
      input,
      resolveCiteKey(input, taken),
      this.nextImportedAt(),
    );
    this.storeLiterature(index, entry);
    return { entry: copy(entry), duplicate: false };
  }

  /**
   * Bulk import: one pass over the batch against the write-time indexes, so N
   * imports cost O(N) index probes instead of N full-library scans. A paper that
   * already exists (or that appeared earlier in this batch) resolves to the
   * first occurrence with duplicate=true; the rest are stored, and results keep
   * input order (the contract's bulk path).
   */
  async addMany(
    uid: string,
    projectId: string,
    inputs: AcademicLiteratureInput[],
  ): Promise<AcademicLiteratureAddResult[]> {
    const results: AcademicLiteratureAddResult[] = [];
    if (inputs.length === 0) return results;
    // Created lazily so an all-duplicate batch never materializes an empty project index.
    let index: LiteratureProjectIndex | undefined;
    // Lowercased citeKey set, built once for the batch so key resolution is O(1)/row.
    let taken: Set<string> | undefined;
    for (const input of inputs) {
      const duplicate = this.duplicateLiterature(uid, projectId, literatureDedupeKey(input));
      if (duplicate) {
        results.push({ entry: copy(duplicate), duplicate: true });
        continue;
      }
      index ??= this.projectLibrary(uid, projectId);
      taken ??= new Set([...index.citeKeys.keys()].map((key) => key.toLowerCase()));
      const entry = newLiteratureEntry(
        uid,
        projectId,
        input,
        resolveCiteKey(input, taken),
        this.nextImportedAt(),
      );
      this.storeLiterature(index, entry);
      taken.add(entry.citeKey.toLowerCase());
      results.push({ entry: copy(entry), duplicate: false });
    }
    return results;
  }

  /**
   * Number of entries in the project library. Served by the per-project index
   * (size only), so it never touches row bodies or clones them.
   */
  async count(uid: string, projectId: string): Promise<number> {
    return this.literatureProjects.get(scopeKey(uid, projectId))?.ids.size ?? 0;
  }

  /**
   * Exact lookup by normalized DOI inside one project. Returns null for an empty
   * DOI (instead of matching DOI-less entries) and for foreign projects.
   */
  async findByDoi(uid: string, projectId: string, doi: string): Promise<AcademicLiteratureEntry | null> {
    const normalized = normalizeDoi(doi);
    if (!normalized) return null;
    const id = this.literatureProjects.get(scopeKey(uid, projectId))?.dois.get(normalized);
    const entry = id ? this.literature.get(id) : undefined;
    return entry ? copy(entry) : null;
  }

  /**
   * Sets or revokes the verification flag. Verifying stamps verifiedAt=now;
   * revoking deletes the field so "present" always means "true". Returns null for
   * unknown or foreign references.
   */
  async setVerified(
    uid: string,
    projectId: string,
    ref: string,
    verified: boolean,
  ): Promise<AcademicLiteratureEntry | null> {
    const entry = this.findLiterature(uid, projectId, ref);
    if (!entry) return null;
    const next = copy(entry);
    next.verified = verified;
    if (verified) next.verifiedAt = Date.now();
    else delete next.verifiedAt;
    this.literature.set(entry.id, next);
    return copy(next);
  }

  // ---- documents ----------------------------------------------------------

  /**
   * Creates a document and derives/sorts its initial sections. Section keys are
   * deduplicated inside this batch, so two sections with the same title become
   * "slug" and "slug-2" instead of colliding. A Word import also records the
   * original upload (`source`), cloned like every other caller-owned value.
   */
  async createDocument(
    uid: string,
    projectId: string,
    input: {
      kind: AcademicDocument["kind"];
      title: string;
      sections?: AcademicSectionInput[];
      source?: AcademicDocumentSource;
    },
  ): Promise<AcademicDocument> {
    const at = Date.now();
    const taken = new Set<string>();
    const sections = (input.sections ?? []).map((section, index) =>
      sectionFromInput(section, index, at, taken),
    );
    const document: AcademicDocument = {
      id: randomUUID(),
      uid,
      projectId,
      kind: input.kind,
      title: input.title,
      sections: sortSections(sections),
      ...(input.source !== undefined ? { source: copy(input.source) } : {}),
      createdAt: at,
      updatedAt: at,
    };
    this.documents.set(document.id, document);
    this.documentIndexFor(uid, projectId).add(document.id);
    return copy(document);
  }

  /**
   * Documents of one project, most recently updated first (createdAt then id as
   * tie-breaks, so same-millisecond writes still have a stable order). Iterates
   * the project's id set instead of filtering every tenant's documents.
   */
  async listDocuments(uid: string, projectId: string): Promise<AcademicDocument[]> {
    const ids = this.documentProjects.get(scopeKey(uid, projectId));
    if (!ids) return [];
    const documents: AcademicDocument[] = [];
    for (const id of ids) {
      const document = this.documents.get(id);
      if (document) documents.push(document);
    }
    return documents
      .sort(
        (a, b) =>
          b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id),
      )
      .map(copy);
  }

  /**
   * Number of documents in the project. Served by the per-project id set (size
   * only), so it never loads or clones row bodies.
   */
  async countDocuments(uid: string, projectId: string): Promise<number> {
    return this.documentProjects.get(scopeKey(uid, projectId))?.size ?? 0;
  }

  /** Returns (creating on first write) the per-project document id set. */
  private documentIndexFor(uid: string, projectId: string): Set<string> {
    const key = scopeKey(uid, projectId);
    let ids = this.documentProjects.get(key);
    if (!ids) {
      ids = new Set();
      this.documentProjects.set(key, ids);
    }
    return ids;
  }

  /** Loads a document by id, scoped by uid; null when missing or owned by someone else. */
  async getDocument(uid: string, documentId: string): Promise<AcademicDocument | null> {
    const document = this.documents.get(documentId);
    return document && document.uid === uid ? copy(document) : null;
  }

  /**
   * Metadata update: title plus the optional Word source/lastExport records;
   * createdAt and the sections are untouched. Patch values are cloned on write,
   * so a later caller mutation cannot rewrite stored state. Returns null for
   * unknown or foreign documents.
   */
  async updateDocument(
    uid: string,
    documentId: string,
    patch: { title?: string; source?: AcademicDocumentSource; lastExport?: AcademicDocumentExport },
  ): Promise<AcademicDocument | null> {
    const document = this.documents.get(documentId);
    if (!document || document.uid !== uid) return null;
    const next = copy(document);
    if (patch.title !== undefined) next.title = patch.title;
    if (patch.source !== undefined) next.source = copy(patch.source);
    if (patch.lastExport !== undefined) next.lastExport = copy(patch.lastExport);
    next.updatedAt = Date.now();
    this.documents.set(documentId, next);
    return copy(next);
  }

  /**
   * Inserts or updates a section identified by its key. Updating keeps the stored
   * key and falls back to the existing content/order when the input omits them;
   * appending uses the next free order. Sections are re-sorted and updatedAt is
   * bumped on every upsert (even a title-only change).
   */
  async upsertSection(
    uid: string,
    documentId: string,
    input: AcademicSectionInput,
  ): Promise<AcademicDocument | null> {
    const document = this.documents.get(documentId);
    if (!document || document.uid !== uid) return null;
    const at = Date.now();
    const key = input.key?.trim() || sectionKeyFromTitle(input.title);
    const sections = document.sections.map(copy);
    const index = sections.findIndex((section) => section.key === key);
    if (index >= 0) {
      const current = sections[index];
      sections[index] = {
        key: current.key,
        title: input.title,
        content: input.content !== undefined ? input.content : current.content,
        order: input.order !== undefined ? input.order : current.order,
        updatedAt: at,
      };
    } else {
      sections.push({
        key,
        title: input.title,
        content: input.content ?? "",
        order: input.order ?? nextSectionOrder(sections),
        updatedAt: at,
      });
    }
    const next: AcademicDocument = {
      ...copy(document),
      sections: sortSections(sections),
      updatedAt: at,
    };
    this.documents.set(documentId, next);
    return copy(next);
  }

  /**
   * Removes a section by key. An unknown key is a no-op that returns the current
   * document without bumping updatedAt (nothing changed, so no write and no
   * spurious "updated" signal). Returns null for unknown or foreign documents.
   */
  async deleteSection(
    uid: string,
    documentId: string,
    sectionKey: string,
  ): Promise<AcademicDocument | null> {
    const document = this.documents.get(documentId);
    if (!document || document.uid !== uid) return null;
    const sections = document.sections.filter((section) => section.key !== sectionKey).map(copy);
    if (sections.length === document.sections.length) return copy(document);
    const at = Date.now();
    const next: AcademicDocument = { ...copy(document), sections, updatedAt: at };
    this.documents.set(documentId, next);
    return copy(next);
  }

  // ---- events -------------------------------------------------------------

  /**
   * Appends one event to the project feed. The payload is cloned so later caller
   * mutation cannot rewrite history; actor defaults to "agent" (agents are the
   * main producer) and createdAt is monotonic.
   */
  async append(
    uid: string,
    projectId: string,
    type: string,
    payload: Record<string, unknown> = {},
    actor: AcademicActor = "agent",
  ): Promise<AcademicEvent> {
    const event: AcademicEvent = {
      id: randomUUID(),
      uid,
      projectId,
      type,
      payload: copy(payload),
      actor,
      createdAt: this.nextEventAt(),
    };
    this.events.push(event);
    return copy(event);
  }

  // ---- implementations of the shared method names -------------------------

  /** Projects of one uid, most recently updated first; id is the final tie-break for stable output. */
  private listProjects(uid: string): AcademicProject[] {
    return [...this.projects.values()]
      .filter((project) => project.uid === uid)
      .sort(
        (a, b) =>
          b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id),
      )
      .map(copy);
  }

  /** uid gate: a project loaded by id is only visible to its owner. */
  private getProject(uid: string, projectId: string): AcademicProject | null {
    const project = this.projects.get(projectId);
    return project && project.uid === uid ? copy(project) : null;
  }

  /** Deletes only when the stored project belongs to uid; returns whether a row was removed. */
  private removeProject(uid: string, projectId: string): boolean {
    const project = this.projects.get(projectId);
    if (!project || project.uid !== uid) return false;
    this.projects.delete(projectId);
    return true;
  }

  /** Library listing: newest import first; citeKey tie-breaks equal importedAt stamps. */
  private listLiterature(uid: string, projectId: string): AcademicLiteratureEntry[] {
    return this.literatureFor(uid, projectId)
      .sort((a, b) => b.importedAt - a.importedAt || a.citeKey.localeCompare(b.citeKey))
      .map(copy);
  }

  /** Resolves id-or-citeKey and copies, so callers never hold the stored object. */
  private getLiterature(uid: string, projectId: string, ref: string): AcademicLiteratureEntry | null {
    const entry = this.findLiterature(uid, projectId, ref);
    return entry ? copy(entry) : null;
  }

  /**
   * Resolves id-or-citeKey first (so citeKey deletes work), then removes the id
   * from the library map and from every index that points at it (project id set,
   * citeKey map, dedupe probe) so a later import of the same paper inserts again
   * instead of reporting a stale duplicate.
   */
  private removeLiterature(uid: string, projectId: string, ref: string): boolean {
    const entry = this.findLiterature(uid, projectId, ref);
    if (!entry) return false;
    this.literature.delete(entry.id);
    const key = scopeKey(uid, projectId);
    const index = this.literatureProjects.get(key);
    if (index) {
      index.ids.delete(entry.id);
      index.citeKeys.delete(entry.citeKey.toLowerCase());
      if (entry.doi) index.dois.delete(entry.doi);
      if (index.ids.size === 0) this.literatureProjects.delete(key);
    }
    this.literatureDedupe.delete(dedupeIndexKey(uid, projectId, literatureDedupeKey(entry)));
    return true;
  }

  /**
   * Shared feed query: caps the limit before slicing, so a caller passing
   * Infinity/NaN/negative cannot scan or mis-slice the whole array.
   */
  private listEventsInternal(uid: string, projectId: string, limit: number): AcademicEvent[] {
    const capped = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : DEFAULT_EVENT_LIMIT;
    return this.events
      .filter((event) => event.uid === uid && event.projectId === projectId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, capped)
      .map(copy);
  }

  // ---- internals ----------------------------------------------------------

  /**
   * Entries of one project, unsorted (listLiterature sorts). Reads the project's
   * id set instead of scanning every tenant's library, and returns internal
   * objects — callers must copy before handing them out.
   */
  private literatureFor(uid: string, projectId: string): AcademicLiteratureEntry[] {
    const index = this.literatureProjects.get(scopeKey(uid, projectId));
    if (!index) return [];
    const entries: AcademicLiteratureEntry[] = [];
    for (const id of index.ids) {
      const entry = this.literature.get(id);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  /** Returns (creating on first write) the per-project library index. */
  private projectLibrary(uid: string, projectId: string): LiteratureProjectIndex {
    const key = scopeKey(uid, projectId);
    let index = this.literatureProjects.get(key);
    if (!index) {
      index = { ids: new Set(), citeKeys: new Map(), dois: new Map() };
      this.literatureProjects.set(key, index);
    }
    return index;
  }

  /** Registers a new entry in the library map and in every write-time index, keeping them consistent. */
  private storeLiterature(index: LiteratureProjectIndex, entry: AcademicLiteratureEntry): void {
    this.literature.set(entry.id, entry);
    index.ids.add(entry.id);
    index.citeKeys.set(entry.citeKey.toLowerCase(), entry.id);
    if (entry.doi) index.dois.set(entry.doi, entry.id);
    this.literatureDedupe.set(
      dedupeIndexKey(entry.uid, entry.projectId, literatureDedupeKey(entry)),
      entry.id,
    );
  }

  /** O(1) identity probe: resolves the stored row carrying the same dedupe key, if any. */
  private duplicateLiterature(
    uid: string,
    projectId: string,
    dedupeKey: string,
  ): AcademicLiteratureEntry | undefined {
    const probe = dedupeIndexKey(uid, projectId, dedupeKey);
    const id = this.literatureDedupe.get(probe);
    if (id === undefined) return undefined;
    const entry = this.literature.get(id);
    if (entry) return entry;
    // Stale id: drop the probe and let the caller insert again rather than lose the row.
    this.literatureDedupe.delete(probe);
    return undefined;
  }

  /**
   * Resolves an entry id or citeKey (citeKeys are matched case-insensitively).
   * Both paths are O(1): the id path is a library map hit re-checked against
   * uid/project, the citeKey path is the project's lowercased citeKey map —
   * mirroring MongoDB's collation-based query so both implementations accept the
   * same refs.
   */
  private findLiterature(
    uid: string,
    projectId: string,
    ref: string,
  ): AcademicLiteratureEntry | undefined {
    const byId = this.literature.get(ref);
    if (byId && byId.uid === uid && byId.projectId === projectId) return byId;
    const entryId = this.literatureProjects
      .get(scopeKey(uid, projectId))
      ?.citeKeys.get(ref.toLowerCase());
    return entryId !== undefined ? this.literature.get(entryId) : undefined;
  }

  /**
   * importedAt source: strictly increasing even for writes in the same
   * millisecond (+1ms fallback), so list(uid, projectId) ordering is
   * deterministic instead of depending on Map insertion order.
   */
  private nextImportedAt(): number {
    const now = Date.now();
    this.lastImportedAt = now > this.lastImportedAt ? now : this.lastImportedAt + 1;
    return this.lastImportedAt;
  }

  /**
   * createdAt source for the event feed: strictly increasing (+1ms fallback), so
   * newest-first ordering is stable for events appended within one millisecond and
   * matches the Mongo adapter's {createdAt:-1, _id:1} sort.
   */
  private nextEventAt(): number {
    const now = Date.now();
    this.lastEventAt = now > this.lastEventAt ? now : this.lastEventAt + 1;
    return this.lastEventAt;
  }
}
