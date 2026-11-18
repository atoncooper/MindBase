import {
  ACADEMIC_STAGES,
  ACADEMIC_STAGE_LABELS,
  academicAutoModeOf,
  nextStage,
  type AcademicDocument,
  type AcademicDocumentRepository,
  type AcademicEventRepository,
  type AcademicLiteratureEntry,
  type AcademicLiteratureRepository,
  type AcademicPlanTask,
  type AcademicProject,
  type AcademicProjectRepository,
  type AcademicStage,
  type AcademicStageState,
  type AcademicStageStatus,
} from "../../repository/academic.js";
import type { AcademicRun, AcademicEvidenceRepository } from "../../repository/academic-evidence.js";
import { describeValidationFailures, type ResearchValidationService } from "./research-validation.js";
import { createLogger } from "../../logger.js";

const log = createLogger("ACADEMIC-GATES");

/** 阶段门禁、计划任务自动完成与 autoMode 自动推进。 */

/** Domain error mapped onto an HTTP status by the route layer. */
export class ResearchStageGateError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ResearchStageGateError";
  }
}

/**
 * One stage's gate result. doneCount/taskCount describe the stage plan; missing
 * is the user-facing Chinese checklist of unmet deliverables (empty exactly
 * when ready=true).
 */
export interface StageGateEntry {
  stage: AcademicStage;
  status: AcademicStageStatus;
  ready: boolean;
  missing: string[];
  doneCount: number;
  taskCount: number;
}

/** Full gate report: every pipeline stage plus the project's current stage. */
export interface StageGateReport {
  /** the stage currently in focus (project.stage) */
  stage: AcademicStage;
  report: StageGateEntry[];
}

/** One plan task ticked by an autoRule during this sync. */
export interface StageGatePlanChange {
  stage: AcademicStage;
  id: string;
  title: string;
}

/** Outcome of advanceIfAuto: never advances unless autoMode="auto" and the current stage is ready. */
export interface StageGateAdvance {
  advanced: boolean;
  from?: AcademicStage;
  to?: AcademicStage;
  /** why nothing advanced (Chinese product text) */
  reason?: string;
}

/** Combined result of apply(): plan sync + gate report + auto-advance outcome. */
export interface StageGateApplyResult {
  sync: StageGatePlanChange[];
  advanced: StageGateAdvance;
  report: StageGateEntry[];
}

/** Every optional collaborator is a narrow Pick — the gate service does not own these domains. */
export interface ResearchStageGateDeps {
  projects: AcademicProjectRepository;
  documents: AcademicDocumentRepository;
  literature: AcademicLiteratureRepository;
  events: AcademicEventRepository;
  /** experiment evidence ledger; absent = experiment gate degrades to "plan tasks done" */
  evidence?: Pick<AcademicEvidenceRepository, "listRuns">;
  /** academic integrity report; absent = submission gate degrades to "plan tasks done" */
  validation?: Pick<ResearchValidationService, "validate">;
}

/** Plan completion projection used by both the gate report and the auto-tick rules. */
function planStats(tasks: AcademicPlanTask[] | undefined): { doneCount: number; taskCount: number; allDone: boolean } {
  const list = tasks ?? [];
  const doneCount = list.filter((task) => task.done).length;
  return { doneCount, taskCount: list.length, allDone: list.length > 0 && doneCount === list.length };
}

/** Chinese checklist line for an unfinished/absent stage plan. */
function planShortfall(stage: AcademicStage, tasks: AcademicPlanTask[] | undefined): string | null {
  const list = tasks ?? [];
  const label = ACADEMIC_STAGE_LABELS[stage];
  if (list.length === 0) return "先用 plan_set 生成「" + label + "」阶段的执行计划";
  const doneCount = list.filter((task) => task.done).length;
  if (doneCount === list.length) return null;
  return "「" + label + "」执行计划未全部完成（已完成 " + doneCount + "/" + list.length + "）";
}

/** Positive integer minRuns with a 1 default (bad input is treated as 1, not as unreachable). */
function minRunsOf(rule: { match?: { minRuns?: number } }): number {
  const raw = rule.match?.minRuns;
  if (raw === undefined || !Number.isFinite(raw)) return 1;
  return Math.max(1, Math.floor(raw));
}

/** Stage state with the same safe default the tool layer uses (legacy/partial rows read as locked). */
function stateOf(project: AcademicProject, stage: AcademicStage): AcademicStageState {
  return project.stages[stage] ?? { status: "locked", updatedAt: project.updatedAt };
}

/**
 * Suggestion helper (pure): when the current stage is ready and a next stage
 * exists, return the stage the pipeline would move to; otherwise null. Used by
 * tool/UI copy — it never writes anything.
 */
export function suggestNext(project: AcademicProject, report: readonly StageGateEntry[]): AcademicStage | null {
  const current = report.find((entry) => entry.stage === project.stage);
  if (!current?.ready) return null;
  return nextStage(project.stage);
}

export class ResearchStageGateService {
  constructor(private readonly deps: ResearchStageGateDeps) {}

  /**
   * Read-only evaluation of every stage's deliverables. The current stage's
   * entry is what advanceIfAuto checks; the other entries power the UI
   * checklist so users can see gaps before they become blockers.
   */
  async evaluate(uid: string, projectId: string): Promise<StageGateReport> {
    const project = await this.requireProject(uid, projectId);
    return { stage: project.stage, report: await this.buildReport(uid, project) };
  }

  /**
   * Tick every not-done plan task whose autoRule is satisfied, stamping
   * doneSource="event". Already-done tasks (user ticks included) are left
   * untouched, so a manual decision always wins. Returns the tasks changed.
   */
  async syncPlanTasks(uid: string, projectId: string): Promise<StageGatePlanChange[]> {
    const project = await this.requireProject(uid, projectId);
    const candidates: Array<{ stage: AcademicStage; task: AcademicPlanTask }> = [];
    for (const stage of ACADEMIC_STAGES) {
      for (const task of project.plans[stage] ?? []) {
        if (task.done || !task.autoRule) continue;
        candidates.push({ stage, task });
      }
    }
    if (candidates.length === 0) return [];

    // One lazily-materialized fact per domain, reused across every rule so a
    // project with N autoRule tasks still costs O(1) repository calls per domain.
    let documents: AcademicDocument[] | null = null;
    let library: AcademicLiteratureEntry[] | null = null;
    let runs: AcademicRun[] | null = null;
    let runsUnavailable = false;
    let validationPass: boolean | null = null;

    const matches = new Set<string>();
    for (const { stage, task } of candidates) {
      const rule = task.autoRule;
      if (!rule) continue;
      let satisfied = false;
      if (rule.event === "manuscript.section_saved") {
        documents ??= await this.deps.documents.listDocuments(uid, projectId);
        const sectionKey = rule.match?.sectionKey?.trim();
        satisfied = documents.some((doc) =>
          doc.sections.some(
            (section) => section.content.trim().length > 0 && (sectionKey === undefined || section.key === sectionKey),
          ),
        );
      } else if (rule.event === "academic.run_recorded") {
        if (this.deps.evidence) {
          if (runs === null && !runsUnavailable) {
            try {
              runs = await this.deps.evidence.listRuns(uid, projectId, { limit: 100 });
            } catch (err) {
              runsUnavailable = true;
              log.warn("[GATES] evidence.listRuns failed project_id=%s: %s", projectId, err instanceof Error ? err.message : err);
            }
          }
          satisfied = (runs?.length ?? 0) >= minRunsOf(rule);
        }
      } else if (rule.event === "literature.verified") {
        library ??= await this.deps.literature.list(uid, projectId);
        satisfied = library.filter((entry) => entry.verified).length >= minRunsOf(rule);
      } else if (rule.event === "validation.passed") {
        if (this.deps.validation && validationPass === null) {
          try {
            validationPass = (await this.deps.validation.validate(uid, projectId, undefined)).pass;
          } catch (err) {
            validationPass = false;
            log.warn("[GATES] validation failed project_id=%s: %s", projectId, err instanceof Error ? err.message : err);
          }
        }
        satisfied = validationPass === true;
      }
      if (satisfied) matches.add(stage + "/" + task.id);
    }
    if (matches.size === 0) return [];

    const changes: StageGatePlanChange[] = [];
    const plansPatch: Partial<Record<AcademicStage, AcademicPlanTask[]>> = {};
    for (const stage of ACADEMIC_STAGES) {
      const list = project.plans[stage];
      if (!list || list.length === 0) continue;
      let touched = false;
      const next = list.map((task) => {
        if (!matches.has(stage + "/" + task.id)) return task;
        touched = true;
        changes.push({ stage, id: task.id, title: task.title });
        return { ...task, done: true, doneSource: "event" as const };
      });
      if (touched) plansPatch[stage] = next;
    }
    if (changes.length === 0) return [];

    const updated = await this.deps.projects.update(uid, projectId, { plans: plansPatch });
    if (!updated) return [];
    // Audit convenience: the event feed explains why tasks appeared as done.
    // A failed append must never undo the successful tick.
    for (const stage of ACADEMIC_STAGES) {
      const tasks = plansPatch[stage];
      if (!tasks) continue;
      const completed = changes.filter((change) => change.stage === stage);
      try {
        await this.deps.events.append(
          uid,
          projectId,
          "plan.auto_completed",
          { stage, tasks: completed.map((change) => ({ id: change.id, title: change.title })) },
          "agent",
        );
      } catch (err) {
        log.warn("[GATES] event append failed type=plan.auto_completed project_id=%s: %s", projectId, err instanceof Error ? err.message : err);
      }
    }
    return changes;
  }

  /**
   * Advance one stage when - and only when - autoMode="auto", the current stage
   * is an active stage whose gate is ready, and a next stage exists. Writes the
   * two stage states in one project update plus a stage.updated event carrying
   * auto=true; "approved" is never written by this method.
   */
  async advanceIfAuto(uid: string, projectId: string): Promise<StageGateAdvance> {
    const project = await this.requireProject(uid, projectId);
    const mode = academicAutoModeOf(project);
    if (mode !== "auto") {
      return {
        advanced: false,
        reason:
          "autoMode 为「" +
          (mode === "off" ? "关闭" : "建议") +
          "」，不会自动推进阶段；approved 永远由人工设置。",
      };
    }
    const current = project.stage;
    const currentState = stateOf(project, current);
    if (currentState.status !== "active") {
      // submitted already awaits a human decision; approved/frozen/locked are
      // human or initial states - auto must never overwrite them.
      const statusLabel: Record<AcademicStageStatus, string> = {
        locked: "未开始",
        active: "进行中",
        submitted: "已提交（等待人工确认）",
        approved: "已确认",
        frozen: "已冻结",
      };
      return {
        advanced: false,
        reason:
          "当前阶段「" +
          ACADEMIC_STAGE_LABELS[current] +
          "」状态为「" +
          statusLabel[currentState.status] +
          "」，只有进行中的阶段才会自动推进；approved 永远由人工设置。",
      };
    }
    const report = await this.buildReport(uid, project);
    const currentGate = report.find((entry) => entry.stage === current);
    if (!currentGate?.ready) {
      return {
        advanced: false,
        reason:
          "当前阶段「" +
          ACADEMIC_STAGE_LABELS[current] +
          "」门禁未通过：" +
          (currentGate?.missing.join("；") ?? "缺少交付物"),
      };
    }
    const to = nextStage(current);
    if (!to) {
      return { advanced: false, reason: "当前阶段已是最后一个阶段（" + ACADEMIC_STAGE_LABELS.submission + "），不会自动推进。" };
    }
    const nextState = stateOf(project, to);
    if (nextState.status === "approved" || nextState.status === "frozen") {
      return {
        advanced: false,
        reason:
          "下一阶段「" +
          ACADEMIC_STAGE_LABELS[to] +
          "」已处于「" +
          (nextState.status === "approved" ? "已确认" : "已冻结") +
          "」，自动推进不会覆盖人工状态。",
      };
    }
    const now = Date.now();
    const stages: Partial<Record<AcademicStage, AcademicStageState>> = {};
    stages[current] = { status: "submitted", updatedAt: now };
    stages[to] = { status: "active", updatedAt: now };
    const updated = await this.deps.projects.update(uid, projectId, { stage: to, stages });
    if (!updated) return { advanced: false, reason: "项目更新失败（可能已被删除）。" };
    try {
      await this.deps.events.append(
        uid,
        projectId,
        "stage.updated",
        {
          stage: to,
          status: "active",
          previousStage: current,
          previousStatus: currentState.status,
          direction: "advance",
          auto: true,
        },
        "agent",
      );
    } catch (err) {
      log.warn("[GATES] event append failed type=stage.updated project_id=%s: %s", projectId, err instanceof Error ? err.message : err);
    }
    return { advanced: true, from: current, to };
  }
/**
 * Full automation pass used by the agent tool / REST sync endpoint: tick
 * autoRule tasks, re-evaluate the gates on the updated plan state, then (only
 * under autoMode="auto") advance one stage. The returned report is the
 * pre-advance snapshot; callers that need post-advance status should re-read
 * the project (the UI does via onChanged).
 */
  async apply(uid: string, projectId: string): Promise<StageGateApplyResult> {
    await this.requireProject(uid, projectId);
    const sync = await this.syncPlanTasks(uid, projectId);
    const evaluation = await this.evaluate(uid, projectId);
    const advanced = await this.advanceIfAuto(uid, projectId);
    return { sync, advanced, report: evaluation.report };
  }

  // ---- internals ----------------------------------------------------------

  private async requireProject(uid: string, projectId: string): Promise<AcademicProject> {
    const project = await this.deps.projects.get(uid, projectId);
    if (!project) throw new ResearchStageGateError(404, "项目不存在或无权访问");
    return project;
  }

  /**
   * Per-stage deliverable predicates. Domain facts (literature count, document
   * bodies, runs, validation) are fetched lazily at most once per report.
   */
  private async buildReport(uid: string, project: AcademicProject): Promise<StageGateEntry[]> {
    let literatureCount: number | null = null;
    let documents: AcademicDocument[] | null = null;
    let runs: AcademicRun[] | null = null;
    let runsUnavailable = false;
    let validationFailures: string[] | null = null;
    let validationUnavailable = false;

    const entries: StageGateEntry[] = [];
    for (const stage of ACADEMIC_STAGES) {
      const tasks = project.plans[stage];
      const stats = planStats(tasks);
      const missing: string[] = [];
      switch (stage) {
        case "topic": {
          // Exact product guidance for the empty-plan case (the very first gap).
          if (!tasks || tasks.length === 0) missing.push("先 plan_set 生成选题计划");
          else {
            const shortfall = planShortfall(stage, tasks);
            if (shortfall) missing.push(shortfall);
          }
          break;
        }
        case "design": {
          const shortfall = planShortfall(stage, tasks);
          if (shortfall) missing.push(shortfall);
          if (literatureCount === null) literatureCount = await this.deps.literature.count(uid, project.id);
          if (literatureCount < 3) missing.push("文献库至少需要 3 篇文献（当前 " + literatureCount + " 篇）");
          break;
        }
        case "advise": {
          if (!project.advice.advise?.trim()) missing.push("先 save_advice 保存「指导」阶段建议");
          const shortfall = planShortfall(stage, tasks);
          if (shortfall) missing.push(shortfall);
          break;
        }
        case "experiment": {
          if (this.deps.evidence) {
            if (runs === null && !runsUnavailable) {
              try {
                runs = await this.deps.evidence.listRuns(uid, project.id, { limit: 100 });
              } catch (err) {
                runsUnavailable = true;
                log.warn("[GATES] evidence.listRuns failed project_id=%s: %s", project.id, err instanceof Error ? err.message : err);
              }
            }
            if (runsUnavailable) {
              missing.push("实验证据服务暂时不可用，无法判断实验是否完成");
            } else {
              const succeeded = (runs ?? []).filter((run) => run.status === "succeeded").length;
              if (succeeded === 0) {
                missing.push("至少需要 1 个成功（succeeded）的实验运行（当前已记录 " + (runs?.length ?? 0) + " 个）");
              }
            }
          } else {
            const shortfall = planShortfall(stage, tasks);
            if (shortfall) missing.push(shortfall);
          }
          break;
        }
        case "writing": {
          if (documents === null) documents = await this.deps.documents.listDocuments(uid, project.id);
          const drafts = documents.filter((doc) => doc.kind === "draft" || doc.kind === "revision");
          const filledSections = drafts.reduce(
            (sum, doc) => sum + doc.sections.filter((section) => section.content.trim().length > 0).length,
            0,
          );
          if (drafts.length === 0) {
            missing.push("先创建初稿或修改稿（academic_manuscript action=create_document，kind=draft 或 revision）");
          } else if (filledSections < 3) {
            missing.push("初稿/修改稿至少需要 3 个有正文的章节（当前 " + filledSections + " 个）");
          }
          break;
        }
        case "submission": {
          if (this.deps.validation) {
            if (validationFailures === null && !validationUnavailable) {
              try {
                const report = await this.deps.validation.validate(uid, project.id, undefined);
                validationFailures = report.pass ? [] : describeValidationFailures(report).split("\n");
              } catch (err) {
                validationUnavailable = true;
                log.warn("[GATES] validation failed project_id=%s: %s", project.id, err instanceof Error ? err.message : err);
              }
            }
            if (validationUnavailable) missing.push("学术校验服务暂时不可用，无法判断投稿门禁");
            else if (validationFailures && validationFailures.length > 0) {
              missing.push(...validationFailures.map((line) => "学术校验未通过：" + line));
            }
          } else {
            const shortfall = planShortfall(stage, tasks);
            if (shortfall) missing.push(shortfall);
          }
          break;
        }
      }
      const state = stateOf(project, stage);
      entries.push({
        stage,
        status: state.status,
        ready: missing.length === 0,
        missing,
        doneCount: stats.doneCount,
        taskCount: stats.taskCount,
      });
    }
    return entries;
  }
}
