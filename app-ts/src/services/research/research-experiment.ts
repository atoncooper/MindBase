import { createHash, randomUUID } from "node:crypto";
import type { CodeExecutionPort } from "../../tools/code/code-execution.js";
import type { AcademicEventRepository } from "../../repository/academic.js";
import type {
  ResearchExperiment,
  ResearchExperimentArtifact,
  ResearchExperimentRepository,
} from "../../repository/research-experiments.js";
import { config } from "../../config/index.js";
import { createLogger } from "../../logger.js";

const log = createLogger("EXPERIMENT");
const PREVIEW_LIMIT = 8000;

export interface SubmitExperimentInput {
  uid: string;
  projectId: string;
  chatSessionId?: string;
  workspaceId?: string;
  title?: string;
  language: string;
  code: string;
  timeoutMs: number;
  approvalId?: string;
}

export type ExperimentCallback = (exp: ResearchExperiment) => Promise<void>;

/** Raised when the per-user experiment queue is full (tool renders it as guidance). */
export class ResearchExperimentQueueFullError extends Error {
  readonly code = "queue_full";
  constructor(readonly maxQueued: number) {
    super("实验排队已满（当前上限 " + maxQueued + " 个未完成实验），请等待已有实验完成后再提交。");
    this.name = "ResearchExperimentQueueFullError";
  }
}

/** Raised when an identical experiment is already queued/running (dedupe window). */
export class ResearchExperimentDuplicateError extends Error {
  readonly code = "duplicate";
  constructor(readonly existingId: string) {
    super("已有相同的实验正在排队/运行（experiment_id=" + existingId + "），本次不重复提交。");
    this.name = "ResearchExperimentDuplicateError";
  }
}

/** 后台科研实验执行器：队列、去重、取消、产物、回调与审计事件。 */
export class ResearchExperimentRunner {
  private readonly running = new Map<string, AbortController>();
  /** FIFO queue of rows waiting for a worker slot. */
  private readonly queue: ResearchExperiment[] = [];
  private active = 0;
  private callback?: ExperimentCallback;
  private artifactSink?: (exp: ResearchExperiment) => Promise<void>;
  /** per-uid per-day callback counter (cost guard; resets by local calendar day) */
  private readonly callbackCounts = new Map<string, { day: string; count: number }>();

  constructor(
    private readonly repo: ResearchExperimentRepository,
    private readonly execution: CodeExecutionPort,
    private readonly maxConcurrent = config.academic.experiments.maxConcurrent,
    private readonly events?: Pick<AcademicEventRepository, "append">,
  ) {}

  setCallback(callback: ExperimentCallback): void {
    this.callback = callback;
  }

  /** Optional sink: upload stdout/stderr/artifacts and record evidence before the AI callback. */
  setArtifactSink(sink: (exp: ResearchExperiment) => Promise<void>): void {
    this.artifactSink = sink;
  }

  /** Side-effect-free admission check, so callers can validate BEFORE spending an approval. */
  async preflight(input: Pick<SubmitExperimentInput, "uid" | "projectId" | "language" | "code">): Promise<void> {
    const limits = config.academic.experiments;
    if (this.queue.length + this.active >= Math.max(1, limits.maxQueued)) {
      throw new ResearchExperimentQueueFullError(limits.maxQueued);
    }
    const dedupeKey = dedupeKeyOf(input);
    const duplicate = (await this.repo.listByUid(input.uid, input.projectId, 100)).find(
      (row) =>
        row.dedupeKey === dedupeKey &&
        (row.status === "queued" || row.status === "running") &&
        Date.now() - row.createdAt <= Math.max(0, limits.dedupeWindowMs),
    );
    if (duplicate) throw new ResearchExperimentDuplicateError(duplicate.id);
  }

  async submit(input: SubmitExperimentInput): Promise<ResearchExperiment> {
    await this.preflight(input);
    const dedupeKey = dedupeKeyOf(input);
    const exp: ResearchExperiment = {
      id: randomUUID(),
      uid: input.uid,
      projectId: input.projectId,
      ...(input.chatSessionId ? { chatSessionId: input.chatSessionId } : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.title ? { title: input.title } : {}),
      language: input.language,
      code: input.code,
      timeoutMs: Math.max(1000, input.timeoutMs),
      ...(input.approvalId ? { approvalId: input.approvalId } : {}),
      dedupeKey,
      status: "queued",
      createdAt: Date.now(),
    };
    await this.repo.create(exp);
    this.queue.push(exp);
    await this.emit(exp, "experiment.queued", { title: exp.title ?? "", language: exp.language });
    this.pump();
    return exp;
  }

  async get(id: string): Promise<ResearchExperiment | undefined> {
    return this.repo.get(id);
  }

  async list(uid: string, projectId?: string, limit = 20): Promise<ResearchExperiment[]> {
    return this.repo.listByUid(uid, projectId, limit);
  }

  /**
   * Cancel a queued experiment (removed from the FIFO) or abort a running one.
   * A row left queued by a previous process is also cancelled.
   */
  async cancel(id: string): Promise<boolean> {
    const queuedIndex = this.queue.findIndex((item) => item.id === id);
    if (queuedIndex >= 0) {
      const [exp] = this.queue.splice(queuedIndex, 1);
      exp.status = "cancelled";
      exp.endedAt = Date.now();
      await this.repo.save(exp);
      await this.emit(exp, "experiment.cancelled", { reason: "queued_cancelled" });
      await this.notify(exp);
      return true;
    }
    const controller = this.running.get(id);
    if (controller) {
      controller.abort();
      return true;
    }
    // Not in memory (e.g. queued before a restart) but persisted as unfinished.
    const exp = await this.repo.get(id);
    if (exp && (exp.status === "queued" || exp.status === "running")) {
      exp.status = "cancelled";
      exp.endedAt = Date.now();
      await this.repo.save(exp);
      await this.emit(exp, "experiment.cancelled", { reason: "orphan_cancelled" });
      await this.notify(exp);
      return true;
    }
    return false;
  }

  /** Mark runs left queued/running by a previous process as interrupted. */
  async reconcileInterrupted(): Promise<number> {
    const rows = await this.repo.listUnfinished();
    for (const exp of rows) {
      exp.status = "interrupted";
      exp.error = "app-ts restarted while the experiment was waiting/running";
      exp.endedAt = Date.now();
      await this.repo.save(exp);
      await this.emit(exp, "experiment.interrupted", {});
      await this.notify(exp);
    }
    if (rows.length > 0) log.warn("[EXPERIMENT] marked interrupted after boot count=" + rows.length);
    return rows.length;
  }

  private pump(): void {
    while (this.active < Math.max(1, this.maxConcurrent) && this.queue.length > 0) {
      const exp = this.queue.shift()!;
      this.active += 1;
      void this.execute(exp).finally(() => {
        this.active = Math.max(0, this.active - 1);
        this.pump();
      });
    }
  }

  private async execute(exp: ResearchExperiment): Promise<void> {
    const controller = new AbortController();
    this.running.set(exp.id, controller);
    exp.status = "running";
    exp.startedAt = Date.now();
    await this.repo.save(exp);
    await this.emit(exp, "experiment.started", {});
    try {
      const result = await this.execution.run(
        {
          language: exp.language,
          code: exp.code,
          timeoutMs: exp.timeoutMs,
          uid: exp.uid,
        },
        controller.signal,
      );
      exp.exitCode = result.exitCode;
      exp.stdoutPreview = (result.stdout ?? "").slice(0, PREVIEW_LIMIT);
      exp.stderrPreview = (result.stderr ?? "").slice(0, PREVIEW_LIMIT);
      if (result.artifacts && result.artifacts.length > 0) {
        exp.artifacts = result.artifacts.map((artifact): ResearchExperimentArtifact => ({
          name: artifact.name,
          ...(artifact.sizeBytes !== undefined ? { sizeBytes: artifact.sizeBytes } : {}),
          ...(artifact.sha256 ? { sha256: artifact.sha256 } : {}),
          ...(artifact.url ? { url: artifact.url } : {}),
        }));
      }
      exp.status = result.ok
        ? "succeeded"
        : result.error?.includes("取消") || controller.signal.aborted
          ? "interrupted"
          : "failed";
      if (!result.ok && result.error) exp.error = result.error;
    } catch (err) {
      exp.status = controller.signal.aborted ? "interrupted" : "failed";
      exp.error = err instanceof Error ? err.message : String(err);
    } finally {
      exp.endedAt = Date.now();
      this.running.delete(exp.id);
      await this.repo.save(exp);
      await this.emit(exp, "experiment.finished", {
        status: exp.status,
        exitCode: exp.exitCode ?? null,
        artifacts: exp.artifacts?.length ?? 0,
      });
      log.info("[EXPERIMENT] finished id=" + exp.id + " status=" + exp.status + " exit=" + String(exp.exitCode ?? "?"));
      if (this.artifactSink) {
        try {
          await this.artifactSink(exp);
        } catch (err) {
          log.warn("[EXPERIMENT] artifact sink failed id=" + exp.id + ": " + (err instanceof Error ? err.message : err));
        }
      }
      await this.notify(exp);
    }
  }

  /**
   * Trigger the completion callback at most once per experiment and at most
   * callbackDailyLimit times per uid/day (cost guard). The persisted
   * callbackNotifiedAt flag makes the guard survive a process restart.
   */
  private async notify(exp: ResearchExperiment): Promise<void> {
    if (!this.callback) return;
    if (exp.callbackNotifiedAt !== undefined) return;
    const limit = config.academic.experiments.callbackDailyLimit;
    if (limit > 0) {
      const day = new Date().toISOString().slice(0, 10);
      const counter = this.callbackCounts.get(exp.uid);
      const next = counter && counter.day === day ? counter.count + 1 : 1;
      if (next > limit) {
        log.warn("[EXPERIMENT] callback daily limit reached uid=" + exp.uid + " limit=" + limit);
        return;
      }
      this.callbackCounts.set(exp.uid, { day, count: next });
    }
    exp.callbackNotifiedAt = Date.now();
    try {
      await this.repo.save(exp);
    } catch (err) {
      log.warn("[EXPERIMENT] callback flag persist failed id=" + exp.id + ": " + (err instanceof Error ? err.message : err));
    }
    try {
      await this.callback(exp);
      await this.emit(exp, "experiment.callback", { status: exp.status });
    } catch (err) {
      log.warn("[EXPERIMENT] callback failed id=" + exp.id + ": " + (err instanceof Error ? err.message : err));
    }
  }

  private async emit(exp: ResearchExperiment, type: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.events) return;
    try {
      await this.events.append(exp.uid, exp.projectId, type, { experimentId: exp.id, ...payload }, "agent");
    } catch (err) {
      log.warn("[EXPERIMENT] event append failed type=" + type + " id=" + exp.id + ": " + (err instanceof Error ? err.message : err));
    }
  }
}

function dedupeKeyOf(input: Pick<SubmitExperimentInput, "uid" | "projectId" | "language" | "code">): string {
  const hash = createHash("sha256");
  hash.update(input.uid);
  hash.update("\u0000");
  hash.update(input.projectId);
  hash.update("\u0000");
  hash.update(input.language);
  hash.update("\u0000");
  hash.update(input.code);
  return hash.digest("hex");
}
