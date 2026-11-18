import { createLogger } from "../../logger.js";
import {
  ACADEMIC_STAGE_LABELS,
  type AcademicProjectRepository,
  type AcademicStage,
} from "../../repository/academic.js";
import {
  defaultResearchAutopilotSetting,
  isResearchAutopilotMode,
  isResearchAutopilotStopped,
  isValidResearchAutopilotMaxActionsPerDay,
  type ResearchAutopilotMode,
  type ResearchAutopilotRepository,
  type ResearchAutopilotSetting,
} from "../../repository/research-autopilot.js";
import { formatDateIn } from "../../utils/datetime.js";
import type { ResearchNotificationService } from "./notifications.js";
import {
  ResearchAdvisorError,
  type ResearchAdvisorService,
  type ResearchSuggestion,
} from "./research-advisor.js";
import {
  ResearchStageGateError,
  type ResearchStageGateService,
  type StageGateEntry,
  type StageGatePlanChange,
} from "./research-stage-gates.js";

const log = createLogger("AUTOPILOT");

/** Title of the aggregated "next actions" notification produced by assist mode. */
export const AUTOPILOT_ASSIST_NOTIFICATION_TITLE = "科研助手建议";
/** Title of the auto-mode notification (retells whether a stage advanced). */
export const AUTOPILOT_AUTO_NOTIFICATION_TITLE = "科研项目自动推进";
/** Workbench tab linked from autopilot notifications. */
export const AUTOPILOT_OVERVIEW_TAB = "overview";

/** Domain error mapped onto an HTTP status by the route layer. */
export class ResearchAutopilotError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ResearchAutopilotError";
  }
}

/**
 * Service collaborators. projects only answers the ownership/404 check;
 * gates/advisor are the deterministic engines (no LLM anywhere in this
 * service) and notifications is an optional best-effort sink.
 */
export interface ResearchAutopilotDeps {
  settings: ResearchAutopilotRepository;
  projects: Pick<AcademicProjectRepository, "get">;
  gates: Pick<ResearchStageGateService, "apply">;
  advisor: Pick<ResearchAdvisorService, "suggest">;
  notifications?: Pick<ResearchNotificationService, "create">;
  /** Clock injection (tests); defaults to Date.now(). */
  now?: () => number;
}

/** Why a tick did nothing: disabled, emergency-stopped or over the daily budget. */
export interface ResearchAutopilotSkipResult {
  skipped: true;
  mode: ResearchAutopilotMode;
  reason: string;
  actionsToday: number;
  maxActionsPerDay: number;
}

/** Assist tick: suggestions only, nothing in the project is mutated. */
export interface ResearchAutopilotAssistResult {
  skipped: false;
  mode: "assist";
  stage: AcademicStage;
  suggestions: ResearchSuggestion[];
  /** true when the aggregated notification was persisted. */
  notified: boolean;
  actionsToday: number;
  lastTickAt: number;
}

/** Auto tick: deterministic gate pass plus suggestions about the new state. */
export interface ResearchAutopilotAutoResult {
  skipped: false;
  mode: "auto";
  /** stage the project is in after this tick (post-advance). */
  stage: AcademicStage;
  advanced: boolean;
  from?: AcademicStage;
  to?: AcademicStage;
  /** why nothing advanced (Chinese product text, present when advanced=false). */
  advanceReason?: string;
  sync: StageGatePlanChange[];
  report: StageGateEntry[];
  suggestions: ResearchSuggestion[];
  notified: boolean;
  actionsToday: number;
  lastTickAt: number;
}

/** Degraded tick: the deterministic engines failed; the route still answers 200. */
export interface ResearchAutopilotErrorResult {
  error: string;
}

export type ResearchAutopilotTickResult =
  | ResearchAutopilotSkipResult
  | ResearchAutopilotAssistResult
  | ResearchAutopilotAutoResult
  | ResearchAutopilotErrorResult;

/**
 * 项目级 Autopilot：配置读取/更新、每日预算、急停，以及一次确定性 tick。
 * tick 只做门禁同步/自动推进与建议通知，不调用 LLM、不提交实验、从不写 approved。
 */
export class ResearchAutopilotService {
  constructor(private readonly deps: ResearchAutopilotDeps) {}

  /** Current setting (default off when the project was never configured). 404 for missing/foreign project. */
  async get(uid: string, projectId: string): Promise<ResearchAutopilotSetting> {
    await this.requireProject(uid, projectId);
    return this.loadSetting(uid, projectId);
  }

  /**
   * Partial update: mode / maxActionsPerDay / stopped. Invalid values map to 422;
   * stopped=true stamps stoppedAt, stopped=false clears it (resume). The day
   * counter rolls over here too, so an old row never keeps a stale count.
   */
  async patch(uid: string, projectId: string, body: unknown): Promise<ResearchAutopilotSetting> {
    const patch = bodyPatch(body);
    await this.requireProject(uid, projectId);
    const at = this.now();
    const day = formatDateIn(new Date(at));
    const current = await this.loadSetting(uid, projectId, day);
    const next: ResearchAutopilotSetting = { ...current, day, updatedAt: at };

    if (patch.mode !== undefined) {
      if (!isResearchAutopilotMode(patch.mode)) {
        throw new ResearchAutopilotError(422, "mode 必须是 off、assist 或 auto");
      }
      next.mode = patch.mode;
    }
    if (patch.maxActionsPerDay !== undefined) {
      if (!isValidResearchAutopilotMaxActionsPerDay(patch.maxActionsPerDay)) {
        throw new ResearchAutopilotError(422, "maxActionsPerDay 必须是 1-100 的整数");
      }
      next.maxActionsPerDay = patch.maxActionsPerDay;
    }
    if (patch.stopped !== undefined) {
      if (typeof patch.stopped !== "boolean") {
        throw new ResearchAutopilotError(422, "stopped 必须是 boolean");
      }
      if (patch.stopped) next.stoppedAt = at;
      else delete next.stoppedAt;
    }
    await this.deps.settings.save(next);
    return next;
  }

  /**
   * One deterministic autopilot pass. off/emergency-stopped/over-budget answer
   * { skipped, reason } without touching the project. assist only notifies;
   * auto runs gates.apply() first (which advances only when the project's
   * autoMode is "auto" and the gate is ready) and then notifies. Engine
   * failures degrade to { error } so a scheduled caller never crashes; missing
   * project still throws 404.
   */
  async tick(uid: string, projectId: string): Promise<ResearchAutopilotTickResult> {
    await this.requireProject(uid, projectId);
    const at = this.now();
    const day = formatDateIn(new Date(at));
    const setting = await this.loadSetting(uid, projectId, day);
    const budget = { actionsToday: setting.actionsToday, maxActionsPerDay: setting.maxActionsPerDay };
    if (setting.mode === "off") {
      return { skipped: true, mode: "off", reason: "Autopilot 未启用（off），科研推进保持手动。", ...budget };
    }
    if (isResearchAutopilotStopped(setting)) {
      return { skipped: true, mode: setting.mode, reason: "Autopilot 已急停，恢复后才能继续自动推进。", ...budget };
    }
    if (setting.actionsToday >= setting.maxActionsPerDay) {
      return {
        skipped: true,
        mode: setting.mode,
        reason:
          "今日自动推进预算已用完（" +
          setting.actionsToday +
          "/" +
          setting.maxActionsPerDay +
          "），明日自动重置。",
        ...budget,
      };
    }

    try {
      if (setting.mode === "assist") {
        const run = await this.runAssist(uid, projectId);
        const saved = await this.persistSuccess(setting, day, at, run.lastResult);
        return {
          skipped: false,
          mode: "assist",
          stage: run.stage,
          suggestions: run.suggestions,
          notified: run.notified,
          actionsToday: saved.actionsToday,
          lastTickAt: at,
        };
      }
      const run = await this.runAuto(uid, projectId);
      const saved = await this.persistSuccess(setting, day, at, run.lastResult);
      return {
        skipped: false,
        mode: "auto",
        stage: run.stage,
        advanced: run.advanced,
        ...(run.from !== undefined ? { from: run.from } : {}),
        ...(run.to !== undefined ? { to: run.to } : {}),
        ...(run.advanceReason !== undefined ? { advanceReason: run.advanceReason } : {}),
        sync: run.sync,
        report: run.report,
        suggestions: run.suggestions,
        notified: run.notified,
        actionsToday: saved.actionsToday,
        lastTickAt: at,
      };
    } catch (err) {
      // The project vanished between the ownership check and the engine call:
      // keep the HTTP 404 semantic instead of degrading to a generic error.
      if (isNotFoundError(err)) throw new ResearchAutopilotError(404, "项目不存在或无权访问");
      const message = err instanceof Error ? err.message : String(err);
      log.warn("[AUTOPILOT] tick failed uid=%s project=%s: %s", uid, projectId, message);
      return { error: message };
    }
  }

  // ---- internals ----------------------------------------------------------

  /** assist pass: suggestions only, aggregated into at most one notification. */
  private async runAssist(uid: string, projectId: string): Promise<AssistRun> {
    const advice = await this.deps.advisor.suggest(uid, projectId);
    const suggestions = advice.suggestions;
    let notified = false;
    if (suggestions.length > 0 && this.deps.notifications) {
      const created = await this.deps.notifications.create({
        uid,
        projectId,
        type: "plan",
        title: AUTOPILOT_ASSIST_NOTIFICATION_TITLE,
        body: suggestionLines(suggestions).join("\n"),
        link: overviewLink(projectId),
      });
      notified = created !== undefined;
    }
    const lastResult =
      suggestions.length > 0
        ? "assist：生成 " + suggestions.length + " 条建议" + (notified ? "（已通知）" : "")
        : "assist：暂无建议";
    return { stage: advice.stage, suggestions, notified, lastResult };
  }

  /** auto pass: gate sync/advance first, then suggestions about the resulting state. */
  private async runAuto(uid: string, projectId: string): Promise<AutoRun> {
    const applied = await this.deps.gates.apply(uid, projectId);
    const advice = await this.deps.advisor.suggest(uid, projectId);
    const suggestions = advice.suggestions;
    const advanced = applied.advanced.advanced;
    const from = applied.advanced.from;
    const to = applied.advanced.to;
    const advanceReason = applied.advanced.reason;

    const lines: string[] = [];
    if (advanced && from !== undefined && to !== undefined) {
      lines.push("已自动推进阶段：" + ACADEMIC_STAGE_LABELS[from] + " → " + ACADEMIC_STAGE_LABELS[to]);
    } else {
      lines.push("本轮未自动推进：" + (advanceReason ?? "门禁未就绪"));
    }
    lines.push(...suggestionLines(suggestions));
    let notified = false;
    if (this.deps.notifications) {
      const created = await this.deps.notifications.create({
        uid,
        projectId,
        type: "plan",
        title: AUTOPILOT_AUTO_NOTIFICATION_TITLE,
        body: lines.join("\n"),
        link: overviewLink(projectId),
      });
      notified = created !== undefined;
    }

    const advanceText =
      advanced && from !== undefined && to !== undefined
        ? "已推进 " + ACADEMIC_STAGE_LABELS[from] + "→" + ACADEMIC_STAGE_LABELS[to]
        : "未推进";
    const lastResult =
      "auto：" +
      advanceText +
      (suggestions.length > 0 ? "；" + suggestions.length + " 条建议" : "") +
      (notified ? "（已通知）" : "");

    return {
      stage: advice.stage,
      advanced,
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      ...(advanceReason !== undefined ? { advanceReason } : {}),
      sync: applied.sync,
      report: applied.report,
      suggestions,
      notified,
      lastResult,
    };
  }

  /** Read row merged with today's defaults; a stale day resets actionsToday. */
  private async loadSetting(
    uid: string,
    projectId: string,
    day: string = this.today(),
  ): Promise<ResearchAutopilotSetting> {
    const stored = await this.deps.settings.get(uid, projectId);
    if (!stored) return defaultResearchAutopilotSetting(uid, projectId, day);
    if (stored.day === day) return stored;
    return { ...stored, day, actionsToday: 0 };
  }

  /** Stamp a completed tick: budget +1, lastTickAt/lastResult; returns the stored row. */
  private async persistSuccess(
    setting: ResearchAutopilotSetting,
    day: string,
    at: number,
    lastResult: string,
  ): Promise<ResearchAutopilotSetting> {
    const saved: ResearchAutopilotSetting = {
      ...setting,
      day,
      actionsToday: setting.actionsToday + 1,
      lastTickAt: at,
      lastResult,
      updatedAt: at,
    };
    await this.deps.settings.save(saved);
    return saved;
  }

  private async requireProject(uid: string, projectId: string): Promise<void> {
    const project = await this.deps.projects.get(uid, projectId);
    if (!project) throw new ResearchAutopilotError(404, "项目不存在或无权访问");
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private today(): string {
    return formatDateIn(new Date(this.now()));
  }
}

/** Result of one assist pass before the counter is stamped. */
interface AssistRun {
  stage: AcademicStage;
  suggestions: ResearchSuggestion[];
  notified: boolean;
  lastResult: string;
}

/** Result of one auto pass before the counter is stamped. */
interface AutoRun {
  stage: AcademicStage;
  advanced: boolean;
  from?: AcademicStage;
  to?: AcademicStage;
  advanceReason?: string;
  sync: StageGatePlanChange[];
  report: StageGateEntry[];
  suggestions: ResearchSuggestion[];
  notified: boolean;
  lastResult: string;
}

/** Caller body narrowed to a plain object; missing body means an empty patch. */
function bodyPatch(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new ResearchAutopilotError(422, "请求体必须是 JSON 对象");
  }
  return body as Record<string, unknown>;
}

/** At most three "n. title：reason" lines for one aggregated notification. */
function suggestionLines(suggestions: readonly ResearchSuggestion[]): string[] {
  return suggestions
    .slice(0, 3)
    .map((suggestion, index) => index + 1 + ". " + suggestion.title + "：" + suggestion.reason);
}

/** Workbench link of the overview tab for this project. */
function overviewLink(projectId: string): string {
  return "/research?project=" + encodeURIComponent(projectId) + "&tab=" + AUTOPILOT_OVERVIEW_TAB;
}

/** Engine 404s stay 404 at the service boundary (route maps them to { detail }). */
function isNotFoundError(err: unknown): boolean {
  if (err instanceof ResearchStageGateError || err instanceof ResearchAdvisorError) {
    return err.status === 404;
  }
  return err instanceof ResearchAutopilotError && err.status === 404;
}
