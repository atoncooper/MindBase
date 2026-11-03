/**
 * Academic execution-evidence contracts: datasets that experiments read from and
 * recorded experiment runs (desktop academic_evidence parity).
 *
 * Layer rules (app-ts/AGENTS.md §3):
 *  - this file = contract + pure helpers, NO I/O;
 *  - memory implementation: repository/memory/academic-evidence.ts
 *  - Mongo adapter:        repository/mongo/academic-evidence.ts
 *  - tools import ONLY this contract, never a concrete adapter.
 *
 * Trust boundary: the LLM-facing tool truncates and hashes what it forwards, and
 * the builders below are the single place that bounds and sanitizes persisted
 * fields (script <= ACADEMIC_MAX_SCRIPT_CHARS with a full-text sha256, output
 * previews <= ACADEMIC_MAX_PREVIEW_CHARS, files/artifacts metadata only). Both
 * stores call the builders, so memory and Mongo persist identical documents.
 *
 * Multi-tenant: every read/write takes uid first and the project owns its
 * evidence, so a dataset/run id from another tenant resolves to null exactly like
 * a missing row (never a cross-tenant leak, never an update on a foreign row).
 */
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Datasets
// ---------------------------------------------------------------------------

/**
 * One dataset file descriptor. Metadata only — file content lives outside app-ts
 * (MinIO / sandbox workspace) and is never persisted here. sizeBytes/sha256 are
 * optional because imports may only know the name/URL.
 */
export interface AcademicEvidenceFile {
  name: string;
  sizeBytes?: number;
  /** lowercase hex sha256 of the file content when known */
  sha256?: string;
  /** download/preview URL when the object store exposes one */
  url?: string;
}

/**
 * A dataset registered for a project: the input side of an experiment. The
 * source is free-form ("manual", "upload", "sandbox", "url", ...) and stored
 * verbatim so imports stay traceable without a schema migration.
 */
export interface AcademicDataset {
  id: string;
  uid: string;
  projectId: string;
  name: string;
  description?: string;
  /** where the dataset came from; defaults to "manual" for agent-registered sets */
  source: string;
  files: AcademicEvidenceFile[];
  createdAt: number;
}

/** Add payload; name is required, description/source/files are optional. */
export interface AcademicDatasetInput {
  name: string;
  description?: string;
  /** defaults to "manual" */
  source?: string;
  files?: AcademicEvidenceFile[];
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/**
 * Terminal state of a recorded run. "recorded" means an execution was logged
 * without a definitive exit status (still useful evidence, never claimed as
 * success); the tool layer infers succeeded/failed from exitCode when omitted.
 */
export const ACADEMIC_RUN_STATUSES = ["succeeded", "failed", "timed_out", "recorded"] as const;
/** One run status (see ACADEMIC_RUN_STATUSES). */
export type AcademicRunStatus = (typeof ACADEMIC_RUN_STATUSES)[number];

/** Chinese UI labels per run status — product strings, keep them Chinese. */
export const ACADEMIC_RUN_STATUS_LABELS: Record<AcademicRunStatus, string> = {
  succeeded: "成功",
  failed: "失败",
  timed_out: "超时",
  recorded: "已记录",
};

/**
 * One recorded experiment run. The script body holds at most
 * ACADEMIC_MAX_SCRIPT_CHARS characters (the full text is identified by
 * scriptSha256), previews are bounded, and artifacts are metadata only — the
 * stores never hold execution output bodies beyond these bounded fields.
 */
export interface AcademicRun {
  id: string;
  uid: string;
  projectId: string;
  /** dataset this run consumed, when declared */
  datasetId?: string;
  name: string;
  /** bounded script body (<= ACADEMIC_MAX_SCRIPT_CHARS) */
  script?: string;
  /** sha256 of the FULL script text, even when the stored body is truncated */
  scriptSha256?: string;
  language: string;
  /** app-sandbox execution id when the run executed through the control plane */
  executionId?: string;
  status: AcademicRunStatus;
  exitCode?: number;
  /** bounded stdout/stderr previews (<= ACADEMIC_MAX_PREVIEW_CHARS) */
  stdoutPreview?: string;
  stderrPreview?: string;
  artifacts: AcademicEvidenceFile[];
  cpuMillis?: number;
  startedAt?: number;
  finishedAt?: number;
  createdAt: number;
}

/**
 * Record payload. The tool fills status/exitCode/duration from run_code output;
 * script is hashed and truncated by buildAcademicRun, so callers pass the raw
 * text and never compute scriptSha256 themselves.
 */
export interface AcademicRunInput {
  name: string;
  language: string;
  datasetId?: string;
  /** raw script text; hashed in full and stored truncated */
  script?: string;
  executionId?: string;
  /** defaults to "recorded" */
  status?: AcademicRunStatus;
  exitCode?: number;
  stdoutPreview?: string;
  stderrPreview?: string;
  artifacts?: AcademicEvidenceFile[];
  cpuMillis?: number;
  startedAt?: number;
  finishedAt?: number;
}

/** Paging window for listRuns (limit is clamped to the exported bounds). */
export interface AcademicRunListOptions {
  limit?: number;
  offset?: number;
}

/** Number of runs listRuns returns when no limit is given. */
export const ACADEMIC_RUN_LIST_DEFAULT_LIMIT = 20;
/** Upper bound for a single listRuns page (keeps tool output bounded). */
export const ACADEMIC_RUN_LIST_MAX_LIMIT = 100;

/**
 * Evidence repository contract. Datasets and runs share one record family; both
 * are uid+project scoped. Implementations store the sanitized builder output,
 * never raw caller objects, and list newest-first.
 */
export interface AcademicEvidenceRepository {
  addDataset(uid: string, projectId: string, input: AcademicDatasetInput): Promise<AcademicDataset>;
  listDatasets(uid: string, projectId: string): Promise<AcademicDataset[]>;
  recordRun(uid: string, projectId: string, input: AcademicRunInput): Promise<AcademicRun>;
  /** Newest-first run page; limit/offset are normalized by runListWindow. */
  listRuns(uid: string, projectId: string, options?: AcademicRunListOptions): Promise<AcademicRun[]>;
  /** Run by id, scoped by uid AND projectId; null when missing or foreign. */
  getRun(uid: string, projectId: string, runId: string): Promise<AcademicRun | null>;
}

// ---------------------------------------------------------------------------
// Bounds + tool-facing constants
// ---------------------------------------------------------------------------

/** Script body stored per run (the full text is hashed, not stored). */
export const ACADEMIC_MAX_SCRIPT_CHARS = 20_000;
/** stdout/stderr preview stored per run (sandbox previews may be longer). */
export const ACADEMIC_MAX_PREVIEW_CHARS = 4_000;
/** SSE artifact kind emitted by the academic_evidence tool. */
export const ACADEMIC_EVIDENCE_ARTIFACT_KIND = "academic_evidence";

// ---------------------------------------------------------------------------
// Pure helpers (shared by every implementation so semantics cannot drift)
// ---------------------------------------------------------------------------

/** Lowercase hex sha256 of a UTF-8 string (script digests, file identity). */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Bound an execution output preview. Blank input is treated as "no preview" so
 * the persisted document does not carry empty strings; longer input is sliced
 * (not ellipsized) so the stored value stays a truthful prefix.
 */
export function clipPreview(text: string | undefined, maxChars: number = ACADEMIC_MAX_PREVIEW_CHARS): string | undefined {
  if (text === undefined || !text.trim()) return undefined;
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

/** Persisted script identity: truncated body + sha256 of the ORIGINAL text. */
export interface AcademicScriptRecord {
  script?: string;
  scriptSha256?: string;
}

/**
 * Hash and bound a script in one place: a blank script stores nothing, a script
 * longer than ACADEMIC_MAX_SCRIPT_CHARS is stored as its first N characters while
 * scriptSha256 still digests the complete text (so a re-execution can be checked).
 */
export function scriptRecord(script: string | undefined): AcademicScriptRecord {
  if (script === undefined || !script.trim()) return {};
  return {
    script: script.length > ACADEMIC_MAX_SCRIPT_CHARS ? script.slice(0, ACADEMIC_MAX_SCRIPT_CHARS) : script,
    scriptSha256: sha256Hex(script),
  };
}

/**
 * Copies file/artifact metadata, dropping blank names and normalizing optional
 * fields (non-negative integer bytes, lowercase hex sha). Unknown keys are not
 * copied, so a caller cannot smuggle content through an extra property.
 */
export function normalizeEvidenceFiles(files: readonly AcademicEvidenceFile[] | undefined): AcademicEvidenceFile[] {
  const out: AcademicEvidenceFile[] = [];
  for (const file of files ?? []) {
    const name = (file.name ?? "").trim();
    if (!name) continue;
    const item: AcademicEvidenceFile = { name };
    if (file.sizeBytes !== undefined && Number.isFinite(file.sizeBytes) && file.sizeBytes >= 0) {
      item.sizeBytes = Math.floor(file.sizeBytes);
    }
    const sha = file.sha256?.trim().toLowerCase();
    if (sha) item.sha256 = sha;
    const url = file.url?.trim();
    if (url) item.url = url;
    out.push(item);
  }
  return out;
}

/** Normalize a listRuns window: default limit, clamped to [1, MAX], offset >= 0. */
export function runListWindow(options: AcademicRunListOptions = {}): { limit: number; offset: number } {
  const limit =
    options.limit === undefined || !Number.isFinite(options.limit)
      ? ACADEMIC_RUN_LIST_DEFAULT_LIMIT
      : Math.min(Math.max(Math.trunc(options.limit), 1), ACADEMIC_RUN_LIST_MAX_LIMIT);
  const offset =
    options.offset === undefined || !Number.isFinite(options.offset)
      ? 0
      : Math.max(Math.trunc(options.offset), 0);
  return { limit, offset };
}

/** Build a persisted dataset: trimmed/required name, default source, sanitized files. */
export function buildAcademicDataset(input: {
  id: string;
  uid: string;
  projectId: string;
  at: number;
  dataset: AcademicDatasetInput;
}): AcademicDataset {
  const { id, uid, projectId, at, dataset } = input;
  const description = dataset.description?.trim();
  const source = dataset.source?.trim();
  return {
    id,
    uid,
    projectId,
    name: dataset.name.trim(),
    ...(description ? { description } : {}),
    source: source || "manual",
    files: normalizeEvidenceFiles(dataset.files),
    createdAt: at,
  };
}

/**
 * Build a persisted run. This is the single place bounding script/preview/artifact
 * data: script body <= ACADEMIC_MAX_SCRIPT_CHARS (hash covers the full text),
 * previews <= ACADEMIC_MAX_PREVIEW_CHARS, artifacts metadata only. Optional fields
 * are omitted rather than set to undefined so the Mongo document stays compact.
 */
export function buildAcademicRun(input: {
  id: string;
  uid: string;
  projectId: string;
  at: number;
  run: AcademicRunInput;
}): AcademicRun {
  const { id, uid, projectId, at, run } = input;
  const script = scriptRecord(run.script);
  const stdoutPreview = clipPreview(run.stdoutPreview);
  const stderrPreview = clipPreview(run.stderrPreview);
  const datasetId = run.datasetId?.trim();
  const executionId = run.executionId?.trim();
  const exitCode =
    run.exitCode !== undefined && Number.isFinite(run.exitCode) ? Math.trunc(run.exitCode) : undefined;
  const cpuMillis =
    run.cpuMillis !== undefined && Number.isFinite(run.cpuMillis) && run.cpuMillis >= 0
      ? Math.floor(run.cpuMillis)
      : undefined;
  return {
    id,
    uid,
    projectId,
    ...(datasetId ? { datasetId } : {}),
    name: run.name.trim(),
    ...script,
    language: run.language.trim(),
    ...(executionId ? { executionId } : {}),
    status: run.status ?? "recorded",
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(stdoutPreview !== undefined ? { stdoutPreview } : {}),
    ...(stderrPreview !== undefined ? { stderrPreview } : {}),
    artifacts: normalizeEvidenceFiles(run.artifacts),
    ...(cpuMillis !== undefined ? { cpuMillis } : {}),
    ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
    ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
    createdAt: at,
  };
}
