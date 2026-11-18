import {
  ACADEMIC_STAGE_LABELS,
  type AcademicDocumentRepository,
  type AcademicLiteratureRepository,
  type AcademicProjectRepository,
  type AcademicStage,
} from "../../repository/academic.js";
import type { AcademicEvidenceRepository } from "../../repository/academic-evidence.js";
import type { ResearchStageGateService } from "./research-stage-gates.js";
import type { ResearchValidationService } from "./research-validation.js";
import { createLogger } from "../../logger.js";

const log = createLogger("ACADEMIC-ADVISOR");

export class ResearchAdvisorError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ResearchAdvisorError";
  }
}

export type ResearchSuggestionSeverity = "blocker" | "warning" | "info";

/** One deterministic "next best action" for a research project. */
export interface ResearchSuggestion {
  id: string;
  title: string;
  reason: string;
  /** A copy-pastable next step (tool call shape, not executable here). */
  action: string;
  severity: ResearchSuggestionSeverity;
}

export interface ResearchAdviceResult {
  stage: AcademicStage;
  suggestions: ResearchSuggestion[];
}

export interface ResearchAdvisorDeps {
  projects: AcademicProjectRepository;
  documents: AcademicDocumentRepository;
  literature: AcademicLiteratureRepository;
  /** optional: gate report supplies the authoritative per-stage missing list */
  gates?: ResearchStageGateService;
  evidence?: Pick<AcademicEvidenceRepository, "listRuns">;
  validation?: Pick<ResearchValidationService, "validate">;
}

/** 基于项目存储状态生成最多 3 条「下一步建议」，不调用模型。 */
export class ResearchAdvisorService {
  constructor(private readonly deps: ResearchAdvisorDeps) {}

  async suggest(uid: string, projectId: string): Promise<ResearchAdviceResult> {
    const project = await this.deps.projects.get(uid, projectId);
    if (!project) throw new ResearchAdvisorError(404, "项目不存在或无权访问");
    const stage = project.stage;
    const stageLabel = ACADEMIC_STAGE_LABELS[stage];
    const suggestions: ResearchSuggestion[] = [];
    const seen = new Set<string>();
    const add = (
      severity: ResearchSuggestionSeverity,
      title: string,
      reason: string,
      action: string,
    ): void => {
      const key = title.trim();
      if (!key || seen.has(key) || suggestions.length >= 8) return;
      seen.add(key);
      suggestions.push({ id: "s" + (suggestions.length + 1), title: key, reason, action, severity });
    };

    // 1) Gate report (authoritative when the service is assembled).
    let gateMissing: string[] = [];
    let gateReady = false;
    let gateTaskCount = 0;
    if (this.deps.gates) {
      try {
        const report = await this.deps.gates.evaluate(uid, projectId);
        const current = report.report.find((entry) => entry.stage === stage);
        gateMissing = current?.missing ?? [];
        gateReady = current?.ready ?? false;
        gateTaskCount = current?.taskCount ?? 0;
      } catch (err) {
        log.warn("[ADVISOR] gate evaluate failed project=%s: %s", projectId, err instanceof Error ? err.message : String(err));
      }
    }
    if (gateTaskCount === 0) {
      add(
        "warning",
        "为「" + stageLabel + "」阶段生成执行计划",
        "当前阶段还没有可勾选的执行计划，先拆成 3-6 个可检查任务。",
        "academic_project(action=plan_set, stage=" + stage + ", tasks=[...])",
      );
    } else if (!gateReady && gateMissing.length > 0) {
      add(
        "blocker",
        "补齐「" + stageLabel + "」阶段交付物",
        "门禁未通过：" + gateMissing.slice(0, 3).join("；"),
        "academic_project(action=gate_status)",
      );
    }

    // 2) Library depth: a literature review needs at least a few real papers.
    const literatureCount = await this.deps.literature.count(uid, projectId);
    if (literatureCount < 3) {
      add(
        literatureCount === 0 ? "blocker" : "warning",
        "补充文献到至少 3 篇并核验",
        "项目文献库当前 " + literatureCount + " 篇；检索/导入后请对可核验的条目跑 DOI 核验。",
        "academic_literature(action=search, query=...) 然后 import / verify",
      );
    }

    // 3) Manuscript progress.
    const documents = await this.deps.documents.listDocuments(uid, projectId);
    const drafted = documents.filter((doc) =>
      doc.sections.some((section) => section.content.trim().length > 0),
    );
    const filledSections = documents.reduce(
      (sum, doc) => sum + doc.sections.filter((section) => section.content.trim().length > 0).length,
      0,
    );
    if (drafted.length === 0) {
      add(
        "info",
        "创建初稿并完成至少 3 个章节",
        "还没有任何有正文的稿件；建议先建 draft，再逐章节写入方法与结果骨架。",
        "academic_manuscript(action=create_document, projectId=..., title=...)",
      );
    } else if (filledSections < 3) {
      add(
        "warning",
        "把初稿补到至少 3 个有正文的章节",
        "当前有正文的章节仅 " + filledSections + " 个，距离可校验的初稿还差一些。",
        "academic_manuscript(action=save, ...)",
      );
    }

    // 4) Experiment evidence (only meaningful once the project reaches design/experiment).
    if (this.deps.evidence && (stage === "design" || stage === "experiment")) {
      try {
        const runs = await this.deps.evidence.listRuns(uid, projectId, { limit: 100 });
        const succeeded = runs.filter((run) => run.status === "succeeded").length;
        if (succeeded === 0) {
          add(
            "info",
            "提交一次可复现实验（需人工审批）",
            "目前没有成功的实验 run，结果章节将缺少可回链证据；先申请实验审批再提交后台实验。",
            "research_approval(action=request, kind=experiment) → academic_experiment(action=submit, ...)",
          );
        }
      } catch (err) {
        log.warn("[ADVISOR] evidence list failed project=%s: %s", projectId, err instanceof Error ? err.message : String(err));
      }
    }

    // 5) Integrity/export readiness.
    if (this.deps.validation && documents.length > 0) {
      try {
        const report = await this.deps.validation.validate(uid, projectId, undefined);
        if (!report.pass) {
          const problems = [
            ...report.citations.missing.map((key) => "缺失引用 " + key),
            ...report.citations.unverified.map((key) => "未核验 " + key),
            ...report.runs.invalidRefs.map((id) => "无效 run " + id),
            ...report.results.withoutEvidenceRef.map((title) => "结果章节无证据 " + title),
          ];
          add(
            "warning",
            "运行校验并修复导出阻塞项",
            problems.slice(0, 3).join("；") + (problems.length > 3 ? " 等 " + problems.length + " 项" : ""),
            "academic_validation(action=status) 然后修正后导出",
          );
        }
      } catch (err) {
        log.warn("[ADVISOR] validation failed project=%s: %s", projectId, err instanceof Error ? err.message : String(err));
      }
    }

    // 6) Deadline pressure.
    if (project.deadline) {
      const due = Date.parse(project.deadline + "T23:59:59Z");
      if (Number.isFinite(due)) {
        const days = Math.ceil((due - Date.now()) / (24 * 60 * 60 * 1000));
        if (days >= 0 && days <= 14) {
          add(
            "warning",
            "临近截止（" + project.deadline + "，剩 " + days + " 天）",
            "优先完成当前阶段交付物，再把修改稿与投稿检查项排到前面。",
            "academic_project(action=brief)",
          );
        }
      }
    }

    if (suggestions.length === 0) {
      add(
        "info",
        "阶段交付物已就绪",
        "当前「" + stageLabel + "」阶段没有检测到缺口；请用户确认是否推进/确认阶段（approved 永远由用户决定）。",
        "academic_project(action=gate_status)",
      );
    }

    const rank: Record<ResearchSuggestionSeverity, number> = { blocker: 0, warning: 1, info: 2 };
    suggestions.sort((a, b) => rank[a.severity] - rank[b.severity]);
    return { stage, suggestions: suggestions.slice(0, 3) };
  }
}
