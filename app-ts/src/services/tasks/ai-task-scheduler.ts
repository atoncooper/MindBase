import { randomUUID } from "node:crypto";
import { nextAiTaskRunAt, type AiTaskRepository, type AiTaskRun } from "../../repository/ai-tasks.js";
import { tierRank } from "../../utils/membership.js";
import type { AiTaskRunner } from "./ai-task-runner.js";
import { createLogger } from "../../logger.js";

const log = createLogger("AI_TASKS");

export interface AiTaskSchedulerOptions {
  intervalMs: number;
  maxConcurrent: number;
  maxRunsPerTick: number;
  leaseMs: number;
  /** Membership lookup for the priority queue; failures degrade to free. */
  tierOf?: (uid: string) => Promise<string>;
}

/** DB-backed scheduler loop. One process claims each due slot with a lease. */
export class AiTaskScheduler {
  private timer: NodeJS.Timeout | undefined;
  private readonly running = new Set<string>();

  constructor(
    private readonly repo: AiTaskRepository,
    private readonly runner: AiTaskRunner,
    private readonly options: AiTaskSchedulerOptions,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs);
    this.timer.unref();
    void this.tick();
    log.info("[AI_TASKS] scheduler started interval=" + this.options.intervalMs + "ms");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Exposed for tests/manual tick; safe to call concurrently (claims guard). */
  async tick(): Promise<void> {
    if (this.running.size >= this.options.maxConcurrent) return;
    const now = Date.now();
    let due: Awaited<ReturnType<AiTaskRepository["listDue"]>>;
    try {
      // Scan a wider window than the concurrency cap: otherwise an early
      // low-tier task could crowd a high-tier task out of the candidate set.
      due = await this.repo.listDue(now, Math.max(this.options.maxRunsPerTick * 20, 100));
    } catch (err) {
      log.warn("[AI_TASKS] listDue failed: " + (err instanceof Error ? err.message : err));
      return;
    }
    // Priority is the user's membership tier (free lowest → ProMax highest),
    // not a per-task manual value. tierOf is cached by the membership resolver.
    if (this.options.tierOf) {
      const ranks = new Map<string, number>();
      await Promise.all(
        [...new Set(due.map((task) => task.uid))].map(async (uid) => {
          try {
            ranks.set(uid, tierRank(await this.options.tierOf!(uid)));
          } catch {
            ranks.set(uid, 0);
          }
        }),
      );
      due = [...due].sort(
        (a, b) => (ranks.get(b.uid) ?? 0) - (ranks.get(a.uid) ?? 0) ||
          (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0),
      );
    }
    for (const candidate of due) {
      if (this.running.size >= this.options.maxConcurrent) break;
      const task = await this.repo.claimTask(candidate.id, now, this.options.leaseMs);
      if (!task) continue;
      const scheduledFor = task.nextRunAt ?? now;
      const run: AiTaskRun = {
        id: randomUUID(),
        taskId: task.id,
        uid: task.uid,
        runKey: task.id + ":" + scheduledFor,
        status: "queued",
        scheduledFor,
        createdAt: now,
      };
      let created: AiTaskRun;
      try {
        created = await this.repo.createRun(run);
      } catch (err) {
        log.warn("[AI_TASKS] createRun failed task=" + task.id + ": " + (err instanceof Error ? err.message : err));
        await this.repo.updateTask(task.uid, task.id, { lockedUntil: null });
        continue;
      }
      // A restart/duplicate slot: never re-run a completed or still-live slot.
      // createRun returns the existing row for the same (taskId, runKey).
      if (created.id !== run.id || created.status !== "queued") {
        const stamp = created.lastHeartbeatAt ?? created.startedAt ?? created.createdAt;
        if ((created.status === "running" || created.status === "queued") && now - stamp < this.options.leaseMs) {
          // A live runner owns this task; keep the lease so we don't duplicate it.
          await this.repo.updateTask(task.uid, task.id, { lockedUntil: now + this.options.leaseMs });
          continue;
        }
        if (created.status === "running" || created.status === "queued") {
          await this.repo.updateRun(created.id, {
            status: "failed",
            finishedAt: now,
            error: "执行器心跳超时，已回收本次运行",
          });
        }
        const nextRunAt = task.schedule.type === "once" ? null : nextAiTaskRunAt(task.schedule, now);
        await this.repo.updateTask(task.uid, task.id, {
          lockedUntil: null,
          nextRunAt,
          ...(task.schedule.type === "once" ? { status: "completed" as const } : {}),
        });
        continue;
      }
      this.running.add(task.id);
      void this.runner
        .run(task, created)
        .catch(async (err) => {
          log.warn("[AI_TASKS] runner failed task=" + task.id + ": " + (err instanceof Error ? err.message : err));
          await this.repo
            .updateTask(task.uid, task.id, {
              lockedUntil: null,
              lastError: err instanceof Error ? err.message.slice(0, 500) : String(err),
            })
            .catch(() => undefined);
        })
        .finally(() => this.running.delete(task.id));
    }
  }
}
