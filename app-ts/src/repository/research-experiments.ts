/**
 * Durable research experiment runs. Unlike the synchronous sandbox tool, a
 * research experiment is submitted and executed in the background; its state
 * survives an app-ts restart (running at boot is marked interrupted).
 */
export const RESEARCH_EXPERIMENT_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "interrupted",
  "cancelled",
] as const;

export type ResearchExperimentStatus = (typeof RESEARCH_EXPERIMENT_STATUSES)[number];

/** One sandbox artifact recorded for an experiment (metadata only; bytes live in object storage). */
export interface ResearchExperimentArtifact {
  name: string;
  sizeBytes?: number;
  sha256?: string;
  /** short-lived presigned URL when the sandbox exposes one */
  url?: string;
}

export interface ResearchExperiment {
  id: string;
  uid: string;
  projectId: string;
  chatSessionId?: string;
  workspaceId?: string;
  title?: string;
  language: string;
  code: string;
  timeoutMs: number;
  status: ResearchExperimentStatus;
  exitCode?: number;
  stdoutPreview?: string;
  stderrPreview?: string;
  error?: string;
  /** sandbox artifacts produced by the run (uploaded to 04_结果 by the artifact sink) */
  artifacts?: ResearchExperimentArtifact[];
  /** approval row that authorised this run (approval v2) */
  approvalId?: string;
  /** dedupe identity (uid/project/language/code hash) used for duplicate-submit detection */
  dedupeKey?: string;
  /** set once the completion callback turn has been enqueued (idempotency guard) */
  callbackNotifiedAt?: number;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
}

export interface ResearchExperimentRepository {
  create(exp: ResearchExperiment): Promise<void>;
  get(id: string): Promise<ResearchExperiment | undefined>;
  listByUid(uid: string, projectId?: string, limit?: number): Promise<ResearchExperiment[]>;
  listUnfinished(): Promise<ResearchExperiment[]>;
  save(exp: ResearchExperiment): Promise<void>;
  /** 永久删除项目下所有实验记录（级联清理），返回删除条数。 */
  removeByProject(uid: string, projectId: string): Promise<number>;
}
