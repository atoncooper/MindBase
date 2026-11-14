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
}
