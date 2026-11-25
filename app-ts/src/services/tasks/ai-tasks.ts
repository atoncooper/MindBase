import { randomUUID } from "node:crypto";
import {
  AI_TASK_KINDS,
  AI_TASK_PRIORITIES,
  AI_TASK_SCHEDULE_TYPES,
  describeAiTaskSchedule,
  isValidAiTaskTimezone,
  nextAiTaskRunAt,
  parseAiTaskTime,
  type AiTask,
  type AiTaskKind,
  type AiTaskPriority,
  type AiTaskRepository,
  type AiTaskRun,
  type AiTaskSchedule,
  type AiTaskStatus,
} from "../../repository/ai-tasks.js";

const DEFAULT_TIMEZONE = "Asia/Shanghai";
const MAX_TITLE = 120;
const MAX_PROMPT = 20_000;
const MAX_RUN_CONTENT = 200_000;

export class AiTaskError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AiTaskError";
  }
}

export interface AiTaskWire {
  id: string;
  title: string;
  prompt: string;
  kind: AiTaskKind;
  schedule: AiTaskSchedule;
  scheduleLabel: string;
  status: AiTaskStatus;
  priority: AiTaskPriority;
  notifyEmail: boolean;
  notifyPush: boolean;
  academicProjectId?: string;
  nextRunAt?: number;
  lastRunAt?: number;
  lastRunStatus?: string;
  lastRunId?: string;
  lastError?: string;
  runCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface AiTaskRunWire {
  id: string;
  taskId: string;
  status: string;
  scheduledFor: number;
  startedAt?: number;
  finishedAt?: number;
  lastHeartbeatAt?: number;
  cancelRequestedAt?: number;
  sessionId?: string;
  summary?: string;
  error?: string;
  content?: string;
  createdAt: number;
}

/**
 * Task CRUD + schedule validation + manual-run preparation.
 * Execution is intentionally in AiTaskRunner so routes/tests can exercise CRUD
 * without starting an agent turn.
 */
export class AiTaskService {
  constructor(private readonly repo: AiTaskRepository) {}

  async list(uid: string): Promise<AiTaskWire[]> {
    const tasks = await this.repo.listTasks(uid);
    return tasks.map(taskView);
  }

  async get(uid: string, id: string): Promise<AiTaskWire> {
    const task = await this.repo.getTask(uid, id);
    if (!task) throw new AiTaskError(404, "任务不存在或无权访问");
    return taskView(task);
  }

  async create(uid: string, body: unknown): Promise<AiTaskWire> {
    const input = objectBody(body);
    const now = Date.now();
    const schedule = parseSchedule(input.schedule, now);
    const nextRunAt = nextAiTaskRunAt(schedule, now);
    if (nextRunAt === null) throw new AiTaskError(422, "触发时间无效或已经过期");
    const task: AiTask = {
      id: randomUUID(),
      uid,
      title: requiredString(input.title, "任务名称", MAX_TITLE),
      prompt: requiredString(input.prompt, "任务指令", MAX_PROMPT),
      kind: parseKind(input.kind),
      schedule,
      status: "active",
      priority: parsePriority(input.priority),
      notifyEmail: input.notifyEmail !== false,
      notifyPush: input.notifyPush !== false,
      nextRunAt,
      runCount: 0,
      createdAt: now,
      updatedAt: now,
      ...(optionalString(input.academicProjectId) ? { academicProjectId: optionalString(input.academicProjectId) } : {}),
    };
    await this.repo.createTask(task);
    return taskView(task);
  }

  async update(uid: string, id: string, body: unknown): Promise<AiTaskWire> {
    const current = await this.repo.getTask(uid, id);
    if (!current) throw new AiTaskError(404, "任务不存在或无权访问");
    const input = objectBody(body);
    const patch: Parameters<AiTaskRepository["updateTask"]>[2] = {};
    if (input.title !== undefined) patch.title = requiredString(input.title, "任务名称", MAX_TITLE);
    if (input.prompt !== undefined) patch.prompt = requiredString(input.prompt, "任务指令", MAX_PROMPT);
    if (input.kind !== undefined) patch.kind = parseKind(input.kind);
    if (input.priority !== undefined) patch.priority = parsePriority(input.priority);
    if (input.notifyEmail !== undefined) patch.notifyEmail = input.notifyEmail === true;
    if (input.notifyPush !== undefined) patch.notifyPush = input.notifyPush === true;
    if (input.academicProjectId !== undefined) {
      patch.academicProjectId = optionalString(input.academicProjectId) ?? null;
    }
    if (input.schedule !== undefined) {
      const schedule = parseSchedule(input.schedule, Date.now());
      const nextRunAt = nextAiTaskRunAt(schedule, Date.now());
      if (nextRunAt === null) throw new AiTaskError(422, "触发时间无效或已经过期");
      patch.schedule = schedule;
      patch.nextRunAt = nextRunAt;
      if (current.status === "completed") patch.status = "active";
    }
    const updated = await this.repo.updateTask(uid, id, patch);
    if (!updated) throw new AiTaskError(404, "任务不存在或无权访问");
    return taskView(updated);
  }

  async pause(uid: string, id: string): Promise<AiTaskWire> {
    const updated = await this.repo.updateTask(uid, id, { status: "paused", nextRunAt: null, lockedUntil: null });
    if (!updated) throw new AiTaskError(404, "任务不存在或无权访问");
    return taskView(updated);
  }

  async resume(uid: string, id: string): Promise<AiTaskWire> {
    const task = await this.repo.getTask(uid, id);
    if (!task) throw new AiTaskError(404, "任务不存在或无权访问");
    const nextRunAt = nextAiTaskRunAt(task.schedule, Date.now());
    if (nextRunAt === null) throw new AiTaskError(422, "任务计划已过期，请先修改触发时间");
    const updated = await this.repo.updateTask(uid, id, {
      status: "active",
      nextRunAt,
      lastError: undefined,
      lockedUntil: null,
    });
    if (!updated) throw new AiTaskError(404, "任务不存在或无权访问");
    return taskView(updated);
  }

  async delete(uid: string, id: string): Promise<void> {
    const deleted = await this.repo.deleteTask(uid, id);
    if (!deleted) throw new AiTaskError(404, "任务不存在或无权访问");
  }

  /** Create a manual run; returns it without executing (the route starts the runner). */
  async prepareRunNow(uid: string, id: string): Promise<{ task: AiTask; run: AiTaskRun }> {
    const task = await this.repo.getTask(uid, id);
    if (!task) throw new AiTaskError(404, "任务不存在或无权访问");
    const running = await this.repo.findRunningRun(task.id);
    if (running) throw new AiTaskError(409, "该任务正在运行，请等待本次完成");
    const now = Date.now();
    const run: AiTaskRun = {
      id: randomUUID(),
      taskId: task.id,
      uid,
      runKey: "manual:" + randomUUID(),
      status: "queued",
      scheduledFor: now,
      createdAt: now,
    };
    await this.repo.createRun(run);
    // Lease the task so the scheduler cannot claim the same task while the
    // manual run is being prepared/executed.
    await this.repo.updateTask(uid, id, { lockedUntil: now + 10 * 60_000 });
    return { task, run };
  }

  async listRuns(uid: string, id: string, limit = 20): Promise<AiTaskRunWire[]> {
    await this.get(uid, id);
    const runs = await this.repo.listRuns(uid, id, Math.min(Math.max(limit, 1), 100));
    return runs.map((run) => runView(run, false));
  }

  async getRun(uid: string, runId: string): Promise<AiTaskRunWire> {
    const run = await this.repo.getRun(uid, runId);
    if (!run) throw new AiTaskError(404, "运行记录不存在或无权访问");
    return runView(run, true);
  }

  /** Mark a queued/running run cancelled; the runner is aborted separately by the route. */
  async cancelRun(uid: string, runId: string): Promise<AiTaskRunWire> {
    const run = await this.repo.getRun(uid, runId);
    if (!run) throw new AiTaskError(404, "运行记录不存在或无权访问");
    if (run.status === "queued" || run.status === "running") {
      const now = Date.now();
      await this.repo.updateRun(runId, {
        status: "cancelled",
        finishedAt: now,
        cancelRequestedAt: now,
        lastHeartbeatAt: now,
        error: "用户已取消本次执行",
      });
      return runView({ ...run, status: "cancelled", finishedAt: now, cancelRequestedAt: now, lastHeartbeatAt: now, error: "用户已取消本次执行" }, true);
    }
    return runView(run, true);
  }
}

export function taskView(task: AiTask): AiTaskWire {
  return {
    id: task.id,
    title: task.title,
    prompt: task.prompt,
    kind: task.kind,
    schedule: task.schedule,
    scheduleLabel: describeAiTaskSchedule(task.schedule),
    status: task.status,
    priority: priorityName(task.priority),
    notifyEmail: task.notifyEmail !== false,
    notifyPush: task.notifyPush !== false,
    ...(task.academicProjectId ? { academicProjectId: task.academicProjectId } : {}),
    ...(task.nextRunAt !== undefined ? { nextRunAt: task.nextRunAt } : {}),
    ...(task.lastRunAt !== undefined ? { lastRunAt: task.lastRunAt } : {}),
    ...(task.lastRunStatus ? { lastRunStatus: task.lastRunStatus } : {}),
    ...(task.lastRunId ? { lastRunId: task.lastRunId } : {}),
    ...(task.lastError ? { lastError: task.lastError } : {}),
    runCount: task.runCount,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

export function runView(run: AiTaskRun, includeContent: boolean): AiTaskRunWire {
  return {
    id: run.id,
    taskId: run.taskId,
    status: run.status,
    scheduledFor: run.scheduledFor,
    ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
    ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
    ...(run.lastHeartbeatAt !== undefined ? { lastHeartbeatAt: run.lastHeartbeatAt } : {}),
    ...(run.cancelRequestedAt !== undefined ? { cancelRequestedAt: run.cancelRequestedAt } : {}),
    ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    ...(run.summary ? { summary: run.summary } : {}),
    ...(run.error ? { error: run.error } : {}),
    ...(includeContent && run.content ? { content: run.content.slice(0, MAX_RUN_CONTENT) } : {}),
    createdAt: run.createdAt,
  };
}

function parsePriority(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 2) return value;
  if (typeof value === "string" && value in AI_TASK_PRIORITIES) {
    return AI_TASK_PRIORITIES[value as AiTaskPriority];
  }
  return AI_TASK_PRIORITIES.normal;
}

function priorityName(value: number | undefined): AiTaskPriority {
  if (value === AI_TASK_PRIORITIES.high) return "high";
  if (value === AI_TASK_PRIORITIES.low) return "low";
  return "normal";
}

function parseKind(value: unknown): AiTaskKind {
  if (typeof value !== "string" || !(AI_TASK_KINDS as readonly string[]).includes(value)) {
    throw new AiTaskError(422, "任务类型必须是 news、literature、report 或 custom");
  }
  return value as AiTaskKind;
}

function parseSchedule(value: unknown, now: number): AiTaskSchedule {
  const input = objectBody(value, "触发计划");
  const type = typeof input.type === "string" ? input.type : "";
  if (!(AI_TASK_SCHEDULE_TYPES as readonly string[]).includes(type)) {
    throw new AiTaskError(422, "触发类型必须是 once、daily、weekly 或 monthly");
  }
  const timezone = optionalString(input.timezone) ?? DEFAULT_TIMEZONE;
  if (!isValidAiTaskTimezone(timezone)) throw new AiTaskError(422, "时区无效");
  if (type === "once") {
    const raw = input.runAt;
    const runAt = typeof raw === "number" ? raw : typeof raw === "string" ? Date.parse(raw) : NaN;
    if (!Number.isFinite(runAt) || runAt <= now) throw new AiTaskError(422, "一次性任务的执行时间必须晚于现在");
    return { type: "once", timezone, runAt };
  }
  const time = optionalString(input.time) ?? "09:00";
  if (!parseAiTaskTime(time)) throw new AiTaskError(422, "执行时间必须是 HH:mm");
  if (type === "weekly") {
    const weekday = typeof input.weekday === "number" ? input.weekday : NaN;
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
      throw new AiTaskError(422, "每周任务必须选择星期一到星期日");
    }
    return { type: "weekly", timezone, time, weekday };
  }
  if (type === "monthly") {
    const dayOfMonth = typeof input.dayOfMonth === "number" ? input.dayOfMonth : NaN;
    if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 28) {
      throw new AiTaskError(422, "每月任务日期必须在 1-28 之间");
    }
    return { type: "monthly", timezone, time, dayOfMonth };
  }
  return { type: "daily", timezone, time };
}

function objectBody(value: unknown, label = "请求体"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AiTaskError(422, label + "必须是 JSON 对象");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.trim() === "") throw new AiTaskError(422, label + "不能为空");
  const text = value.trim();
  if (text.length > max) throw new AiTaskError(422, label + "过长（上限 " + max + " 字）");
  return text;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
