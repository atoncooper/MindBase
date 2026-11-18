/** 项目级 Autopilot 设置契约（uid 隔离，一个项目一行）。off 全手动；assist 只发建议通知；auto 按门禁自动推进。 */

export const RESEARCH_AUTOPILOT_MODES = ["off", "assist", "auto"] as const;
/** One autopilot mode (see RESEARCH_AUTOPILOT_MODES). */
export type ResearchAutopilotMode = (typeof RESEARCH_AUTOPILOT_MODES)[number];

/** Daily action budget when the caller did not configure one. */
export const RESEARCH_AUTOPILOT_DEFAULT_MAX_ACTIONS_PER_DAY = 10;
/** Lower bound of a persisted daily action budget. */
export const RESEARCH_AUTOPILOT_MIN_ACTIONS_PER_DAY = 1;
/** Upper bound of a persisted daily action budget. */
export const RESEARCH_AUTOPILOT_MAX_ACTIONS_PER_DAY = 100;

/**
 * One project's autopilot configuration plus its daily counter.
 *
 * - mode drives tick(): off = nothing, assist = suggestion notification only,
 *   auto = deterministic gate sync/advance through the project's autoMode;
 * - actionsToday counts completed ticks of the current day (reset when day
 *   rolls over), compared against maxActionsPerDay;
 * - stoppedAt (epoch ms) is the emergency stop; resume clears it;
 * - lastTickAt/lastResult are the last successful run's audit summary.
 */
export interface ResearchAutopilotSetting {
  uid: string;
  projectId: string;
  mode: ResearchAutopilotMode;
  maxActionsPerDay: number;
  actionsToday: number;
  /** Local calendar day "YYYY-MM-DD" (Asia/Shanghai via config.timezone). */
  day: string;
  stoppedAt?: number;
  lastTickAt?: number;
  lastResult?: string;
  updatedAt: number;
}

/** Storage contract: absent row means "never configured" (caller applies the default off setting). */
export interface ResearchAutopilotRepository {
  get(uid: string, projectId: string): Promise<ResearchAutopilotSetting | undefined>;
  /** Upsert by (uid, projectId); optional fields missing from the row are cleared in storage. */
  save(setting: ResearchAutopilotSetting): Promise<void>;
  /** Scheduler enumeration: rows with mode != "off" that are not emergency-stopped. */
  listActive(): Promise<ResearchAutopilotSetting[]>;
  /** 永久删除项目下的 autopilot 设置（级联清理），返回删除条数。 */
  removeByProject(uid: string, projectId: string): Promise<number>;
}

/** Runtime guard for a caller-supplied mode. */
export function isResearchAutopilotMode(value: unknown): value is ResearchAutopilotMode {
  return typeof value === "string" && (RESEARCH_AUTOPILOT_MODES as readonly string[]).includes(value);
}

/** Runtime guard for a persisted budget: an integer within [1, 100]. */
export function isValidResearchAutopilotMaxActionsPerDay(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= RESEARCH_AUTOPILOT_MIN_ACTIONS_PER_DAY &&
    value <= RESEARCH_AUTOPILOT_MAX_ACTIONS_PER_DAY
  );
}

/**
 * Default setting returned for a project that has never been configured:
 * off, 10 actions/day, today's counter at 0. updatedAt=0 marks "never persisted".
 */
export function defaultResearchAutopilotSetting(
  uid: string,
  projectId: string,
  day: string,
): ResearchAutopilotSetting {
  return {
    uid,
    projectId,
    mode: "off",
    maxActionsPerDay: RESEARCH_AUTOPILOT_DEFAULT_MAX_ACTIONS_PER_DAY,
    actionsToday: 0,
    day,
    updatedAt: 0,
  };
}

/** Emergency-stop check (present stoppedAt = paused until resume clears it). */
export function isResearchAutopilotStopped(setting: Pick<ResearchAutopilotSetting, "stoppedAt">): boolean {
  return setting.stoppedAt !== undefined;
}
