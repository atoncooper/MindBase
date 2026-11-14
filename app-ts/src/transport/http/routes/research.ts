import type { FastifyInstance, FastifyReply } from "fastify";
import { getRequestContext } from "../../../context/request-context.js";
import { AcademicError, type AcademicService } from "../../../services/academic.js";
import type { ResearchExperimentRunner } from "../../../services/research-experiment.js";
import type { ResearchExperiment } from "../../../repository/research-experiments.js";
import type {
  AcademicDataset,
  AcademicEvidenceRepository,
  AcademicRun,
} from "../../../repository/academic-evidence.js";
import type { ResearchValidationService } from "../../../services/research-validation.js";
import type { ResearchAnalysisService } from "../../../services/research-analysis.js";
import {
  ResearchWorkspaceError,
  type ResearchFolderKind,
  type ResearchWorkspaceService,
} from "../../../services/research-workspace.js";
import type { ResearchProjectWorkspace, ResearchWorkspace } from "../../../repository/research-workspaces.js";

/**
 * /academic/*科研工作台 REST extension (docs/research-ui-api.md §1–§5):
 * experiments, evidence, validation, analysis and the academic-workspace tree.
 *
 * Route layer only: uid from the gateway (X-Uid → request context), uid-scoped
 * services own ownership checks, domain errors map onto { status, detail }.
 * The pre-existing project/literature/document/approval surface lives in
 * routes/academic.ts and is unchanged.
 */

export interface ResearchRouteDeps {
  /** project ownership + title source (workspace ensure) */
  academic: AcademicService;
  experiments: ResearchExperimentRunner;
  evidence: AcademicEvidenceRepository;
  validation: ResearchValidationService;
  analysis: ResearchAnalysisService;
  workspace: ResearchWorkspaceService;
}

const FOLDER_KINDS: readonly ResearchFolderKind[] = [
  "plan",
  "literature",
  "data",
  "code",
  "results",
  "manuscript",
  "submission",
];

/** List default per contract §0 (limit defaults to 20, capped at 100). */
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

/** Evidence list default per contract §2 (limit=50). */
const DEFAULT_EVIDENCE_LIMIT = 50;

/** Error messages that mean "missing or foreign resource" (contract 404). */
const NOT_FOUND_HINT = /不存在|无权访问|还没有/;

export function registerResearchRoutes(app: FastifyInstance, deps: ResearchRouteDeps): void {
  const uidOf = (): string | undefined => {
    const uid = getRequestContext()?.uid;
    return typeof uid === "string" ? uid : undefined;
  };

  const requireUid = (reply: FastifyReply): string | undefined => {
    const uid = uidOf();
    if (uid === undefined) {
      void reply.status(401).send({ detail: "缺少用户身份（X-Uid）" });
      return undefined;
    }
    return uid;
  };

  /**
   * Single error mapping: AcademicError carries its own status, a workspace
   * error distinguishes "cloud unavailable" (503) from "no workspace" (404), a
   * bare service precondition error means the resource is missing (404), and
   * anything else bubbles to the global 500 handler.
   */
  const run = async <T>(reply: FastifyReply, handler: () => Promise<T>): Promise<T | FastifyReply> => {
    try {
      return await handler();
    } catch (err) {
      if (err instanceof AcademicError) {
        return reply.status(err.status).send({ detail: err.message });
      }
      if (err instanceof ResearchWorkspaceError) {
        const status = /云盘/.test(err.message) ? 503 : 404;
        return reply.status(status).send({ detail: err.message });
      }
      const message = err instanceof Error ? err.message : String(err);
      if (NOT_FOUND_HINT.test(message)) {
        return reply.status(404).send({ detail: message });
      }
      throw err;
    }
  };

  // ---- experiments (contract §1) ------------------------------------------

  app.get("/academic/projects/:projectId/experiments", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { projectId } = req.params as { projectId: string };
    const limit = listLimit((req.query as { limit?: unknown }).limit, DEFAULT_LIST_LIMIT);
    return run(reply, async () => {
      // Project ownership gate: a foreign/missing project is a 404, never an
      // empty list that hides another tenant's existence semantics.
      await deps.academic.getProject(uid, projectId);
      const experiments = await deps.experiments.list(uid, projectId, limit);
      return { experiments: experiments.map(experimentPayload) };
    });
  });

  app.post("/academic/experiments/:experimentId/cancel", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { experimentId } = req.params as { experimentId: string };
    return run(reply, async () => {
      const experiment = await deps.experiments.get(experimentId);
      if (!experiment || experiment.uid !== uid) {
        return reply.status(404).send({ detail: "实验不存在或无权访问" });
      }
      if (isExperimentTerminal(experiment.status)) {
        return { cancelled: false };
      }
      return { cancelled: await deps.experiments.cancel(experimentId) };
    });
  });

  // ---- evidence (contract §2) ---------------------------------------------

  app.get("/academic/projects/:projectId/evidence", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { projectId } = req.params as { projectId: string };
    const query = req.query as { limit?: unknown; offset?: unknown };
    const limit = listLimit(query.limit, DEFAULT_EVIDENCE_LIMIT);
    const offset = listOffset(query.offset);
    return run(reply, async () => {
      await deps.academic.getProject(uid, projectId);
      const [datasets, runs] = await Promise.all([
        deps.evidence.listDatasets(uid, projectId),
        deps.evidence.listRuns(uid, projectId, { limit, offset }),
      ]);
      return { datasets: datasets.map(datasetPayload), runs: runs.map(runPayload) };
    });
  });

  app.get("/academic/projects/:projectId/evidence/runs/:runId", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { projectId, runId } = req.params as { projectId: string; runId: string };
    return run(reply, async () => {
      const record = await deps.evidence.getRun(uid, projectId, runId);
      if (!record) return reply.status(404).send({ detail: "实验记录不存在或无权访问" });
      return { run: runPayload(record) };
    });
  });

  // ---- validation (contract §3) -------------------------------------------

  app.post("/academic/projects/:projectId/validation", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { projectId } = req.params as { projectId: string };
    const documentId = optionalDocumentId(req.body);
    if (documentId === INVALID) {
      return reply.status(422).send({ detail: "documentId 必须是字符串" });
    }
    return run(reply, async () => {
      const report = await deps.validation.validate(uid, projectId, documentId);
      return { report };
    });
  });

  // ---- analysis (contract §4) ---------------------------------------------

  app.post("/academic/projects/:projectId/analysis/results", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { projectId } = req.params as { projectId: string };
    const documentId = optionalDocumentId(req.body);
    if (documentId === INVALID) {
      return reply.status(422).send({ detail: "documentId 必须是字符串" });
    }
    return run(reply, () => deps.analysis.generateResultsTable(uid, projectId, documentId));
  });

  // ---- research workspace (contract §5) -----------------------------------

  app.get("/academic/projects/:projectId/workspace", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { projectId } = req.params as { projectId: string };
    return run(reply, async () => {
      const workspace = await deps.workspace.findByProject(uid, projectId);
      const project = workspace ? findProject(workspace, projectId) : undefined;
      if (!workspace || !project) {
        return reply.status(404).send({ detail: "项目还没有学术空间目录" });
      }
      return { workspace: workspacePayload(workspace, project) };
    });
  });

  app.post("/academic/projects/:projectId/workspace", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { projectId } = req.params as { projectId: string };
    return run(reply, async () => {
      // Title comes from the project row (ensureProject names the cloud folder);
      // getProject also enforces uid ownership (404 for a foreign project).
      const detail = await deps.academic.getProject(uid, projectId);
      const workspace = await deps.workspace.ensureProject(uid, projectId, detail.project.title);
      const project = findProject(workspace, projectId);
      if (!project) return reply.status(404).send({ detail: "项目还没有学术空间目录" });
      return { workspace: workspacePayload(workspace, project) };
    });
  });

  app.get("/academic/projects/:projectId/workspace/files", async (req, reply) => {
    const uid = requireUid(reply);
    if (!uid) return reply;
    const { projectId } = req.params as { projectId: string };
    const query = req.query as { kind?: unknown; limit?: unknown };
    const rawKind = typeof query.kind === "string" && query.kind.trim() !== "" ? query.kind.trim() : "data";
    if (!(FOLDER_KINDS as readonly string[]).includes(rawKind)) {
      return reply
        .status(422)
        .send({ detail: "kind 不合法（可选：" + FOLDER_KINDS.join(" / ") + "）" });
    }
    const kind = rawKind as ResearchFolderKind;
    const limit = listLimit(query.limit, DEFAULT_EVIDENCE_LIMIT);
    return run(reply, async () => {
      const workspace = await deps.workspace.findByProject(uid, projectId);
      const project = workspace ? findProject(workspace, projectId) : undefined;
      if (!workspace || !project) {
        return reply.status(404).send({ detail: "项目还没有学术空间目录" });
      }
      const files = await deps.workspace.listFiles(uid, projectId, kind);
      return {
        kind,
        folderId: project.folders[kind],
        files: files.slice(0, limit).map(filePayload),
      };
    });
  });
}

// ---------------------------------------------------------------------------
// Payload projections (uid is stripped: the wire contract never exposes it)
// ---------------------------------------------------------------------------

function experimentPayload(exp: ResearchExperiment) {
  return {
    id: exp.id,
    projectId: exp.projectId,
    ...(exp.chatSessionId !== undefined ? { chatSessionId: exp.chatSessionId } : {}),
    ...(exp.workspaceId !== undefined ? { workspaceId: exp.workspaceId } : {}),
    ...(exp.title !== undefined ? { title: exp.title } : {}),
    language: exp.language,
    code: exp.code,
    timeoutMs: exp.timeoutMs,
    status: exp.status,
    ...(exp.exitCode !== undefined ? { exitCode: exp.exitCode } : {}),
    ...(exp.stdoutPreview !== undefined ? { stdoutPreview: exp.stdoutPreview } : {}),
    ...(exp.stderrPreview !== undefined ? { stderrPreview: exp.stderrPreview } : {}),
    ...(exp.error !== undefined ? { error: exp.error } : {}),
    createdAt: exp.createdAt,
    ...(exp.startedAt !== undefined ? { startedAt: exp.startedAt } : {}),
    ...(exp.endedAt !== undefined ? { endedAt: exp.endedAt } : {}),
  };
}

function datasetPayload(dataset: AcademicDataset) {
  return {
    id: dataset.id,
    projectId: dataset.projectId,
    name: dataset.name,
    ...(dataset.description !== undefined ? { description: dataset.description } : {}),
    source: dataset.source,
    files: dataset.files,
    createdAt: dataset.createdAt,
  };
}

function runPayload(run: AcademicRun) {
  return {
    id: run.id,
    projectId: run.projectId,
    ...(run.datasetId !== undefined ? { datasetId: run.datasetId } : {}),
    name: run.name,
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
    createdAt: run.createdAt,
  };
}

function workspacePayload(workspace: ResearchWorkspace, project: ResearchProjectWorkspace) {
  return {
    workspaceId: workspace.workspaceId,
    title: workspace.title,
    project: {
      projectId: project.projectId,
      title: project.title,
      rootFolderId: project.rootFolderId,
      folders: project.folders,
    },
  };
}

function filePayload(file: {
  upload_uuid: string;
  name: string;
  size: number;
  mime_type: string;
  sha256?: string;
  createdAt?: number;
}) {
  return {
    upload_uuid: file.upload_uuid,
    name: file.name,
    size: file.size,
    mime_type: file.mime_type,
    ...(file.sha256 !== undefined ? { sha256: file.sha256 } : {}),
    ...(file.createdAt !== undefined ? { createdAt: file.createdAt } : {}),
  };
}

// ---------------------------------------------------------------------------
// Query/body normalization helpers
// ---------------------------------------------------------------------------

function listLimit(raw: unknown, fallback: number): number {
  const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_LIST_LIMIT);
}

function listOffset(raw: unknown): number {
  const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (!Number.isFinite(value)) return 0;
  return Math.max(Math.trunc(value), 0);
}

/** Sentinel for a non-string documentId (route answers 422 before calling the service). */
const INVALID = Symbol("invalid-document-id");

/**
 * documentId is optional; a blank value means "all documents" (contract §3/§4),
 * a non-string value is a client error.
 */
function optionalDocumentId(body: unknown): string | undefined | typeof INVALID {
  if (body === null || typeof body !== "object") return undefined;
  const raw = (body as { documentId?: unknown }).documentId;
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") return INVALID;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

function findProject(workspace: ResearchWorkspace, projectId: string): ResearchProjectWorkspace | undefined {
  return workspace.projects.find((project) => project.projectId === projectId);
}

/** Terminal experiment states never change again (cancel is a no-op there). */
function isExperimentTerminal(status: ResearchExperiment["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "interrupted" || status === "cancelled";
}
