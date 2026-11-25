/**
 * 通用 AI 定时任务（AiTask）仓储契约。
 *
 * 一个任务 = 用户保存的 Prompt + 触发计划 + 上下文（可选科研项目）。
 * 每次触发产生一条 run；run 的内容是一份可阅读的汇报，并关联聊天 session。
 */

export const AI_TASK_KINDS = ["news", "literature", "report", "custom"] as const;
export type AiTaskKind = (typeof AI_TASK_KINDS)[number];
export const AI_TASK_STATUSES = ["active", "paused", "completed"] as const;
export type AiTaskStatus = (typeof AI_TASK_STATUSES)[number];

/** Numeric priority used by the scheduler queue: 2=high, 1=normal, 0=low. */
export const AI_TASK_PRIORITIES = { low: 0, normal: 1, high: 2 } as const;
export type AiTaskPriority = keyof typeof AI_TASK_PRIORITIES;
export const AI_TASK_SCHEDULE_TYPES = ["once", "daily", "weekly", "monthly"] as const;
export type AiTaskScheduleType = (typeof AI_TASK_SCHEDULE_TYPES)[number];

export interface AiTaskSchedule {
  type: AiTaskScheduleType;
  timezone: string;
  time?: string;
  weekday?: number;
  dayOfMonth?: number;
  runAt?: number;
}

export interface AiTask {
  id: string;
  uid: string;
  title: string;
  prompt: string;
  kind: AiTaskKind;
  schedule: AiTaskSchedule;
  status: AiTaskStatus;
  priority: number;
  notifyEmail?: boolean;
  notifyPush?: boolean;
  academicProjectId?: string;
  nextRunAt?: number;
  lastRunAt?: number;
  lastRunStatus?: AiTaskRunStatus;
  lastRunId?: string;
  lastError?: string;
  runCount: number;
  createdAt: number;
  updatedAt: number;
  lockedUntil?: number;
}

export const AI_TASK_RUN_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled", "skipped"] as const;
export type AiTaskRunStatus = (typeof AI_TASK_RUN_STATUSES)[number];

export interface AiTaskRun {
  id: string;
  taskId: string;
  uid: string;
  runKey: string;
  status: AiTaskRunStatus;
  scheduledFor: number;
  startedAt?: number;
  finishedAt?: number;
  lastHeartbeatAt?: number;
  cancelRequestedAt?: number;
  sessionId?: string;
  content?: string;
  error?: string;
  summary?: string;
  createdAt: number;
}

export interface AiTaskRunPatch {
  status?: AiTaskRunStatus;
  startedAt?: number;
  finishedAt?: number;
  lastHeartbeatAt?: number;
  cancelRequestedAt?: number;
  sessionId?: string;
  content?: string;
  error?: string;
  summary?: string;
}

export interface AiTaskPatch {
  title?: string;
  prompt?: string;
  kind?: AiTaskKind;
  schedule?: AiTaskSchedule;
  status?: AiTaskStatus;
  priority?: number;
  notifyEmail?: boolean;
  notifyPush?: boolean;
  academicProjectId?: string | null;
  nextRunAt?: number | null;
  lastRunAt?: number;
  lastRunStatus?: AiTaskRunStatus;
  lastRunId?: string;
  lastError?: string | null;
  runCount?: number;
  lockedUntil?: number | null;
}

export interface AiTaskRepository {
  createTask(task: AiTask): Promise<AiTask>;
  getTask(uid: string, id: string): Promise<AiTask | undefined>;
  listTasks(uid: string): Promise<AiTask[]>;
  updateTask(uid: string, id: string, patch: AiTaskPatch): Promise<AiTask | undefined>;
  deleteTask(uid: string, id: string): Promise<boolean>;
  listDue(now: number, limit: number): Promise<AiTask[]>;
  claimTask(id: string, now: number, leaseMs: number): Promise<AiTask | undefined>;
  createRun(run: AiTaskRun): Promise<AiTaskRun>;
  getRun(uid: string, id: string): Promise<AiTaskRun | undefined>;
  listRuns(uid: string, taskId: string, limit: number): Promise<AiTaskRun[]>;
  updateRun(runId: string, patch: AiTaskRunPatch): Promise<void>;
  findRunningRun(taskId: string): Promise<AiTaskRun | undefined>;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function isValidAiTaskTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function parseAiTaskTime(value: string | undefined): { hour: number; minute: number } | null {
  if (typeof value !== "string") return null;
  const match = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(value.trim());
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

interface LocalParts {
  hour: number;
  minute: number;
  weekday: number;
  day: number;
}

export function localPartsAt(timestamp: number, timezone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const pick = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return {
    day: Number(pick("day")),
    hour: Number(pick("hour")),
    minute: Number(pick("minute")),
    weekday: WEEKDAYS[pick("weekday")] ?? 0,
  };
}

/** Next occurrence strictly after from. 15-minute steps cover every IANA offset. */
export function nextAiTaskRunAt(schedule: AiTaskSchedule, from: number = Date.now()): number | null {
  if (schedule.type === "once") {
    return typeof schedule.runAt === "number" && schedule.runAt > from ? schedule.runAt : null;
  }
  const time = parseAiTaskTime(schedule.time);
  if (!time) return null;
  if (!isValidAiTaskTimezone(schedule.timezone)) return null;
  if (schedule.type === "weekly" && (schedule.weekday === undefined || schedule.weekday < 1 || schedule.weekday > 7)) return null;
  if (schedule.type === "monthly" && (schedule.dayOfMonth === undefined || schedule.dayOfMonth < 1 || schedule.dayOfMonth > 28)) return null;

  const step = 15 * 60_000;
  const start = Math.floor((from + 60_000) / step) * step;
  const deadline = from + 370 * 24 * 60 * 60_000;
  for (let timestamp = start; timestamp <= deadline; timestamp += step) {
    const local = localPartsAt(timestamp, schedule.timezone);
    if (local.hour !== time.hour || local.minute !== time.minute) continue;
    if (schedule.type === "weekly" && local.weekday !== schedule.weekday) continue;
    if (schedule.type === "monthly" && local.day !== schedule.dayOfMonth) continue;
    return timestamp;
  }
  return null;
}

export function describeAiTaskSchedule(schedule: AiTaskSchedule): string {
  if (schedule.type === "once") {
    return schedule.runAt ? new Date(schedule.runAt).toLocaleString("zh-CN", { timeZone: schedule.timezone }) : "一次性";
  }
  const time = schedule.time ?? "09:00";
  if (schedule.type === "daily") return "每天 " + time;
  if (schedule.type === "weekly") {
    const labels = ["一", "二", "三", "四", "五", "六", "日"];
    return "每周" + labels[(schedule.weekday ?? 1) - 1] + " " + time;
  }
  return "每月 " + (schedule.dayOfMonth ?? 1) + " 日 " + time;
}
