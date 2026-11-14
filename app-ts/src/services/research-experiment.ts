import { randomUUID } from "node:crypto";
import type { CodeExecutionPort } from "../tools/code/code-execution.js";
import type { ResearchExperiment, ResearchExperimentRepository } from "../repository/research-experiments.js";
import { createLogger } from "../logger.js";

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
}

export type ExperimentCallback = (exp: ResearchExperiment) => Promise<void>;

/**
 * Persistent research experiment runner.
 *
 * submit() returns immediately after persisting a queued row; a background
 * promise executes the sandbox and persists the terminal state. On completion
 * (or boot-time interruption) the injected callback starts the next AI turn
 * instead of making the model poll.
 */
export class ResearchExperimentRunner {
  private readonly running = new Map<string, AbortController>();
  private readonly semaphore: Array<() => void> = [];
  private active = 0;
  private callback?: ExperimentCallback;
  private artifactSink?: (exp: ResearchExperiment) => Promise<void>;

  constructor(
    private readonly repo: ResearchExperimentRepository,
    private readonly execution: CodeExecutionPort,
    private readonly maxConcurrent = 2,
  ) {}

  setCallback(callback: ExperimentCallback): void {
    this.callback = callback;
  }

  /** Optional sink: upload stdout/stderr and record evidence before the AI callback. */
  setArtifactSink(sink: (exp: ResearchExperiment) => Promise<void>): void {
    this.artifactSink = sink;
  }

  async submit(input: SubmitExperimentInput): Promise<ResearchExperiment> {
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
      status: "queued",
      createdAt: Date.now(),
    };
    await this.repo.create(exp);
    void this.schedule(exp);
    return exp;
  }

  async get(id: string): Promise<ResearchExperiment | undefined> {
    return this.repo.get(id);
  }

  async list(uid: string, projectId?: string, limit = 20): Promise<ResearchExperiment[]> {
    return this.repo.listByUid(uid, projectId, limit);
  }

  async cancel(id: string): Promise<boolean> {
    const controller = this.running.get(id);
    if (!controller) return false;
    controller.abort();
    const exp = await this.repo.get(id);
    if (exp && (exp.status === "queued" || exp.status === "running")) {
      exp.status = "cancelled";
      exp.endedAt = Date.now();
      await this.repo.save(exp);
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
      exp.error = "app-ts restarted while the experiment was running";
      exp.endedAt = Date.now();
      await this.repo.save(exp);
      await this.notify(exp);
    }
    if (rows.length > 0) log.warn("[EXPERIMENT] marked interrupted after boot count=" + rows.length);
    return rows.length;
  }

  private async schedule(exp: ResearchExperiment): Promise<void> {
    await this.acquire();
    void this.execute(exp).finally(() => this.release());
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.semaphore.push(resolve));
  }

  private release(): void {
    const next = this.semaphore.shift();
    if (next) next();
    else this.active = Math.max(0, this.active - 1);
  }

  private async execute(exp: ResearchExperiment): Promise<void> {
    const controller = new AbortController();
    this.running.set(exp.id, controller);
    exp.status = "running";
    exp.startedAt = Date.now();
    await this.repo.save(exp);
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
      exp.status = result.ok ? "succeeded" : result.error?.includes("取消") || controller.signal.aborted ? "interrupted" : "failed";
      if (!result.ok && result.error) exp.error = result.error;
    } catch (err) {
      exp.status = controller.signal.aborted ? "interrupted" : "failed";
      exp.error = err instanceof Error ? err.message : String(err);
    } finally {
      exp.endedAt = Date.now();
      this.running.delete(exp.id);
      await this.repo.save(exp);
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

  private async notify(exp: ResearchExperiment): Promise<void> {
    if (!this.callback) return;
    try {
      await this.callback(exp);
    } catch (err) {
      log.warn("[EXPERIMENT] callback failed id=" + exp.id + ": " + (err instanceof Error ? err.message : err));
    }
  }
}
