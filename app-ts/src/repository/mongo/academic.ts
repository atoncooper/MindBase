/**
 * MongoDB adapter for the four academic repositories (durable counterpart of
 * repository/memory/academic.ts).
 *
 * Layer: repository implementation behind the repository/academic.ts contracts;
 * only the composition root (bootstrap/container.ts) instantiates it, falling
 * back to MemoryAcademicStore when connect() returns null. Tools, services and
 * HTTP routes import the contract, never this class.
 *
 * Storage: the app-ts-owned database (config.mongo.database, i.e. mind_base_ts;
 * the Python mind_base DB is not used). Collections are academic_* and _id
 * mirrors the entity id.
 *
 * Tenancy: every query filter carries uid. Project/document ids are random UUIDs,
 * but a guessed id must never cross users — and since every index is uid-prefixed,
 * an unscoped query would also be a collection scan.
 *
 * Consistency: single-document writes are atomic. Project updates are one
 * findOneAndUpdate with per-field $set (no read-modify-replace), so a patch can
 * never resurrect stale sibling fields; document section writes still
 * read-modify-replace because sections are embedded and merged by key. Either
 * way a concurrent change to the *same* field can be lost (last write wins),
 * which is acceptable because the academic agent serializes edits per project
 * per user; nothing here spans multiple documents.
 */
import { MongoClient, type Collection, type Document as MongoDoc } from "mongodb";
import { randomUUID } from "node:crypto";
import { config } from "../../config/index.js";
import { createLogger } from "../../logger.js";
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
  type AcademicDocumentKind,
  type AcademicDocumentRepository,
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

const log = createLogger("MONGO");

/** Collections of the app-ts-owned mind_base_ts database . */
const PROJECTS = "academic_projects";
const LITERATURE = "academic_literature";
const DOCUMENTS = "academic_documents";
const EVENTS = "academic_events";

/** Paper type assumed when the caller does not choose one (web has no project console). */
const DEFAULT_PAPER_TYPE = "journal";
/** Feed size when listEvents() is called without an explicit limit. */
const DEFAULT_EVENT_LIMIT = 20;

// ---------------------------------------------------------------------------
// Documents as stored in Mongo (_id mirrors the entity id)
// ---------------------------------------------------------------------------

/** Project document shape: entity fields plus _id (mirrors AcademicProject.id) and the root uid used by every filter. */
interface ProjectDoc extends MongoDoc {
  _id: string;
  uid: string;
  title: string;
  paperType: AcademicProject["paperType"];
  field: string;
  targetJournal?: string;
  deadline?: string;
  stage: AcademicStage;
  stages: Record<AcademicStage, AcademicStageState>;
  plans: AcademicProject["plans"];
  advice: AcademicProject["advice"];
  createdAt: number;
  updatedAt: number;
}

/** Literature document shape; doi is stored normalized so the {uid, projectId, doi} index can be a plain equality lookup. */
interface LiteratureDoc extends MongoDoc {
  _id: string;
  uid: string;
  projectId: string;
  citeKey: string;
  title: string;
  authors: string[];
  year?: number;
  venue?: string;
  /** stored normalized (normalizeDoi) so lookups and the {uid, projectId, doi} index are exact */
  doi?: string;
  url?: string;
  abstract?: string;
  source: AcademicLiteratureEntry["source"];
  verified: boolean;
  verifiedAt?: number;
  importedAt: number;
  /**
   * literatureDedupeKey of the row (DOI first, else normalized title+year),
   * computed once at write time so the identity probe is an index hit instead of
   * a collection scan. Rows written before this field existed lack it: they do
   * not match a dedupe query (missing field = non-match, not an error), which is
   * why the compound index below is not unique.
   */
  dedupeKey: string;
}

/** Manuscript document shape; sections are embedded because a document is always read/written as one unit. */
interface DocumentDoc extends MongoDoc {
  _id: string;
  uid: string;
  projectId: string;
  kind: AcademicDocumentKind;
  title: string;
  sections: AcademicSection[];
  createdAt: number;
  updatedAt: number;
}

/** Immutable event document; payload is stored verbatim and never updated. */
interface EventDoc extends MongoDoc {
  _id: string;
  uid: string;
  projectId: string;
  type: string;
  payload: Record<string, unknown>;
  actor: AcademicActor;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Entity <-> document mapping
// ---------------------------------------------------------------------------

/** Maps an entity to its stored form; optional fields are emitted only when present so documents do not accumulate nulls. */
function toProjectDoc(project: AcademicProject): ProjectDoc {
  return {
    _id: project.id,
    uid: project.uid,
    title: project.title,
    paperType: project.paperType,
    field: project.field,
    ...(project.targetJournal !== undefined ? { targetJournal: project.targetJournal } : {}),
    ...(project.deadline !== undefined ? { deadline: project.deadline } : {}),
    stage: project.stage,
    stages: project.stages,
    plans: project.plans,
    advice: project.advice,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

/**
 * Maps a document back to the entity. stages/plans/advice are backfilled for
 * legacy or partially written documents so callers never see undefined and both
 * backends return the same shape.
 */
function toProject(doc: ProjectDoc): AcademicProject {
  return {
    id: doc._id,
    uid: doc.uid,
    title: doc.title,
    paperType: doc.paperType,
    field: doc.field,
    ...(doc.targetJournal !== undefined ? { targetJournal: doc.targetJournal } : {}),
    ...(doc.deadline !== undefined ? { deadline: doc.deadline } : {}),
    stage: doc.stage,
    stages: doc.stages ?? initialStageStates(doc.createdAt),
    plans: doc.plans ?? {},
    advice: doc.advice ?? {},
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/** Maps a library entity to its document; optional metadata is omitted when absent. */
function toLiteratureDoc(entry: AcademicLiteratureEntry): LiteratureDoc {
  return {
    _id: entry.id,
    uid: entry.uid,
    projectId: entry.projectId,
    citeKey: entry.citeKey,
    title: entry.title,
    authors: entry.authors,
    ...(entry.year !== undefined ? { year: entry.year } : {}),
    ...(entry.venue !== undefined ? { venue: entry.venue } : {}),
    ...(entry.doi !== undefined ? { doi: entry.doi } : {}),
    ...(entry.url !== undefined ? { url: entry.url } : {}),
    ...(entry.abstract !== undefined ? { abstract: entry.abstract } : {}),
    source: entry.source,
    verified: entry.verified,
    ...(entry.verifiedAt !== undefined ? { verifiedAt: entry.verifiedAt } : {}),
    importedAt: entry.importedAt,
    // Derived on write (not part of the entity) so the index always matches the
    // contract identity: normalized DOI first, otherwise normalized title+year.
    dedupeKey: literatureDedupeKey(entry),
  };
}

/** Maps a library document back to the entity, defaulting authors/verified for legacy rows. */
function toLiterature(doc: LiteratureDoc): AcademicLiteratureEntry {
  return {
    id: doc._id,
    uid: doc.uid,
    projectId: doc.projectId,
    citeKey: doc.citeKey,
    title: doc.title,
    authors: doc.authors ?? [],
    ...(doc.year !== undefined ? { year: doc.year } : {}),
    ...(doc.venue !== undefined ? { venue: doc.venue } : {}),
    ...(doc.doi !== undefined ? { doi: doc.doi } : {}),
    ...(doc.url !== undefined ? { url: doc.url } : {}),
    ...(doc.abstract !== undefined ? { abstract: doc.abstract } : {}),
    source: doc.source,
    verified: doc.verified ?? false,
    ...(doc.verifiedAt !== undefined ? { verifiedAt: doc.verifiedAt } : {}),
    importedAt: doc.importedAt,
  };
}

/** Maps a manuscript document to its stored form (sections embedded as-is, order already canonical). */
function toDocumentDoc(document: AcademicDocument): DocumentDoc {
  return {
    _id: document.id,
    uid: document.uid,
    projectId: document.projectId,
    kind: document.kind,
    title: document.title,
    sections: document.sections,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
}

/** Maps a stored manuscript document back to the entity, defaulting a missing sections array to []. */
function toDocument(doc: DocumentDoc): AcademicDocument {
  return {
    id: doc._id,
    uid: doc.uid,
    projectId: doc.projectId,
    kind: doc.kind,
    title: doc.title,
    sections: doc.sections ?? [],
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/** Maps an event document back to the entity, defaulting a missing payload to {}. */
function toEvent(doc: EventDoc): AcademicEvent {
  return {
    id: doc._id,
    uid: doc.uid,
    projectId: doc.projectId,
    type: doc.type,
    payload: doc.payload ?? {},
    actor: doc.actor,
    createdAt: doc.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Contract semantics shared with the memory implementation
// (kept in sync with repository/memory/academic.ts — the contract owns the pure
// helpers, but patch-merge / key-derivation stay implementation details)
// ---------------------------------------------------------------------------

/** Builds a fresh project entity; identical to the memory implementation so both backends persist the same document. */
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
 * Translates an AcademicProjectPatch into the $set document of a single
 * findOneAndUpdate: plain fields land at the root, stages/plans/advice become
 * "<field>.<stage>" point paths so a patch never overwrites its siblings.
 *
 * The guard is `!== undefined`, never truthiness: an empty plan array or an
 * empty advice string is a deliberate clear and must be written. Values are
 * cloned so the caller may keep mutating its patch object after the write, and
 * updatedAt is stamped last (always, even for an empty patch).
 */
function projectPatchSet(patch: AcademicProjectPatch, at: number): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.paperType !== undefined) set.paperType = patch.paperType;
  if (patch.field !== undefined) set.field = patch.field;
  if (patch.targetJournal !== undefined) set.targetJournal = patch.targetJournal;
  if (patch.deadline !== undefined) set.deadline = patch.deadline;
  if (patch.stage !== undefined) set.stage = patch.stage;
  if (patch.stages) {
    for (const stage of ACADEMIC_STAGES) {
      const provided = patch.stages[stage];
      if (provided !== undefined) set[`stages.${stage}`] = structuredClone(provided);
    }
  }
  if (patch.plans) {
    for (const stage of ACADEMIC_STAGES) {
      const provided = patch.plans[stage];
      if (provided !== undefined) set[`plans.${stage}`] = structuredClone(provided);
    }
  }
  if (patch.advice) {
    for (const stage of ACADEMIC_STAGES) {
      const provided = patch.advice[stage];
      if (provided !== undefined) set[`advice.${stage}`] = provided;
    }
  }
  set.updatedAt = at;
  return set;
}

/**
 * Caller-suggested citeKey wins; otherwise derive "author+year". `taken` is a
 * lowercased citeKey set the caller materializes once (projection query) and
 * reuses for every row of a bulk import.
 */
function resolveCiteKey(input: AcademicLiteratureInput, taken: ReadonlySet<string>): string {
  const suggested = input.citeKey?.trim();
  return uniqueCiteKey(suggested || citeKeyBase(input), taken);
}

/** Fresh library entity: normalized DOI, verified=false, and a caller-supplied monotonic importedAt. */
function newLiteratureEntry(
  uid: string,
  projectId: string,
  input: AcademicLiteratureInput,
  citeKey: string,
  at: number,
): AcademicLiteratureEntry {
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

/**
 * Stable section key: slug, or a deterministic hash when slugKey strips a
 * pure-CJK title to "", so repeated saves of the same title keep hitting the same
 * section (upsert) instead of appending a new one per call.
 */
function sectionKeyFromTitle(title: string): string {
  const slug = slugKey(title);
  if (slug) return slug;
  let hash = 0;
  for (const ch of title) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return `s${hash.toString(36)}`;
}

/**
 * Disambiguates keys inside one document write: the first occurrence keeps the
 * base key, later collisions get -2, -3, ... up to a bounded counter. The
 * time-based fallback only triggers in pathological documents.
 */
function uniqueSectionKey(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/** Materializes a section input: trims/derives the key, registers it in the batch's taken-set, and defaults content/order. */
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

/** Canonical section order: order ascending with key as tie-break, returning a new array. */
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
 * MongoDB implementation of the four academic repositories — durable across
 * restarts and semantically identical to MemoryAcademicStore (same defaults, same
 * arity dispatch, same monotonic timestamps).
 *
 * Lifecycle: construct only through connect(), which pings the server and creates
 * the indexes idempotently; connect() returns null instead of throwing when the
 * URI is missing or the server is unreachable, so the composition root can fall
 * back to the memory store with an explicit boot warning. close() releases the
 * client and the instance must not be used afterwards.
 *
 * Tenancy: every filter carries uid (see the file docblock). Reads map documents
 * to fresh entities, so callers never hold a Mongo document (with its _id) and
 * cannot mutate stored state by accident.
 */
export class MongoAcademicStore
  implements
    AcademicProjectRepository,
    AcademicLiteratureRepository,
    AcademicDocumentRepository,
    AcademicEventRepository
{
  /** Monotonic fallbacks: two writes in the same millisecond still sort deterministically. */
  private lastImportedAt = 0;
  private lastEventAt = 0;

  private constructor(
    private readonly client: MongoClient,
    private readonly projects: Collection<ProjectDoc>,
    private readonly literature: Collection<LiteratureDoc>,
    private readonly documents: Collection<DocumentDoc>,
    private readonly events: Collection<EventDoc>,
  ) {}

  /**
   * Opens the client, verifies connectivity and creates the compound indexes the
   * queries rely on. Returns null (after closing the half-open client) when the
   * URI is unset or the ping fails — callers treat null as "use the memory store".
   * Index creation is idempotent, so repeated boots are cheap.
   */
  static async connect(): Promise<MongoAcademicStore | null> {
    const { uri, database, timeoutMs } = config.mongo;
    if (!uri) return null;
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: timeoutMs,
      connectTimeoutMS: timeoutMs,
    });
    try {
      await client.connect();
      await client.db("admin").command({ ping: 1 });
    } catch (err) {
      // Connectivity failure = no durable store: close the half-open client and let the
      // composition root degrade to MemoryAcademicStore (explicit warn; data is lost on restart).
      log.warn(`[MONGO] academic store connect failed: ${err instanceof Error ? err.message : err}`);
      await client.close().catch(() => undefined);
      return null;
    }
    const db = client.db(database);
    const projects = db.collection<ProjectDoc>(PROJECTS);
    const literature = db.collection<LiteratureDoc>(LITERATURE);
    const documents = db.collection<DocumentDoc>(DOCUMENTS);
    const events = db.collection<EventDoc>(EVENTS);
    // Index DDL is best-effort. A failure here must NOT downgrade to memory: the data is
    // already persisted, queries stay correct (just slower), so log loudly and keep Mongo.
    try {
      await Promise.all([
        // list(uid): project feed, newest-first by updatedAt.
        projects.createIndex({ uid: 1, updatedAt: -1 }),
        // list(uid, projectId): literature feed, newest-first by importedAt.
        literature.createIndex({ uid: 1, projectId: 1, importedAt: -1 }),
        // findByDoi: exact match on the normalized DOI.
        literature.createIndex({ uid: 1, projectId: 1, doi: 1 }),
        // add/addMany identity probe on the persisted dedupeKey. Deliberately NOT
        // unique: rows written before dedupeKey existed lack the field (which can
        // make a unique index fail to build on historical data), and two imports
        // of the same paper racing inside one agent turn would otherwise turn a
        // benign duplicate into a failed write. The agent serializes edits per
        // project/user, so the application-level probe keeps duplicates rare.
        literature.createIndex({ uid: 1, projectId: 1, dedupeKey: 1 }),
        // listDocuments: project documents, newest-first by updatedAt. Its
        // {uid, projectId} equality prefix also serves countDocuments().
        documents.createIndex({ uid: 1, projectId: 1, updatedAt: -1 }),
        // listEvents: event feed, newest-first with the limit applied in Mongo.
        events.createIndex({ uid: 1, projectId: 1, createdAt: -1 }),
      ]);
    } catch (err) {
      log.error(
        `[MONGO] academic index creation failed (queries stay correct but may be slower): ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
    log.info(`[MONGO] academic stores ready db=${database}`);
    return new MongoAcademicStore(client, projects, literature, documents, events);
  }

  /** Closes the underlying client; called once during graceful shutdown. */
  async close(): Promise<void> {
    await this.client.close();
  }

  // ---- projects -----------------------------------------------------------

  /** Creates a project and inserts it; returns the freshly built entity (no re-read needed). */
  async create(uid: string, input: AcademicProjectCreate): Promise<AcademicProject> {
    const project = newProject(uid, input, Date.now());
    await this.projects.insertOne(toProjectDoc(project));
    return project;
  }

  /**
   * The project/literature repositories share the method names list/get/remove.
   * Overloads keep a single object assignable to every interface; dispatch is by
   * arity: list(uid) = projects, list(uid, projectId) = literature. Events use a
   * distinct method name (listEvents) so a 2-arg call cannot silently resolve to
   * the literature list at runtime. The arity check is explicit (projectId
   * === undefined), not a truthiness test.
   *
   * Both branches are served by the indexes created in connect() — projects by
   * {uid, updatedAt}, literature by {uid, projectId, importedAt}. The extra
   * tie-break keys are applied after the index range scan (result sets are small).
   */
  async list(uid: string): Promise<AcademicProject[]>;
  async list(uid: string, projectId: string): Promise<AcademicLiteratureEntry[]>;
  async list(uid: string, projectId?: string): Promise<AcademicProject[] | AcademicLiteratureEntry[]> {
    return projectId === undefined ? await this.listProjects(uid) : await this.listLiterature(uid, projectId);
  }

  /**
   * Newest-first project events (explicit limit; default feed size when omitted).
   * The limit is sanitized (non-finite -> default, negative -> empty result) and a
   * zero cap short-circuits without querying Mongo. Ordering uses the
   * {uid, projectId, createdAt} index with _id as a deterministic tie-break.
   */
  async listEvents(uid: string, projectId: string, limit = DEFAULT_EVENT_LIMIT): Promise<AcademicEvent[]> {
    return this.listEventsInternal(uid, projectId, limit);
  }

  /**
   * Arity dispatch again: get(uid, projectId) resolves a project, get(uid,
   * projectId, ref) resolves a library entry by id or citeKey. Both filters carry
   * uid, so a foreign id simply matches nothing and returns null.
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
   * One atomic findOneAndUpdate: each patch field becomes a $set (root scalars,
   * "<field>.<stage>" point paths for stages/plans/advice), so there is no
   * read-modify-replace window in which a concurrent patch loses untouched
   * sibling fields. Returns the post-write entity (returnDocument "after") or
   * null when the project is missing or owned by another uid. upsert stays off,
   * so a foreign/unknown id can never create a row.
   */
  async update(
    uid: string,
    projectId: string,
    patch: AcademicProjectPatch,
  ): Promise<AcademicProject | null> {
    const updated = await this.projects.findOneAndUpdate(
      { _id: projectId, uid },
      { $set: projectPatchSet(patch, Date.now()) },
      { returnDocument: "after" },
    );
    return updated ? toProject(updated) : null;
  }

  /**
   * Arity dispatch: remove(uid, projectId) deletes a project, remove(uid,
   * projectId, ref) deletes a library entry by id or citeKey. Returns false when
   * nothing matched (unknown id, wrong uid, already gone); uid is always part of
   * the filter so foreign rows can never be deleted.
   */
  async remove(uid: string, projectId: string): Promise<boolean>;
  async remove(uid: string, projectId: string, ref: string): Promise<boolean>;
  async remove(uid: string, projectId: string, ref?: string): Promise<boolean> {
    return ref === undefined ? this.removeProject(uid, projectId) : this.removeLiterature(uid, projectId, ref);
  }

  // ---- literature ---------------------------------------------------------

  /**
   * Imports a paper. The identity probe is a single index hit on the persisted
   * dedupeKey (rows written before that field existed simply do not match); only
   * on a miss do we read the project's citeKeys (projection-only) to uniquify the
   * new citeKey, then insert. A repeated import returns the stored row untouched.
   */
  async add(
    uid: string,
    projectId: string,
    input: AcademicLiteratureInput,
  ): Promise<AcademicLiteratureAddResult> {
    const dedupeKey = literatureDedupeKey(input);
    const duplicate = await this.literature.findOne({ uid, projectId, dedupeKey });
    if (duplicate) return { entry: toLiterature(duplicate), duplicate: true };
    // Rows written before the dedupeKey field existed are invisible to that probe; the
    // indexed DOI still recognises them (title+year-only legacy rows need the backfill).
    const legacyDoi = normalizeDoi(input.doi);
    if (legacyDoi) {
      const legacy = await this.literature.findOne({ uid, projectId, doi: legacyDoi });
      if (legacy) return { entry: toLiterature(legacy), duplicate: true };
    }
    const entry = newLiteratureEntry(
      uid,
      projectId,
      input,
      resolveCiteKey(
        input,
        new Set((await this.listCiteKeys(uid, projectId)).map((key) => key.toLowerCase())),
      ),
      this.nextImportedAt(),
    );
    await this.literature.insertOne(toLiteratureDoc(entry));
    return { entry, duplicate: false };
  }

  /**
   * Bulk import: one $in probe covers the whole batch and the project's citeKeys
   * are read once (projection-only) for citeKey uniquification, so N papers cost
   * two queries instead of N library scans. A paper already in the library — or
   * seen earlier in this same batch — resolves to the first occurrence with
   * duplicate=true (the batch map is updated as entries are accepted); the rest
   * are written with a single insertMany. Results keep input order.
   */
  async addMany(
    uid: string,
    projectId: string,
    inputs: AcademicLiteratureInput[],
  ): Promise<AcademicLiteratureAddResult[]> {
    const results: AcademicLiteratureAddResult[] = [];
    if (inputs.length === 0) return results;
    const dedupeKeys = inputs.map((input) => literatureDedupeKey(input));
    const wanted = [...new Set(dedupeKeys)];
    // An $in filter on a missing field is a plain non-match (never an error), so
    // legacy rows without dedupeKey are simply "not seen yet", not a failure.
    const known = await this.literature
      .find({ uid, projectId, dedupeKey: { $in: wanted } })
      .toArray();
    const byKey = new Map<string, AcademicLiteratureEntry>();
    for (const doc of known) byKey.set(doc.dedupeKey, toLiterature(doc));
    // Legacy rows (pre-dedupeKey) are not matched by the $in probe above; probe the
    // indexed DOI so re-importing them still reports duplicate. Rows with neither a
    // dedupeKey nor a DOI require the one-off backfill documented in docs/academic-agent.md.
    const legacyDois = [...new Set(inputs.map((input) => normalizeDoi(input.doi)).filter(Boolean))];
    if (legacyDois.length > 0) {
      const legacyDocs = await this.literature
        .find({ uid, projectId, doi: { $in: legacyDois } })
        .toArray();
      for (const doc of legacyDocs) {
        const entry = toLiterature(doc);
        const computed = literatureDedupeKey(entry);
        if (!byKey.has(computed)) byKey.set(computed, entry);
      }
    }
    const citeKeys = new Set((await this.listCiteKeys(uid, projectId)).map((key) => key.toLowerCase()));
    const pending: AcademicLiteratureEntry[] = [];
    for (const [index, input] of inputs.entries()) {
      const dedupeKey = dedupeKeys[index];
      const duplicate = byKey.get(dedupeKey);
      if (duplicate) {
        results.push({ entry: structuredClone(duplicate), duplicate: true });
        continue;
      }
      const entry = newLiteratureEntry(
        uid,
        projectId,
        input,
        resolveCiteKey(input, citeKeys),
        this.nextImportedAt(),
      );
      // Register before moving on so a later item of this batch dedupes against it.
      citeKeys.add(entry.citeKey.toLowerCase());
      byKey.set(dedupeKey, entry);
      pending.push(entry);
      results.push({ entry, duplicate: false });
    }
    if (pending.length > 0) {
      // ordered:false so one rejected document cannot silently drop the rest of
      // the batch (ids are UUIDs, so duplicate-key aborts are not expected).
      await this.literature.insertMany(pending.map(toLiteratureDoc), { ordered: false });
    }
    return results;
  }

  /**
   * Number of entries in the project library, served by the {uid, projectId}
   * index prefix: a count projection that returns no documents/row bodies.
   */
  async count(uid: string, projectId: string): Promise<number> {
    return this.literature.countDocuments({ uid, projectId });
  }

  /**
   * Exact lookup on the normalized DOI, served by the {uid, projectId, doi} index.
   * An empty DOI returns null instead of matching DOI-less entries.
   */
  async findByDoi(uid: string, projectId: string, doi: string): Promise<AcademicLiteratureEntry | null> {
    const normalized = normalizeDoi(doi);
    if (!normalized) return null;
    const doc = await this.literature.findOne({ uid, projectId, doi: normalized });
    return doc ? toLiterature(doc) : null;
  }

  /**
   * Conditional flag update: $set verifiedAt when verifying, $unset when revoking
   * (so "present" always means true). The filter repeats id + uid + projectId, so
   * a foreign reference updates nothing and returns null.
   */
  async setVerified(
    uid: string,
    projectId: string,
    ref: string,
    verified: boolean,
  ): Promise<AcademicLiteratureEntry | null> {
    const doc = await this.findLiterature(uid, projectId, ref);
    if (!doc) return null;
    const at = Date.now();
    const updated = await this.literature.findOneAndUpdate(
      { _id: doc._id, uid, projectId },
      verified
        ? { $set: { verified: true, verifiedAt: at } }
        : { $set: { verified: false }, $unset: { verifiedAt: "" } },
      { returnDocument: "after" },
    );
    return updated ? toLiterature(updated) : null;
  }

  // ---- documents ----------------------------------------------------------

  /**
   * Creates a document and inserts it with its derived/sorted sections. Section
   * keys are deduplicated inside this batch with the same rules as the memory
   * store, so both backends produce identical section keys.
   */
  async createDocument(
    uid: string,
    projectId: string,
    input: { kind: AcademicDocumentKind; title: string; sections?: AcademicSectionInput[] },
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
      createdAt: at,
      updatedAt: at,
    };
    await this.documents.insertOne(toDocumentDoc(document));
    return document;
  }

  /**
   * Documents of one project, most recently updated first. The match and the
   * primary sort key are served by the {uid, projectId, updatedAt} index; the
   * createdAt/_id tie-breaks are applied after the index scan (a project holds
   * few documents).
   */
  async listDocuments(uid: string, projectId: string): Promise<AcademicDocument[]> {
    const docs = await this.documents
      .find({ uid, projectId }, { sort: { updatedAt: -1, createdAt: -1, _id: 1 } })
      .toArray();
    return docs.map(toDocument);
  }

  /**
   * Number of documents in the project, served by the {uid, projectId} prefix of
   * the documents index: a count projection that returns no row bodies.
   */
  async countDocuments(uid: string, projectId: string): Promise<number> {
    return this.documents.countDocuments({ uid, projectId });
  }

  /** Loads a document by id with uid in the filter; null when missing or foreign. */
  async getDocument(uid: string, documentId: string): Promise<AcademicDocument | null> {
    const doc = await this.documents.findOne({ _id: documentId, uid });
    return doc ? toDocument(doc) : null;
  }

  /**
   * Title-only update: read, then replaceOne with the uid-scoped filter. Returns
   * null when the document vanished in between (matchedCount 0).
   */
  async updateDocument(
    uid: string,
    documentId: string,
    patch: { title?: string },
  ): Promise<AcademicDocument | null> {
    const doc = await this.documents.findOne({ _id: documentId, uid });
    if (!doc) return null;
    const current = toDocument(doc);
    const next: AcademicDocument = {
      ...current,
      title: patch.title !== undefined ? patch.title : current.title,
      updatedAt: Date.now(),
    };
    const result = await this.documents.replaceOne({ _id: documentId, uid }, toDocumentDoc(next));
    return result.matchedCount > 0 ? next : null;
  }

  /**
   * Upserts a section inside the embedded array: read the document, merge by key
   * (stored content/order act as defaults when the input omits them), re-sort and
   * replace the whole document. Because sections are embedded, a section write is
   * one atomic document write — there is no separate collection to keep in sync.
   */
  async upsertSection(
    uid: string,
    documentId: string,
    input: AcademicSectionInput,
  ): Promise<AcademicDocument | null> {
    const doc = await this.documents.findOne({ _id: documentId, uid });
    if (!doc) return null;
    const current = toDocument(doc);
    const at = Date.now();
    const key = input.key?.trim() || sectionKeyFromTitle(input.title);
    const sections = current.sections.map((section) => ({ ...section }));
    const index = sections.findIndex((section) => section.key === key);
    if (index >= 0) {
      const existing = sections[index];
      sections[index] = {
        key: existing.key,
        title: input.title,
        content: input.content !== undefined ? input.content : existing.content,
        order: input.order !== undefined ? input.order : existing.order,
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
      ...current,
      sections: sortSections(sections),
      updatedAt: at,
    };
    const result = await this.documents.replaceOne({ _id: documentId, uid }, toDocumentDoc(next));
    return result.matchedCount > 0 ? next : null;
  }

  /**
   * Removes a section by key and replaces the document. An unknown key is a no-op
   * returning the current document without a write (no updatedAt bump, no spurious
   * update signal); null means the document is missing or foreign.
   */
  async deleteSection(
    uid: string,
    documentId: string,
    sectionKey: string,
  ): Promise<AcademicDocument | null> {
    const doc = await this.documents.findOne({ _id: documentId, uid });
    if (!doc) return null;
    const current = toDocument(doc);
    const sections = current.sections.filter((section) => section.key !== sectionKey);
    if (sections.length === current.sections.length) return current;
    const next: AcademicDocument = { ...current, sections, updatedAt: Date.now() };
    const result = await this.documents.replaceOne({ _id: documentId, uid }, toDocumentDoc(next));
    return result.matchedCount > 0 ? next : null;
  }

  // ---- events -------------------------------------------------------------

  /** Append-only insert; the payload is cloned and createdAt is monotonic within this process. */
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
      payload: structuredClone(payload),
      actor,
      createdAt: this.nextEventAt(),
    };
    await this.events.insertOne({
      _id: event.id,
      uid: event.uid,
      projectId: event.projectId,
      type: event.type,
      payload: event.payload,
      actor: event.actor,
      createdAt: event.createdAt,
    });
    return event;
  }

  // ---- implementations of the shared method names -------------------------

  /**
   * Served by the {uid, updatedAt} index; the createdAt/_id tie-breaks after the
   * index scan keep same-millisecond writes in a stable order.
   */
  private async listProjects(uid: string): Promise<AcademicProject[]> {
    const docs = await this.projects
      .find({ uid }, { sort: { updatedAt: -1, createdAt: -1, _id: 1 } })
      .toArray();
    return docs.map(toProject);
  }

  /** uid is part of the filter, so another tenant's id resolves to null. */
  private async getProject(uid: string, projectId: string): Promise<AcademicProject | null> {
    const doc = await this.projects.findOne({ _id: projectId, uid });
    return doc ? toProject(doc) : null;
  }

  /** deleteOne with uid in the filter; returns whether a document was removed. */
  private async removeProject(uid: string, projectId: string): Promise<boolean> {
    const result = await this.projects.deleteOne({ _id: projectId, uid });
    return result.deletedCount > 0;
  }

  /** Served by the {uid, projectId, importedAt} index; _id tie-breaks equal importedAt stamps. */
  private async listLiterature(
    uid: string,
    projectId: string,
  ): Promise<AcademicLiteratureEntry[]> {
    const docs = await this.literature
      .find({ uid, projectId }, { sort: { importedAt: -1, _id: 1 } })
      .toArray();
    return docs.map(toLiterature);
  }

  /** Resolves id-or-citeKey and maps the document, so callers never see _id. */
  private async getLiterature(
    uid: string,
    projectId: string,
    ref: string,
  ): Promise<AcademicLiteratureEntry | null> {
    const doc = await this.findLiterature(uid, projectId, ref);
    return doc ? toLiterature(doc) : null;
  }

  /** Resolves id-or-citeKey first (so citeKey deletes work), then deletes by _id + uid. */
  private async removeLiterature(uid: string, projectId: string, ref: string): Promise<boolean> {
    const doc = await this.findLiterature(uid, projectId, ref);
    if (!doc) return false;
    const result = await this.literature.deleteOne({ _id: doc._id, uid, projectId });
    return result.deletedCount > 0;
  }

  /**
   * Applies the limit inside Mongo (not after fetching) so a feed request cannot
   * pull the whole event log; a zero cap short-circuits to an empty array.
   */
  private async listEventsInternal(
    uid: string,
    projectId: string,
    limit: number,
  ): Promise<AcademicEvent[]> {
    const capped = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : DEFAULT_EVENT_LIMIT;
    if (capped === 0) return [];
    const docs = await this.events
      .find({ uid, projectId }, { sort: { createdAt: -1, _id: 1 }, limit: capped })
      .toArray();
    return docs.map(toEvent);
  }

  // ---- internals ----------------------------------------------------------

  /**
   * Resolves an entry id or citeKey (citeKeys are compared case-insensitively).
   * The _id path is an index hit. The citeKey path uses the {uid, projectId} index
   * prefix and compares with an "en"/strength-2 collation (case- and
   * accent-insensitive), matching the memory store's toLowerCase comparison for the
   * ASCII citeKeys this domain generates.
   */
  private async findLiterature(
    uid: string,
    projectId: string,
    ref: string,
  ): Promise<LiteratureDoc | null> {
    const byId = await this.literature.findOne({ _id: ref, uid, projectId });
    if (byId) return byId;
    return this.literature.findOne(
      { uid, projectId, citeKey: ref },
      { collation: { locale: "en", strength: 2 } },
    );
  }

  /**
   * citeKeys of one project (projection only), used to uniquify a new citeKey
   * without loading row bodies — the previous implementation fetched whole docs
   * for the same purpose.
   */
  private async listCiteKeys(uid: string, projectId: string): Promise<string[]> {
    const docs = await this.literature
      .find({ uid, projectId }, { projection: { citeKey: 1 } })
      .toArray();
    return docs.map((doc) => doc.citeKey);
  }

  /** importedAt source: strictly increasing (+1ms fallback) so same-millisecond imports keep a deterministic newest-first order. */
  private nextImportedAt(): number {
    const now = Date.now();
    this.lastImportedAt = now > this.lastImportedAt ? now : this.lastImportedAt + 1;
    return this.lastImportedAt;
  }

  /** createdAt source: strictly increasing (+1ms fallback) so same-millisecond events sort deterministically ({createdAt:-1, _id:1}). */
  private nextEventAt(): number {
    const now = Date.now();
    this.lastEventAt = now > this.lastEventAt ? now : this.lastEventAt + 1;
    return this.lastEventAt;
  }
}
