/**
 * MikroORM implementation of the academic evidence repository.
 *
 * Contract semantics are identical to the direct-driver adapter:
 *  - builders sanitize every persisted field (same pure helpers);
 *  - every read is scoped by uid AND projectId;
 *  - lists are newest-first with a monotonic createdAt fallback.
 *
 * Each operation forks a fresh EntityManager: repositories are singletons while
 * MikroORM's identity map is request-scoped, and Mongo standalone cannot use
 * implicit transactions.
 */
import type { MikroORM } from "@mikro-orm/mongodb";
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
} from "../../academic-evidence.js";
import { getAcademicEvidenceOrm } from "./orm.js";
import type { AcademicEvidenceRecordEntity } from "./entities.js";

const ENTITY = "AcademicEvidenceRecord";
const KIND_DATASET = "dataset";
const KIND_RUN = "run";

type EntityName = typeof ENTITY;

export class MikroAcademicEvidenceStore implements AcademicEvidenceRepository {
  /** Monotonic fallback: same-millisecond writes still sort deterministically. */
  private lastCreatedAt = 0;

  private constructor(private readonly orm: MikroORM) {}

  /** Connects through the shared MikroORM instance; null when Mongo is unavailable. */
  static async connect(): Promise<MikroAcademicEvidenceStore | null> {
    const orm = await getAcademicEvidenceOrm();
    return orm ? new MikroAcademicEvidenceStore(orm) : null;
  }

  /** Closes the shared ORM; called once from the composition root. */
  async close(): Promise<void> {
    await this.orm.close(true);
  }

  async addDataset(uid: string, projectId: string, input: AcademicDatasetInput): Promise<AcademicDataset> {
    const dataset = buildAcademicDataset({
      id: randomUUID(),
      uid,
      projectId,
      at: this.nextCreatedAt(),
      dataset: input,
    });
    const em = this.orm.em.fork();
    const record = em.create<AcademicEvidenceRecordEntity>(ENTITY as EntityName as never, {
      ...dataset,
      kind: KIND_DATASET,
      files: dataset.files,
    } as AcademicEvidenceRecordEntity);
    em.persist(record);
    await em.flush();
    return dataset;
  }

  async listDatasets(uid: string, projectId: string): Promise<AcademicDataset[]> {
    const em = this.orm.em.fork();
    const records = await em.find<AcademicEvidenceRecordEntity>(
      ENTITY as EntityName as never,
      { uid, projectId, kind: KIND_DATASET },
      { orderBy: { createdAt: "desc", id: "asc" } },
    );
    return records.map(toDataset);
  }

  async recordRun(uid: string, projectId: string, input: AcademicRunInput): Promise<AcademicRun> {
    const run = buildAcademicRun({
      id: randomUUID(),
      uid,
      projectId,
      at: this.nextCreatedAt(),
      run: input,
    });
    const em = this.orm.em.fork();
    const record = em.create<AcademicEvidenceRecordEntity>(ENTITY as EntityName as never, {
      ...run,
      kind: KIND_RUN,
      artifacts: run.artifacts,
    } as AcademicEvidenceRecordEntity);
    em.persist(record);
    await em.flush();
    return run;
  }

  async listRuns(uid: string, projectId: string, options: AcademicRunListOptions = {}): Promise<AcademicRun[]> {
    const { limit, offset } = runListWindow(options);
    const em = this.orm.em.fork();
    const records = await em.find<AcademicEvidenceRecordEntity>(
      ENTITY as EntityName as never,
      { uid, projectId, kind: KIND_RUN },
      { orderBy: { createdAt: "desc", id: "asc" }, limit, offset },
    );
    return records.map(toRun);
  }

  async getRun(uid: string, projectId: string, runId: string): Promise<AcademicRun | null> {
    const em = this.orm.em.fork();
    const record = await em.findOne<AcademicEvidenceRecordEntity>(ENTITY as EntityName as never, {
      id: runId,
      uid,
      projectId,
      kind: KIND_RUN,
    });
    return record ? toRun(record) : null;
  }

  /** createdAt source: strictly increasing (+1ms fallback) so list order is stable. */
  private nextCreatedAt(): number {
    const now = Date.now();
    this.lastCreatedAt = now > this.lastCreatedAt ? now : this.lastCreatedAt + 1;
    return this.lastCreatedAt;
  }
}

/** Maps a stored dataset record to the contract entity. */
function toDataset(record: AcademicEvidenceRecordEntity): AcademicDataset {
  return {
    id: record.id,
    uid: record.uid,
    projectId: record.projectId,
    name: record.name,
    ...(record.description !== undefined ? { description: record.description } : {}),
    source: record.source ?? "manual",
    files: record.files ?? [],
    createdAt: record.createdAt,
  };
}

/** Maps a stored run record to the contract entity (legacy defaults preserved). */
function toRun(record: AcademicEvidenceRecordEntity): AcademicRun {
  return {
    id: record.id,
    uid: record.uid,
    projectId: record.projectId,
    ...(record.datasetId !== undefined ? { datasetId: record.datasetId } : {}),
    name: record.name,
    ...(record.script !== undefined ? { script: record.script } : {}),
    ...(record.scriptSha256 !== undefined ? { scriptSha256: record.scriptSha256 } : {}),
    language: record.language ?? "",
    ...(record.executionId !== undefined ? { executionId: record.executionId } : {}),
    status: record.status ?? "recorded",
    ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
    ...(record.stdoutPreview !== undefined ? { stdoutPreview: record.stdoutPreview } : {}),
    ...(record.stderrPreview !== undefined ? { stderrPreview: record.stderrPreview } : {}),
    artifacts: record.artifacts ?? [],
    ...(record.cpuMillis !== undefined ? { cpuMillis: record.cpuMillis } : {}),
    ...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
    ...(record.finishedAt !== undefined ? { finishedAt: record.finishedAt } : {}),
    createdAt: record.createdAt,
  };
}
