import { z } from "zod";
import { defineTool } from "../base.js";
import type { ToolRunContext } from "../../context/types.js";
import {
  ACADEMIC_STAGES,
  ACADEMIC_STAGE_LABELS,
  nextStage,
  stageIndex,
  type AcademicDocumentRepository,
  type AcademicEventRepository,
  type AcademicLiteratureRepository,
  type AcademicPlanTask,
  type AcademicProject,
  type AcademicProjectPatch,
  type AcademicProjectRepository,
  type AcademicStage,
  type AcademicStageState,
  type AcademicStageStatus,
} from "../../repository/academic.js";

/**
 * academic_project: research project workspace (desktop parity:
 * mind-base-desktop AgentKind::Research).
 *
 * Layer: agent tool layer. This file only orchestrates the injected
 * repositories; it never opens storage or network connections itself, so the
 * memory and Mongo adapters stay interchangeable behind the contracts.
 *
 * The project is the anchor of every academic task: literature and manuscripts
 * hang off project_id so switching chat sessions never loses context. Stages
 * advance on explicit user approval - the tool records what the user
 * confirmed, it never approves a gate on its own, never advances a stage by
 * itself, and a rewind always requires a written reason that is persisted as a
 * project event.
 *
 * Invariants:
 *  - Multi-tenant: uid comes from ToolRunContext and never appears in the
 *    schema; every repository call is uid-scoped, so a project id owned by
 *    another tenant resolves to "not found" instead of leaking data.
 *  - Every action except list/create requires projectId; a missing or foreign
 *    project comes back as plain guidance text (never a thrown error) so the
 *    ReAct loop keeps going.
 *  - All user/LLM-facing copy in this file is Chinese product text and must
 *    not be translated; comments are English.
 */

/**
 * Repositories injected by the composition root; no adapters are constructed
 * here. Literature/documents are only ever used through their count
 * projections, so the brief never page in row bodies it does not render.
 */
export interface AcademicProjectToolDeps {
  projects: AcademicProjectRepository;
  events: AcademicEventRepository;
  literature: AcademicLiteratureRepository;
  documents: AcademicDocumentRepository;
}

/**
 * Chinese product labels for stage statuses. These strings are rendered into
 * tool output that the user/LLM reads, so values stay Chinese; only comments
 * are English.
 */
const STAGE_STATUS_LABELS: Record<AcademicStageStatus, string> = {
  locked: "未开始",
  active: "进行中",
  submitted: "待确认",
  approved: "已确认",
  frozen: "已冻结",
};

/** Chinese labels for paper types, rendered by renderProject and action=list. */
const PAPER_TYPE_LABELS: Record<string, string> = {
  journal: "期刊论文",
  thesis: "学位论文",
  fund: "基金申请",
};

/** Chinese labels for event types, shown in the brief timeline. */
const EVENT_LABELS: Record<string, string> = {
  "project.created": "创建项目",
  "stage.updated": "阶段更新",
  "advice.saved": "保存阶段建议",
  "plan.updated": "更新阶段计划",
  "literature.imported": "导入文献",
  "literature.verified": "核验文献",
  "manuscript.document_created": "新建写作文档",
  "manuscript.section_saved": "保存章节",
  "manuscript.outline_updated": "调整章节结构",
};

/**
 * Guidance fallbacks returned instead of throwing: a missing uid, a foreign
 * project id, or a missing projectId must degrade into text the ReAct loop can
 * recover from (usually by re-prompting the user).
 */
const NO_USER_TEXT = "当前会话没有用户身份，无法访问学术工作区。";
const NO_PROJECT_TEXT = "项目不存在或无权访问。";
const MISSING_PROJECT_TEXT = "缺少 project_id：请先用 action=list 查看研究项目，或 action=create 新建项目。";

/**
 * Epoch milliseconds to a UTC YYYY-MM-DD date for display; nullish input
 * becomes an empty string so callers can render their own "not set" text.
 */
function dateOf(ms: number | undefined): string {
  if (!ms) return "";
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Stage state with a safe default: a stage that was never touched (or a
 * partially persisted record) reads as locked rather than undefined, which
 * keeps every renderer total.
 */
function stageStateOf(project: AcademicProject, stage: AcademicStage): AcademicStageState {
  return project.stages[stage] ?? { status: "locked", updatedAt: project.updatedAt };
}

/** Renders the status label, followed by the saved note in parentheses when present. */
function statusText(project: AcademicProject, stage: AcademicStage): string {
  const state = stageStateOf(project, stage);
  const label = STAGE_STATUS_LABELS[state.status] ?? state.status;
  return state.note ? label + "（" + state.note + "）" : label;
}

/**
 * Ordered stage list with a "→" marker on the current stage, one line per
 * stage, so the LLM can reason about progress without another repository call.
 */
function renderStages(project: AcademicProject): string[] {
  return ACADEMIC_STAGES.map((stage, index) => {
    const mark = stage === project.stage ? "→" : " ";
    return mark + " " + (index + 1) + ". " + ACADEMIC_STAGE_LABELS[stage] + "：" + statusText(project, stage);
  });
}

/** Compact project header (identity, current stage, progress) used by create and brief. */
function renderProject(project: AcademicProject): string {
  const lines = [
    "项目：「" + project.title + "」（project_id: " + project.id + "）",
    "类型：" +
      (PAPER_TYPE_LABELS[project.paperType] ?? project.paperType) +
      "｜领域：" +
      (project.field || "未填写") +
      "｜目标期刊：" +
      (project.targetJournal || "未填写") +
      "｜截止：" +
      (project.deadline || "未设置"),
    "当前阶段：" + ACADEMIC_STAGE_LABELS[project.stage] + "（" + statusText(project, project.stage) + "）",
    "阶段进展（→ 为当前阶段）：",
    ...renderStages(project),
  ];
  return lines.join("\n");
}

/**
 * Render one stage plan. An empty plan deliberately returns guidance instead
 * of an empty list, so the model knows action=plan_set is how to fill it.
 */
function renderPlan(stage: AcademicStage, tasks: AcademicPlanTask[] | undefined): string {
  const list = tasks ?? [];
  const label = ACADEMIC_STAGE_LABELS[stage];
  if (list.length === 0) {
    return "「" + label + "」阶段还没有执行计划。可用 action=plan_set 写入任务列表。";
  }
  const done = list.filter((task) => task.done).length;
  const lines = ["「" + label + "」执行计划（" + done + "/" + list.length + " 完成）："];
  list.forEach((task, index) => {
    const note = task.note ? "（" + task.note + "）" : "";
    lines.push((index + 1) + ". [" + (task.done ? "x" : " ") + "] " + task.title + note);
  });
  return lines.join("\n");
}

/**
 * Merge the task titles of one stage into its previous plan. Same-title tasks
 * keep their id / done / note; new titles get the first free positional id
 * ("t1", "t2", ...) so reordering or inserting never yields duplicate ids
 * inside a stage. Shared by the single-stage and the batch plan_set paths.
 */
function mergePlanTasks(previous: AcademicPlanTask[], titles: string[]): AcademicPlanTask[] {
  const byTitle = new Map(previous.map((task) => [task.title.trim(), task] as const));
  const used = new Set<string>();
  const tasks: AcademicPlanTask[] = [];
  const pending: AcademicPlanTask[] = [];
  for (const title of titles) {
    const prior = byTitle.get(title);
    if (prior) {
      used.add(prior.id);
      tasks.push(prior);
    } else {
      const task: AcademicPlanTask = { id: "", title, done: false };
      pending.push(task);
      tasks.push(task);
    }
  }
  let next = 1;
  for (const task of pending) {
    while (used.has("t" + next)) next += 1;
    task.id = "t" + next;
    used.add(task.id);
    next += 1;
  }
  return tasks;
}

/**
 * Compact all-stage overview for plan_get without a stage: one line per stage
 * that already has a plan, so the model can see the whole project plan without
 * paging every task. Falls back to plan_set guidance when nothing is planned.
 */
function renderPlanOverview(project: AcademicProject): string {
  const lines = ["项目「" + project.title + "」的执行计划："];
  let hasPlan = false;
  for (const stage of ACADEMIC_STAGES) {
    const tasks = project.plans[stage];
    if (!tasks || tasks.length === 0) continue;
    hasPlan = true;
    const done = tasks.filter((task) => task.done).length;
    lines.push("- " + ACADEMIC_STAGE_LABELS[stage] + "：" + done + "/" + tasks.length + " 完成");
  }
  if (!hasPlan) {
    return "项目「" + project.title + "」还没有执行计划。可用 action=plan_set 的 stages 一次生成多个阶段的科研计划。";
  }
  lines.push("", "用 action=plan_get + stage 查看某阶段的任务明细。");
  return lines.join("\n");
}

/**
 * Emit the typed project snapshot as a tool artifact. The web client renders
 * these cards; text output alone would force it to re-parse Chinese prose.
 */
function pushProjectArtifact(ctx: ToolRunContext, action: string, project: AcademicProject): void {
  ctx.collector.pushArtifacts([{ kind: "academic_project", data: { action, project } }]);
}

/**
 * Full project brief: header, library sizes (literature / manuscript counts via
 * the repositories' count projections), per-stage plan summaries, saved advice
 * previews, and the most recent events. Read-only; returns NO_PROJECT_TEXT when
 * the id is missing or owned by another uid (never throws).
 */
async function projectBrief(
  deps: AcademicProjectToolDeps,
  uid: string,
  projectId: string,
): Promise<string> {
  const project = await deps.projects.get(uid, projectId);
  if (!project) return NO_PROJECT_TEXT;
  // Library sizes come from the repositories' O(1) count projections: the brief
  // must never load every literature entry / document body just to print two
  // numbers, so this stays a constant-cost read regardless of library size.
  const [events, literatureCount, documentCount] = await Promise.all([
    deps.events.listEvents(uid, projectId, 5),
    deps.literature.count(uid, projectId),
    deps.documents.countDocuments(uid, projectId),
  ]);

  const lines = [
    renderProject(project),
    "",
    "项目资料：文献 " + literatureCount + " 篇 / 稿件 " + documentCount + " 篇",
    "",
    "执行计划：",
  ];
  let hasPlan = false;
  for (const stage of ACADEMIC_STAGES) {
    const tasks = project.plans[stage];
    if (!tasks || tasks.length === 0) continue;
    hasPlan = true;
    const done = tasks.filter((task) => task.done).length;
    lines.push("- " + ACADEMIC_STAGE_LABELS[stage] + "：" + done + "/" + tasks.length + " 完成");
  }
  if (!hasPlan) lines.push("- 尚未制定执行计划（可用 action=plan_set 写入）");

  lines.push("", "已保存的指导建议：");
  let hasAdvice = false;
  for (const stage of ACADEMIC_STAGES) {
    const advice = project.advice[stage];
    if (!advice) continue;
    hasAdvice = true;
    const preview = advice.length > 120 ? advice.slice(0, 120) + "…" : advice;
    lines.push("- " + ACADEMIC_STAGE_LABELS[stage] + "：" + preview);
  }
  if (!hasAdvice) lines.push("- 暂无（可用 action=save_advice 保存）");

  lines.push("", "最近事件：");
  if (events.length === 0) {
    lines.push("- 暂无事件");
  } else {
    for (const event of events) {
      lines.push("- " + dateOf(event.createdAt) + " " + (EVENT_LABELS[event.type] ?? event.type));
    }
  }
  lines.push("", "文献与稿件明细：academic_literature(action=list) / academic_manuscript(action=documents)。");
  return lines.join("\n");
}

/**
 * Tool input schema. Note the absence of uid: identity is taken from the tool
 * context, so the model cannot address another user workspace.
 */
const projectInputSchema = z.object({
  action: z
    .enum(["list", "create", "brief", "stage_update", "save_advice", "plan_get", "plan_set"])
    .describe(
      "list=列出研究项目；create=新建项目；brief=项目简报；stage_update=推进/回退阶段；save_advice=保存阶段建议；plan_get=读取执行计划（不传 stage 返回全部阶段摘要）；plan_set=写入执行计划（单阶段 stage+tasks，多阶段 stages 批量）",
    ),
  projectId: z.string().min(1).optional().describe("项目 id（create/list 之外必填，来自 action=list 或 create 的输出）"),
  title: z.string().min(1).max(120).optional().describe("项目标题（create 必填）"),
  paperType: z.enum(["journal", "thesis", "fund"]).optional().describe("成果类型（create 可选，缺省 journal）"),
  field: z.string().max(80).optional().describe("研究领域（create 可选）"),
  targetJournal: z.string().max(120).optional().describe("目标期刊/会议（create 可选）"),
  deadline: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "格式应为 YYYY-MM-DD")
    .optional()
    .describe("截止日期 YYYY-MM-DD（create 可选）"),
  stage: z
    .enum(ACADEMIC_STAGES)
    .optional()
    .describe("阶段：topic 选题 / design 研究设计 / advise 指导 / experiment 实验 / writing 写作 / submission 投稿（stage_update/save_advice 必填；plan_get 可选，不传返回全部阶段；plan_set 用 stage+tasks 时必填，与 stages 二选一）"),
  status: z
    .enum(["locked", "active", "submitted", "approved", "frozen"])
    .optional()
    .describe("阶段状态（stage_update 可选，缺省 active：active 进行中 / submitted 待确认 / approved 已确认 / frozen 冻结 / locked 未开始）"),
  reason: z.string().max(300).optional().describe("回退阶段的原因（回退到更早阶段时必填，会写入项目事件）"),
  advice: z.string().max(4000).optional().describe("阶段指导建议（save_advice 必填）"),
  tasks: z
    .array(z.string().max(200))
    .min(1)
    .max(12)
    .optional()
    .describe("单阶段执行计划的任务描述列表（plan_set 用 stage+tasks 时必填，1-12 条；同名任务保留完成状态与备注）"),
  stages: z
    .array(
      z.object({
        stage: z.enum(ACADEMIC_STAGES),
        tasks: z.array(z.string().max(200)).min(1).max(12),
      }),
    )
    .min(1)
    .max(6)
    .optional()
    .describe(
      "批量写入多个阶段的执行计划（plan_set 用 stages 时与 stage+tasks 二选一，1-6 个阶段、每阶段 1-12 条任务；用于一次生成完整科研计划）",
    ),
});

/**
 * Build the academic_project tool.
 *
 * Actions: list / create / brief / stage_update / save_advice / plan_get /
 * plan_set. The tool returns human-readable Chinese text (the ReAct loop reads
 * it as the tool result) and, for mutating actions, also pushes an
 * academic_project artifact carrying the latest project snapshot.
 *
 * Side effects: repository writes plus academic.* event appends; no external
 * service is touched. Expected failures are expressed as text so the model can
 * retry with corrected arguments instead of the loop aborting.
 */
export function createAcademicProjectTool(deps: AcademicProjectToolDeps) {
  return defineTool({
    name: "academic_project",
    description:
      "研究项目工作区（学术/科研任务的项目上下文）。" +
      "action=list：列出我的研究项目；" +
      "action=create：新建研究项目（title 必填，paperType/field/targetJournal/deadline 可选），返回 project_id；" +
      "action=brief：项目简报（阶段状态、执行计划、已存建议、最近事件、文献/稿件数量）；" +
      "action=stage_update：推进或回退项目阶段（回退必须给 reason；阶段推进需用户确认后才能调用）；" +
      "action=save_advice：保存某阶段的指导建议；" +
      "action=plan_get：读取执行计划（不传 stage 返回全部已有阶段的摘要）；" +
      "action=plan_set：写入执行计划（单阶段用 stage+tasks；多阶段用 stages 一次批量写入，用于「生成科研计划/研究计划/开题计划」；同名任务保留完成状态与备注）。" +
      "阶段顺序：topic 选题 → design 研究设计 → advise 指导 → experiment 实验 → writing 写作 → submission 投稿。" +
      "除 list/create 外的 action 都需要 projectId。文献与稿件请配合 academic_literature / academic_manuscript；不要编造项目内容。",
    inputSchema: projectInputSchema,
    async execute(args, ctx) {
      // Identity is supplied by the runtime, never by the model (see the schema note above).
      const uid = ctx.uid;
      if (!uid) return NO_USER_TEXT;
      const projectId = args.projectId?.trim() ?? "";

      switch (args.action) {
        case "list": {
          const projects = await deps.projects.list(uid);
          if (projects.length === 0) {
            return "还没有研究项目。可用 action=create 新建（需要 title，可选 paperType/field/targetJournal/deadline）。";
          }
          const lines = ["我共有 " + projects.length + " 个研究项目："];
          projects.forEach((project, index) => {
            lines.push(
              (index + 1) +
                ". [" +
                project.id +
                "] 「" +
                project.title +
                "」｜" +
                (PAPER_TYPE_LABELS[project.paperType] ?? project.paperType) +
                "｜当前阶段：" +
                ACADEMIC_STAGE_LABELS[project.stage] +
                "｜截止：" +
                (project.deadline || "未设置") +
                "｜更新：" +
                dateOf(project.updatedAt),
            );
          });
          lines.push("用 action=brief + projectId 查看某个项目的完整简报。");
          return lines.join("\n");
        }

        case "create": {
          const title = (args.title ?? "").trim();
          if (!title) {
            return "新建项目需要 title：请给一个简短的项目标题（如「基于图神经网络的推荐系统综述」）。";
          }
          const created = await deps.projects.create(uid, {
            title,
            paperType: args.paperType,
            field: args.field?.trim() || undefined,
            targetJournal: args.targetJournal?.trim() || undefined,
            deadline: args.deadline?.trim() || undefined,
          });
          await deps.events.append(
            uid,
            created.id,
            "project.created",
            { title: created.title, paperType: created.paperType },
            "agent",
          );
          pushProjectArtifact(ctx, "create", created);
          const lines = [
            renderProject(created),
            "",
            "项目已创建。下一步可：",
            "1) 用 academic_literature 检索或导入文献（需要 project_id）；",
            "2) 用 action=plan_set 为「选题」阶段写入执行计划；",
            "3) 用户确认后可用 action=stage_update 推进阶段。",
          ];
          return lines.join("\n");
        }

        case "brief": {
          if (!projectId) return MISSING_PROJECT_TEXT;
          const text = await projectBrief(deps, uid, projectId);
          if (text !== NO_PROJECT_TEXT) {
            // projectBrief only returns text; re-read the project to attach the typed artifact.
            const project = await deps.projects.get(uid, projectId);
            if (project) pushProjectArtifact(ctx, "brief", project);
          }
          return text;
        }

        case "stage_update": {
          if (!projectId) return MISSING_PROJECT_TEXT;
          const target = args.stage;
          if (!target) {
            return "stage_update 需要 stage：topic / design / advise / experiment / writing / submission。";
          }
          const project = await deps.projects.get(uid, projectId);
          if (!project) return NO_PROJECT_TEXT;

          const from = project.stage;
          const nextStatus: AcademicStageStatus = args.status ?? "active";
          const reason = (args.reason ?? "").trim();
          // Forward moves may proceed once the user has confirmed; a backward move reopens a gate the user already approved, so it always needs a written reason.
          // The tool never advances stages by itself and never synthesizes an approved status: status is whatever the caller passes (defaulting to active).
          const rewinding = stageIndex(target) < stageIndex(from);
          // Refuse the write rather than persist an unexplained regression: returned guidance is recoverable, a silent rollback is not.
          if (rewinding && !reason) {
            return (
              "回退到「" +
              ACADEMIC_STAGE_LABELS[target] +
              "」属于回退操作，需要 reason：说明为什么要回到该阶段（如审稿意见要求补实验）。"
            );
          }
          const currentState = stageStateOf(project, from);
          // Same stage + same status + no note is a no-op: answer instead of writing a duplicate event.
          if (target === from && currentState.status === nextStatus && !reason) {
            return (
              "项目当前已处于「" +
              ACADEMIC_STAGE_LABELS[target] +
              "」阶段（" +
              statusText(project, target) +
              "），状态未变化，无需重复更新。"
            );
          }

          // Only the target stage is patched; the note (when present) is the rewind audit trail rendered by statusText.
          const state: AcademicStageState = { status: nextStatus, updatedAt: Date.now() };
          if (reason) state.note = reason;
          const stagesPatch: Partial<Record<AcademicStage, AcademicStageState>> = {};
          stagesPatch[target] = state;
          const patch: AcademicProjectPatch = { stage: target, stages: stagesPatch };

          const updated = await deps.projects.update(uid, projectId, patch);
          if (!updated) return NO_PROJECT_TEXT;
          // Events are the audit trail the brief reads back; direction makes rewind vs advance explicit.
          await deps.events.append(
            uid,
            projectId,
            "stage.updated",
            {
              stage: target,
              status: nextStatus,
              previousStage: from,
              previousStatus: currentState.status,
              direction: rewinding ? "rewind" : "advance",
              ...(reason ? { reason } : {}),
            },
            "agent",
          );
          pushProjectArtifact(ctx, "stage_update", updated);

          const verb = rewinding ? "回退" : target === from ? "更新" : "推进";
          const lines = [
            "已将项目「" +
              updated.title +
              "」" +
              verb +
              "到「" +
              ACADEMIC_STAGE_LABELS[target] +
              "」阶段，状态：" +
              (STAGE_STATUS_LABELS[nextStatus] ?? nextStatus) +
              "。",
            "",
            "阶段进展（→ 为当前阶段）：",
            ...renderStages(updated),
          ];
          const following = nextStage(target);
          if (!rewinding && following) {
            lines.push("", "下一步可 action=plan_set 为「" + ACADEMIC_STAGE_LABELS[following] + "」阶段写入执行计划。");
          }
          return lines.join("\n");
        }

        case "save_advice": {
          if (!projectId) return MISSING_PROJECT_TEXT;
          const stage = args.stage;
          if (!stage) {
            return "save_advice 需要 stage：指明建议属于哪个阶段（topic/design/advise/experiment/writing/submission）。";
          }
          const advice = (args.advice ?? "").trim();
          if (!advice) return "save_advice 需要 advice：写明该阶段的指导建议内容。";
          const project = await deps.projects.get(uid, projectId);
          if (!project) return NO_PROJECT_TEXT;

          const advicePatch: Partial<Record<AcademicStage, string>> = {};
          advicePatch[stage] = advice;
          const updated = await deps.projects.update(uid, projectId, { advice: advicePatch });
          if (!updated) return NO_PROJECT_TEXT;
          await deps.events.append(
            uid,
            projectId,
            "advice.saved",
            { stage, advice },
            "agent",
          );
          pushProjectArtifact(ctx, "save_advice", updated);
          const preview = advice.length > 200 ? advice.slice(0, 200) + "…" : advice;
          return (
            "已保存「" +
            ACADEMIC_STAGE_LABELS[stage] +
            "」阶段的指导建议（" +
            advice.length +
            " 字）：\n" +
            preview
          );
        }

        case "plan_get": {
          if (!projectId) return MISSING_PROJECT_TEXT;
          const project = await deps.projects.get(uid, projectId);
          if (!project) return NO_PROJECT_TEXT;
          const stage = args.stage;
          // No stage: summarize every stage that has a plan; a stage: full task list.
          return stage ? renderPlan(stage, project.plans[stage]) : renderPlanOverview(project);
        }

        case "plan_set": {
          if (!projectId) return MISSING_PROJECT_TEXT;
          const batchForm = args.stages !== undefined;
          const singleForm = args.stage !== undefined || args.tasks !== undefined;
          // Two mutually exclusive shapes: one stage (stage+tasks) or a batch (stages).
          if (batchForm && singleForm) {
            return "plan_set 的 stage+tasks 与 stages 只能二选一：单阶段用 stage+tasks，多阶段用 stages 批量写入。";
          }
          if (!batchForm && !singleForm) {
            return "plan_set 需要 stages（批量写入多个阶段）或 stage+tasks（单阶段）：给出阶段与每阶段 1-12 个任务。";
          }
          const project = await deps.projects.get(uid, projectId);
          if (!project) return NO_PROJECT_TEXT;

          // Normalize every requested stage to a non-empty title list before writing,
          // so a malformed batch never half-applies.
          const requested: Array<{ stage: AcademicStage; titles: string[] }> = [];
          if (batchForm) {
            const seen = new Set<AcademicStage>();
            for (const entry of args.stages ?? []) {
              if (seen.has(entry.stage)) {
                return "stages 中同一阶段只能出现一次：「" + ACADEMIC_STAGE_LABELS[entry.stage] + "」重复了。";
              }
              seen.add(entry.stage);
              const titles = entry.tasks.map((task) => task.trim()).filter((task) => task.length > 0);
              if (titles.length === 0) {
                return "「" + ACADEMIC_STAGE_LABELS[entry.stage] + "」阶段的 tasks 为空：每个阶段需要 1-12 个任务描述。";
              }
              requested.push({ stage: entry.stage, titles });
            }
          } else {
            const stage = args.stage;
            const rawTasks = args.tasks;
            if (!stage || !rawTasks) {
              return "单阶段写入需要同时提供 stage 和 tasks；要一次写多个阶段请改用 stages。";
            }
            const titles = rawTasks.map((task) => task.trim()).filter((task) => task.length > 0);
            if (titles.length === 0) return "plan_set 需要 tasks：给出该阶段要执行的 1-12 个任务描述。";
            requested.push({ stage, titles });
          }

          // Merge each stage against its own previous plan, then persist the whole
          // batch with a single projects.update and a single plan.updated event.
          const plansPatch: Partial<Record<AcademicStage, AcademicPlanTask[]>> = {};
          const summaries: Array<{ stage: AcademicStage; taskCount: number }> = [];
          for (const entry of requested) {
            const previous = project.plans[entry.stage] ?? [];
            const tasks = mergePlanTasks(previous, entry.titles);
            plansPatch[entry.stage] = tasks;
            summaries.push({ stage: entry.stage, taskCount: tasks.length });
          }
          const replaced = requested.some((entry) => (project.plans[entry.stage]?.length ?? 0) > 0);
          const updated = await deps.projects.update(uid, projectId, { plans: plansPatch });
          if (!updated) return NO_PROJECT_TEXT;

          if (!batchForm) {
            // Single-stage event payload stays exactly as before (backward compatible).
            const only = requested[0];
            await deps.events.append(
              uid,
              projectId,
              "plan.updated",
              { stage: only.stage, taskCount: summaries[0].taskCount, replaced },
              "agent",
            );
            pushProjectArtifact(ctx, "plan_set", updated);
            return "已写入计划。\n\n" + renderPlan(only.stage, plansPatch[only.stage]);
          }

          // Batch event: stages summary keeps the per-stage counts; taskCount is the total.
          await deps.events.append(
            uid,
            projectId,
            "plan.updated",
            { stages: summaries, taskCount: summaries.reduce((sum, entry) => sum + entry.taskCount, 0), replaced },
            "agent",
          );
          pushProjectArtifact(ctx, "plan_set", updated);
          const chunks = requested.map((entry) => renderPlan(entry.stage, plansPatch[entry.stage]));
          return "已写入 " + requested.length + " 个阶段的执行计划。\n\n" + chunks.join("\n\n");
        }

        // Unreachable through zod validation, but older/unknown clients still get guidance instead of a throw.
        default: {
          const action = String((args as { action?: unknown }).action ?? "");
          return (
            "未知 action：" +
            action +
            "（可用：list / create / brief / stage_update / save_advice / plan_get / plan_set）"
          );
        }
      }
    },
  });
}
