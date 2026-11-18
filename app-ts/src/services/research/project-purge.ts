import type {
  AcademicDocumentRepository,
  AcademicEventRepository,
  AcademicLiteratureRepository,
  AcademicProjectRepository,
} from "../../repository/academic.js";
import type { AcademicEvidenceRepository } from "../../repository/academic-evidence.js";
import type { AcademicNotificationRepository } from "../../repository/academic-notifications.js";
import type { PlanRunRepository } from "../../repository/plan-runs.js";
import type { ResearchApprovalRepository } from "../../repository/research-approvals.js";
import type { ResearchAutopilotRepository } from "../../repository/research-autopilot.js";
import type { ResearchDocumentRevisionRepository } from "../../repository/research-document-revisions.js";
import type { ResearchExperimentRepository } from "../../repository/research-experiments.js";
import type { ResearchWorkspaceRepository } from "../../repository/research-workspaces.js";
import { AcademicError } from "./academic.js";

/**
 * 项目永久删除（级联清理）服务。
 *
 * Layer: service. It owns the delete order and the per-collection counters; the
 * repositories stay the only data access and every `removeByProject` filters by
 * uid AND projectId. The project row is deleted last, so a failed step leaves
 * the project visible and the purge can be retried.
 *
 * Cloud-drive files / folders are NOT deleted here (the cloud domain owns them);
 * this service only removes app-ts metadata rows.
 */

/**
 * Per-collection delete counts of one purge. A type alias (not an interface) so
 * the result stays assignable to the route's Record<string, unknown> contract.
 */
export type ProjectPurgeCounts = {
  notifications: number;
  approvals: number;
  experiments: number;
  evidence: { datasets: number; runs: number };
  revisions: number;
  literature: number;
  documents: number;
  events: number;
  workspaces: number;
  autopilot: number;
  planRuns: number;
  project: number;
};

export interface ProjectPurgeResult {
  deleted: true;
  counts: ProjectPurgeCounts;
}

/**
 * Purge failure that keeps the counts already applied. It extends AcademicError,
 * so the existing route error mapping answers { detail } with its status;
 * `partialCounts` tells the caller which rows were already removed.
 */
export class ProjectPurgeError extends AcademicError {
  constructor(
    status: number,
    message: string,
    public readonly partialCounts?: ProjectPurgeCounts,
  ) {
    super(status, message);
    this.name = "ProjectPurgeError";
  }
}

/** Repositories the cascade touches (each call is uid + project scoped). */
export interface ProjectPurgeDeps {
  projects: Pick<AcademicProjectRepository, "get" | "remove">;
  literature: Pick<AcademicLiteratureRepository, "list" | "remove">;
  documents: Pick<AcademicDocumentRepository, "removeDocumentsByProject">;
  events: Pick<AcademicEventRepository, "removeEventsByProject">;
  evidence: Pick<AcademicEvidenceRepository, "removeByProject">;
  approvals: Pick<ResearchApprovalRepository, "removeByProject">;
  experiments: Pick<ResearchExperimentRepository, "removeByProject">;
  revisions: Pick<ResearchDocumentRevisionRepository, "removeByProject">;
  notifications: Pick<AcademicNotificationRepository, "removeByProject">;
  autopilot: Pick<ResearchAutopilotRepository, "removeByProject">;
  planRuns: Pick<PlanRunRepository, "removeByProject">;
  workspaces: Pick<ResearchWorkspaceRepository, "removeByProject">;
}

/** Fresh counters (evidence is nested because its contract reports two counts). */
function emptyCounts(): ProjectPurgeCounts {
  return {
    notifications: 0,
    approvals: 0,
    experiments: 0,
    evidence: { datasets: 0, runs: 0 },
    revisions: 0,
    literature: 0,
    documents: 0,
    events: 0,
    workspaces: 0,
    autopilot: 0,
    planRuns: 0,
    project: 0,
  };
}

/** Snapshot so a thrown ProjectPurgeError cannot observe later mutation. */
function snapshotCounts(counts: ProjectPurgeCounts): ProjectPurgeCounts {
  return { ...counts, evidence: { ...counts.evidence } };
}

export class ProjectPurgeService {
  constructor(private readonly deps: ProjectPurgeDeps) {}

  /**
   * Deletes every app-ts row owned by the project and finally the project row
   * itself. Missing/foreign projects answer 404; the fixed order is
   * notifications → approvals → experiments → evidence → revisions → literature
   * → documents → events → workspaces → autopilot → planRuns → project, and a
   * failing step aborts with the counts already applied.
   */
  async purge(uid: string, projectId: string): Promise<ProjectPurgeResult> {
    if (typeof uid !== "string" || uid.trim() === "") throw new AcademicError(401, "缺少用户身份");
    if (typeof projectId !== "string" || projectId.trim() === "") throw new AcademicError(400, "缺少 projectId");
    const project = await this.deps.projects.get(uid, projectId);
    if (!project) throw new AcademicError(404, "项目不存在或无权访问");

    const counts = emptyCounts();
    try {
      counts.notifications = await this.deps.notifications.removeByProject(uid, projectId);
      counts.approvals = await this.deps.approvals.removeByProject(uid, projectId);
      counts.experiments = await this.deps.experiments.removeByProject(uid, projectId);
      counts.evidence = await this.deps.evidence.removeByProject(uid, projectId);
      counts.revisions = await this.deps.revisions.removeByProject(uid, projectId);
      counts.literature = await this.removeLiterature(uid, projectId);
      counts.documents = await this.deps.documents.removeDocumentsByProject(uid, projectId);
      counts.events = await this.deps.events.removeEventsByProject(uid, projectId);
      counts.workspaces = await this.deps.workspaces.removeByProject(uid, projectId);
      counts.autopilot = await this.deps.autopilot.removeByProject(uid, projectId);
      counts.planRuns = await this.deps.planRuns.removeByProject(uid, projectId);
      counts.project = (await this.deps.projects.remove(uid, projectId)) ? 1 : 0;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new ProjectPurgeError(
        500,
        "项目删除失败（已删除 " + this.summarize(counts) + "）：" + detail,
        snapshotCounts(counts),
      );
    }
    return { deleted: true, counts };
  }

  /** Deletes the project literature one row at a time (the contract has no bulk delete). */
  private async removeLiterature(uid: string, projectId: string): Promise<number> {
    const entries = await this.deps.literature.list(uid, projectId);
    let removed = 0;
    for (const entry of entries) {
      if (await this.deps.literature.remove(uid, projectId, entry.id)) removed += 1;
    }
    return removed;
  }

  /** Short human-readable summary of the rows already removed (error message). */
  private summarize(counts: ProjectPurgeCounts): string {
    const total =
      counts.notifications +
      counts.approvals +
      counts.experiments +
      counts.evidence.datasets +
      counts.evidence.runs +
      counts.revisions +
      counts.literature +
      counts.documents +
      counts.events +
      counts.workspaces +
      counts.autopilot +
      counts.planRuns +
      counts.project;
    return total + " 条记录";
  }
}
