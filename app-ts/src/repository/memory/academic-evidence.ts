/**
 * In-process implementation of the academic execution-evidence repository.
 *
 * Layer: repository implementation behind repository/academic-evidence.ts; only
 * the composition root constructs it, as the test double and the degraded-boot
 * fallback when MongoDB is unreachable. State is process-local and non-durable.
 *
 * Invariants:
 *  - every lookup is uid+project scoped, so a guessed dataset/run id never
 *    crosses tenants or projects;
 *  - reads return deep copies (structuredClone) and writes store the sanitized
 *    builder output, so caller-owned objects never alias stored state;
 *  - createdAt is monotonic within the process, which keeps the newest-first
 *    list ordering deterministic for writes inside the same millisecond.
 */
import { randomUUID } from "node:crypto";
import {
  buildAcademicDataset,
  buildAcademicRun,
  runListWindow,
  type AcademicDataset,
  type AcademicDatasetInput,
  type AcademicEvidenceRepository,
  type AcademicRun,
  type AcademicRunInput,
  type AcademicRunListOptions,
} from "../academic-evidence.js";

/** Defensive deep copy used on every read so callers cannot mutate stored rows. */
function copy<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Single in-memory object implementing the evidence repository. Datasets and runs
 * are kept in separate maps (ids are global UUIDs) and every query filters by
 * uid + projectId, mirroring the Mongo adapter's compound indexes.
 */
export class MemoryAcademicEvidenceStore implements AcademicEvidenceRepository {
  private readonly datasets = new Map<string, AcademicDataset>();
  private readonly runs = new Map<string, AcademicRun>();
  /** Monotonic fallback: same-millisecond writes still sort deterministically. */
  private lastCreatedAt = 0;

  /** Register a dataset for the project and return a deep copy. */
  async addDataset(uid: string, projectId: string, input: AcademicDatasetInput): Promise<AcademicDataset> {
    const dataset = buildAcademicDataset({
      id: randomUUID(),
      uid,
      projectId,
      at: this.tick(),
      dataset: input,
    });
    this.datasets.set(dataset.id, dataset);
    return copy(dataset);
  }

  /** Datasets of one project, newest first; [] for unknown uid/project. */
  async listDatasets(uid: string, projectId: string): Promise<AcademicDataset[]> {
    return [...this.datasets.values()]
      .filter((dataset) => dataset.uid === uid && dataset.projectId === projectId)
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
      .map(copy);
  }

  /** Append a run record (script/previews/artifacts are bounded by the builder). */
  async recordRun(uid: string, projectId: string, input: AcademicRunInput): Promise<AcademicRun> {
    const run = buildAcademicRun({
      id: randomUUID(),
      uid,
      projectId,
      at: this.tick(),
      run: input,
    });
    this.runs.set(run.id, run);
    return copy(run);
  }

  /** Newest-first run page; limit/offset are clamped by runListWindow. */
  async listRuns(
    uid: string,
    projectId: string,
    options: AcademicRunListOptions = {},
  ): Promise<AcademicRun[]> {
    const { limit, offset } = runListWindow(options);
    return [...this.runs.values()]
      .filter((run) => run.uid === uid && run.projectId === projectId)
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
      .slice(offset, offset + limit)
      .map(copy);
  }

  /** Run by id, scoped by uid AND projectId; null when missing or foreign. */
  async getRun(uid: string, projectId: string, runId: string): Promise<AcademicRun | null> {
    const run = this.runs.get(runId);
    return run && run.uid === uid && run.projectId === projectId ? copy(run) : null;
  }

  /** createdAt source: strictly increasing (+1ms fallback) so list order is stable. */
  private tick(): number {
    const now = Date.now();
    this.lastCreatedAt = now > this.lastCreatedAt ? now : this.lastCreatedAt + 1;
    return this.lastCreatedAt;
  }
}
