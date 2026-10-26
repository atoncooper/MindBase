import { z } from "zod";
import { defineTool } from "../base.js";
import type { PlanSnapshot, PlanStepStatus, PlanStepView } from "../../context/types.js";

/**
 * plan: task planning / checkpoints for complex multi-step tasks.
 *
 * Mirrors the desktop PlanState/apply_plan state machine (see
 * mind-base-desktop/src-tauri/src/harness/mod.rs) adapted to the Web server:
 * the plan is a per-chat-session runtime state machine, never a persisted document.
 * It lives in a process-local Map keyed by chatSessionId with a TTL and a hard
 * session cap, so a long-lived process cannot leak memory across sessions.
 *
 * The tool returns the rendered plan as the LLM-facing text and registers the
 * snapshot on ctx.collector; the ReAct loop (agent/react.ts) emits a plan SSE
 * frame at every step boundary where the version changed. The frame is read-only
 * display: the frontend keeps it in memory for the current turn, nothing is
 * persisted and there is no resume protocol (same nature as reasoning streams).
 *
 * Deliberate differences from the desktop implementation:
 *  - create (re)initializes the plan and bumps the version instead of rejecting a
 *    duplicate create: the store is keyed by chat session and one session serves
 *    many user requests, so a new complex request must start a fresh plan.
 *  - every successful mutation bumps version (desktop bumps on revise only), so
 *    the stream can dedupe/replay plan frames by version at step boundaries.
 *  - revise requires an explicit reason (the desktop only logs it when present).
 */
export const PLAN_MAX_STEPS = 6;
export const PLAN_REVISE_LIMIT = 3;
/** A plan left untouched this long is dropped (state is display-only). */
export const DEFAULT_PLAN_TTL_MS = 2 * 60 * 60 * 1000;
/** Hard cap on concurrently tracked chat sessions (oldest is evicted). */
export const DEFAULT_PLAN_MAX_SESSIONS = 500;

export const PLAN_STATUSES: readonly PlanStepStatus[] = [
  "pending",
  "in_progress",
  "done",
  "failed",
  "skipped",
];

const PLAN_MARK: Record<PlanStepStatus, string> = {
  pending: "·",
  in_progress: "▶",
  done: "✓",
  failed: "✗",
  skipped: "⊘",
};

/** One plan-tool call (the model-controlled arguments). */
export interface PlanToolInput {
  action: "create" | "update" | "revise";
  steps?: string[];
  step?: number;
  status?: PlanStepStatus;
  note?: string;
  reason?: string;
}

export type PlanMutationResult = { ok: true; snapshot: PlanSnapshot } | { ok: false; error: string };

export interface PlanStoreOptions {
  /** idle TTL in ms (default 2h) */
  ttlMs?: number;
  /** max tracked chat sessions (default 500) */
  maxSessions?: number;
  /** clock injection for TTL tests */
  now?: () => number;
}

interface PlanRecord {
  version: number;
  /** count of successful revisions (capped at PLAN_REVISE_LIMIT) */
  replans: number;
  steps: PlanStepView[];
  updatedAt: number;
}

function normalizeSteps(steps: string[] | undefined): PlanStepView[] {
  const out: PlanStepView[] = [];
  for (const raw of steps ?? []) {
    if (typeof raw !== "string") continue;
    const desc = raw.trim();
    if (!desc) continue;
    out.push({ desc, status: "pending", note: "" });
    // desktop guidance is 3-6 steps: anything beyond is silently truncated
    if (out.length >= PLAN_MAX_STEPS) break;
  }
  return out;
}

function snapshotOf(record: PlanRecord): PlanSnapshot {
  const steps = record.steps.map((step) => ({ desc: step.desc, status: step.status, note: step.note }));
  const done = steps.filter((step) => step.status === "done" || step.status === "skipped").length;
  return { version: record.version, steps, done, total: steps.length };
}

/** Render the plan as the text the model reads back after every mutation. */
export function renderPlan(snapshot: PlanSnapshot): string {
  const lines = [
    "【任务计划 v" + snapshot.version + " · 第 " + snapshot.done + "/" + snapshot.total + " 步完成】",
  ];
  snapshot.steps.forEach((step, index) => {
    const mark = PLAN_MARK[step.status] ?? "·";
    const line = mark + " " + (index + 1) + ". " + step.desc;
    lines.push(step.note ? line + " —— " + step.note : line);
  });
  return lines.join("\n");
}

/**
 * Process-local plan state machine keyed by chatSessionId.
 * Never throws on bad model input: invalid calls come back as {ok:false, error}
 * text so the ReAct loop keeps going.
 */
export class PlanStore {
  private readonly plans = new Map<string, PlanRecord>();
  private readonly ttlMs: number;
  private readonly maxSessions: number;
  private readonly now: () => number;

  constructor(opts: PlanStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_PLAN_TTL_MS;
    this.maxSessions = Math.max(1, opts.maxSessions ?? DEFAULT_PLAN_MAX_SESSIONS);
    this.now = opts.now ?? Date.now;
  }

  /** number of tracked sessions (expired entries are dropped lazily) */
  get size(): number {
    return this.plans.size;
  }

  /** Current snapshot for a session; expired entries are dropped on read. */
  get(chatSessionId: string): PlanSnapshot | undefined {
    const record = this.plans.get(chatSessionId);
    if (!record) return undefined;
    if (this.expired(record)) {
      this.plans.delete(chatSessionId);
      return undefined;
    }
    return snapshotOf(record);
  }

  clear(chatSessionId: string): void {
    this.plans.delete(chatSessionId);
  }

  /** Drop every expired plan; returns the number removed (TTL housekeeping). */
  purge(): number {
    let removed = 0;
    for (const [key, record] of this.plans) {
      if (this.expired(record)) {
        this.plans.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** Handle one plan-tool call against the session's plan state machine. */
  apply(chatSessionId: string, input: PlanToolInput): PlanMutationResult {
    const current = this.plans.get(chatSessionId);
    const existing = current && !this.expired(current) ? current : undefined;
    if (!existing) this.plans.delete(chatSessionId);

    switch (input.action) {
      case "create": {
        const steps = normalizeSteps(input.steps);
        if (steps.length === 0) {
          return { ok: false, error: "steps 不能为空（每项为一步的描述，建议 3-6 步）" };
        }
        return {
          ok: true,
          snapshot: this.save(chatSessionId, {
            version: (existing?.version ?? 0) + 1,
            replans: 0,
            steps,
            updatedAt: this.now(),
          }),
        };
      }
      case "update": {
        if (!existing) return { ok: false, error: "尚未创建计划（先用 action=create）" };
        const no = typeof input.step === "number" ? input.step : Number(input.step);
        if (!Number.isInteger(no) || no < 1 || no > existing.steps.length) {
          return {
            ok: false,
            error: "步骤编号无效：" + String(input.step ?? "") + "（1-" + existing.steps.length + "）",
          };
        }
        // desktop parity: status defaults to done when the model omits it
        const status = input.status ?? "done";
        if (!PLAN_STATUSES.includes(status)) {
          return {
            ok: false,
            error: "未知状态 " + String(status) + "（pending|in_progress|done|failed|skipped）",
          };
        }
        const step = existing.steps[no - 1]!;
        step.status = status;
        step.note = typeof input.note === "string" ? input.note.trim() : "";
        existing.version += 1;
        return { ok: true, snapshot: this.save(chatSessionId, existing) };
      }
      case "revise": {
        if (!existing) return { ok: false, error: "尚未创建计划（先用 action=create）" };
        if (existing.replans >= PLAN_REVISE_LIMIT) {
          return {
            ok: false,
            error:
              "计划修订次数已达上限（" +
              PLAN_REVISE_LIMIT +
              " 次）。请基于当前计划继续执行，或直接总结已完成的产出。",
          };
        }
        const reason = typeof input.reason === "string" ? input.reason.trim() : "";
        if (!reason) {
          return {
            ok: false,
            error: "revise 需要 reason：说明本次修订的原因（哪一步失败、为何调整后续步骤）",
          };
        }
        const steps = normalizeSteps(input.steps);
        if (steps.length === 0) {
          return { ok: false, error: "steps 不能为空（每项为一步的描述，建议 3-6 步）" };
        }
        existing.replans += 1;
        existing.version += 1;
        existing.steps = steps;
        return { ok: true, snapshot: this.save(chatSessionId, existing) };
      }
      default: {
        const action = String((input as { action?: unknown }).action ?? "");
        return {
          ok: false,
          error: "未知 action：" + action + "（可用：create 创建计划 / update 更新步骤状态 / revise 修订计划）",
        };
      }
    }
  }

  private expired(record: PlanRecord): boolean {
    return this.now() - record.updatedAt >= this.ttlMs;
  }

  /** Persist a record, evicting the oldest plan when the session cap is reached. */
  private save(chatSessionId: string, record: PlanRecord): PlanSnapshot {
    record.updatedAt = this.now();
    this.purge();
    if (!this.plans.has(chatSessionId) && this.plans.size >= this.maxSessions) {
      let oldestKey: string | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [key, candidate] of this.plans) {
        if (candidate.updatedAt < oldestAt) {
          oldestAt = candidate.updatedAt;
          oldestKey = key;
        }
      }
      if (oldestKey !== undefined) this.plans.delete(oldestKey);
    }
    this.plans.set(chatSessionId, record);
    return snapshotOf(record);
  }
}

const planInputSchema = z.object({
  action: z
    .enum(["create", "update", "revise"])
    .describe("create=创建计划；update=更新某一步的状态；revise=某步失败后修订计划"),
  steps: z
    .array(z.string().max(200))
    .optional()
    .describe("步骤描述列表（create/revise 时必填；建议 3-6 步，超过 6 步会被截断，空项忽略）"),
  step: z.number().int().min(1).optional().describe("步骤编号（update 时必填，1 起）"),
  status: z
    .enum(["pending", "in_progress", "done", "failed", "skipped"])
    .optional()
    .describe("步骤状态（update 时使用，缺省 done）"),
  note: z.string().max(300).optional().describe("备注（如失败原因、完成说明），update 时写入该步"),
  reason: z.string().max(300).optional().describe("修订原因（revise 时必填）"),
});

/**
 * createPlanTool: registered on the main agent only (see bootstrap/container.ts and
 * agent/main/agent.ts toolNames). Sub-agents see their own task scope and do not plan.
 */
export function createPlanTool(store: PlanStore = new PlanStore()) {
  return defineTool({
    name: "plan",
    description:
      "创建与维护任务计划（复杂任务的多步规划与检查点）。" +
      "action=create：把目标拆解为 3-6 个可检查的步骤并创建计划；" +
      "action=update：更新某一步的状态（in_progress/done/failed/skipped），每完成一步即形成检查点；" +
      "action=revise：某步失败后修订计划（需 reason），修订最多 3 次。" +
      "计划状态会实时展示给用户，复杂任务开始时先创建计划；简单任务不要用。",
    inputSchema: planInputSchema,
    async execute(args, ctx) {
      // plans are scoped to the chat session (anonymous fallback for direct/OpenAI-compat runs)
      const result = store.apply(ctx.chatSessionId ?? "anonymous", args as PlanToolInput);
      if (!result.ok) return result.error;
      ctx.collector.setPlan(result.snapshot);
      return renderPlan(result.snapshot);
    },
  });
}
