/**
 * MongoDB adapter for the academic execution-evidence repository (durable
 * counterpart of repository/memory/academic-evidence.ts).
 *
 * Storage: the app-ts-owned database (config.mongo.database, i.e. mind_base_ts).
 * Datasets and runs share ONE collection (academic_runs) discriminated by the
 * persisted kind field, evidence rows are append-only metadata
 * records with the same tenancy/ordering needs, so one collection keeps the
 * "recent evidence" queries and the index set small.
 *
 * Lifecycle: construct only through connect(), which pings the server and creates
 * the compound indexes idempotently; connect() returns null instead of throwing
 * when the URI is missing or the server is unreachable, so the composition root
 * falls back to the memory store with an explicit boot warning. close() releases
 * the client and the instance must not be used afterwards.
 *
 * Tenancy: every filter carries uid AND projectId — a guessed dataset/run id from
 * another tenant or project matches nothing and returns null.
 */
import { MongoClient, type Collection, type Document as MongoDoc } from "mongodb";
import { randomUUID } from "node:crypto";
import { config } from "../../config/index.js";
import { createLogger } from "../../logger.js";
import {
  buildAcademicDataset,
  buildAcademicRun,
  runListWindow,
  type AcademicDataset,
  type AcademicDatasetInput,
  type AcademicEvidenceFile,
  type AcademicEvidenceRepository,
  type AcademicRun,
  type AcademicRunInput,
  type AcademicRunListOptions,
  type AcademicRunStatus,
} from "../academic-evidence.js";

const log = createLogger("MONGO");

/** Single collection holding both evidence kinds (discriminated by kind). */
const COLLECTION = "academic_runs";
const KIND_DATASET = "dataset";
const KIND_RUN = "run";

/**
 * Stored evidence row. Dataset and run fields are disjoint subsets of this shape;
 * the kind discriminator decides which mapper applies. script/previews/artifacts
 * are already bounded by the contract builders before they reach this type.
 */
interface EvidenceDoc extends MongoDoc {
  _id: string;
  uid: string;
  projectId: string;
  kind: "dataset" | "run";
  createdAt: number;
  name: string;
  // dataset fields
  description?: string;
  source?: string;
  files?: AcademicEvidenceFile[];
  // run fields
  datasetId?: string;
  script?: string;
  scriptSha256?: string;
  language?: string;
  executionId?: string;
  status?: AcademicRunStatus;
  exitCode?: number;
  stdoutPreview?: string;
  stderrPreview?: string;
  artifacts?: AcademicEvidenceFile[];
  cpuMillis?: number;
  startedAt?: number;
  finishedAt?: number;
}

/** Maps a stored dataset document to the entity (drops kind/_id noise, defaults files). */
function toDataset(doc: EvidenceDoc): AcademicDataset {
  return {
    id: doc._id,
    uid: doc.uid,
    projectId: doc.projectId,
    name: doc.name,
    ...(doc.description !== undefined ? { description: doc.description } : {}),
    source: doc.source ?? "manual",
    files: doc.files ?? [],
    createdAt: doc.createdAt,
  };
}

/** Maps a stored run document to the entity (defaults status/artifacts for legacy rows). */
function toRun(doc: EvidenceDoc): AcademicRun {
  return {
    id: doc._id,
    uid: doc.uid,
    projectId: doc.projectId,
    ...(doc.datasetId !== undefined ? { datasetId: doc.datasetId } : {}),
    name: doc.name,
    ...(doc.script !== undefined ? { script: doc.script } : {}),
    ...(doc.scriptSha256 !== undefined ? { scriptSha256: doc.scriptSha256 } : {}),
    language: doc.language ?? "",
    ...(doc.executionId !== undefined ? { executionId: doc.executionId } : {}),
    status: doc.status ?? "recorded",
    ...(doc.exitCode !== undefined ? { exitCode: doc.exitCode } : {}),
    ...(doc.stdoutPreview !== undefined ? { stdoutPreview: doc.stdoutPreview } : {}),
    ...(doc.stderrPreview !== undefined ? { stderrPreview: doc.stderrPreview } : {}),
    artifacts: doc.artifacts ?? [],
    ...(doc.cpuMillis !== undefined ? { cpuMillis: doc.cpuMillis } : {}),
    ...(doc.startedAt !== undefined ? { startedAt: doc.startedAt } : {}),
    ...(doc.finishedAt !== undefined ? { finishedAt: doc.finishedAt } : {}),
    createdAt: doc.createdAt,
  };
}

/** Maps a dataset entity to its stored document (kind discriminator included). */
function toDatasetDoc(dataset: AcademicDataset): EvidenceDoc {
  return {
    _id: dataset.id,
    uid: dataset.uid,
    projectId: dataset.projectId,
    kind: KIND_DATASET,
    createdAt: dataset.createdAt,
    name: dataset.name,
    ...(dataset.description !== undefined ? { description: dataset.description } : {}),
    source: dataset.source,
    files: dataset.files,
  };
}

/** Maps a run entity to its stored document (kind discriminator included). */
function toRunDoc(run: AcademicRun): EvidenceDoc {
  return {
    _id: run.id,
    uid: run.uid,
    projectId: run.projectId,
    kind: KIND_RUN,
    createdAt: run.createdAt,
    name: run.name,
    ...(run.datasetId !== undefined ? { datasetId: run.datasetId } : {}),
    ...(run.script !== undefined ? { script: run.script } : {}),
    ...(run.scriptSha256 !== undefined ? { scriptSha256: run.scriptSha256 } : {}),
    language: run.language,
    ...(run.executionId !== undefined ? { executionId: run.executionId } : {}),
    status: run.status,
    ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
    ...(run.stdoutPreview !== undefined ? { stdoutPreview: run.stdoutPreview } : {}),
    ...(run.stderrPreview !== undefined ? { stderrPreview: run.stderrPreview } : {}),
    artifacts: run.artifacts,
    ...(run.cpuMillis !== undefined ? { cpuMillis: run.cpuMillis } : {}),
    ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
    ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
  };
}

/**
 * MongoDB implementation of the evidence repository. Same contract semantics as
 * MemoryAcademicEvidenceStore: builder-sanitized writes, uid+project scoped reads,
 * newest-first lists.
 */
export class MongoAcademicEvidenceStore implements AcademicEvidenceRepository {
  /** Monotonic fallback: same-millisecond writes still sort deterministically. */
  private lastCreatedAt = 0;

  private constructor(
    private readonly client: MongoClient,
    private readonly collection: Collection<EvidenceDoc>,
  ) {}

  /**
   * Opens the client, verifies connectivity and creates the compound indexes the
   * queries rely on. Returns null (after closing the half-open client) when the
   * URI is unset or the ping fails; callers treat null as "use the memory store".
   */
  static async connect(): Promise<MongoAcademicEvidenceStore | null> {
    const { uri, database, timeoutMs } = config.mongo;
    if (!uri) return null;
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: timeoutMs,
      connectTimeoutMS: timeoutMs,
    });
    try {
      await client.connect();
      await client.db("admin").command({ ping: 1 });
      const collection = client.db(database).collection<EvidenceDoc>(COLLECTION);
      await Promise.all([
        // Newest-first evidence feed of one project (datasets + runs interleaved).
        collection.createIndex({ uid: 1, projectId: 1, createdAt: -1 }),
        // Kind filter for listDatasets/listRuns inside one project.
        collection.createIndex({ uid: 1, projectId: 1, kind: 1 }),
      ]);
      log.info(`[MONGO] academic evidence store ready db=${database}`);
      return new MongoAcademicEvidenceStore(client, collection);
    } catch (err) {
      log.warn(`[MONGO] academic evidence store connect failed: ${err instanceof Error ? err.message : err}`);
      await client.close().catch(() => undefined);
      return null;
    }
  }

  /** Closes the underlying client; called once during graceful shutdown. */
  async close(): Promise<void> {
    await this.client.close();
  }

  /** Register a dataset for the project; inserts the builder-sanitized document. */
  async addDataset(uid: string, projectId: string, input: AcademicDatasetInput): Promise<AcademicDataset> {
    const dataset = buildAcademicDataset({
      id: randomUUID(),
      uid,
      projectId,
      at: this.nextCreatedAt(),
      dataset: input,
    });
    await this.collection.insertOne(toDatasetDoc(dataset));
    return dataset;
  }

  /** Datasets of one project, newest first; [] for unknown uid/project. */
  async listDatasets(uid: string, projectId: string): Promise<AcademicDataset[]> {
    const docs = await this.collection
      .find(
        { uid, projectId, kind: KIND_DATASET },
        { sort: { createdAt: -1, _id: 1 } },
      )
      .toArray();
    return docs.map(toDataset);
  }

  /** Append a run record; script/previews/artifacts were bounded by the builder. */
  async recordRun(uid: string, projectId: string, input: AcademicRunInput): Promise<AcademicRun> {
    const run = buildAcademicRun({
      id: randomUUID(),
      uid,
      projectId,
      at: this.nextCreatedAt(),
      run: input,
    });
    await this.collection.insertOne(toRunDoc(run));
    return run;
  }

  /** Newest-first run page; limit/offset are clamped by runListWindow. */
  async listRuns(
    uid: string,
    projectId: string,
    options: AcademicRunListOptions = {},
  ): Promise<AcademicRun[]> {
    const { limit, offset } = runListWindow(options);
    const docs = await this.collection
      .find(
        { uid, projectId, kind: KIND_RUN },
        { sort: { createdAt: -1, _id: 1 }, skip: offset, limit },
      )
      .toArray();
    return docs.map(toRun);
  }

  /** Run by id, scoped by uid AND projectId; null when missing or foreign. */
  async getRun(uid: string, projectId: string, runId: string): Promise<AcademicRun | null> {
    const doc = await this.collection.findOne({ _id: runId, uid, projectId, kind: KIND_RUN });
    return doc ? toRun(doc) : null;
  }

  /** createdAt source: strictly increasing (+1ms fallback) so list order is stable. */
  private nextCreatedAt(): number {
    const now = Date.now();
    this.lastCreatedAt = now > this.lastCreatedAt ? now : this.lastCreatedAt + 1;
    return this.lastCreatedAt;
  }
}
