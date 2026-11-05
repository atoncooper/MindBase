import { config } from "../config/index.js";
import { createLogger } from "../logger.js";
import { InternalServiceClient } from "../transport/internal-client.js";

const log = createLogger("APP_TASK");

/**
 * Client for the app-task scheduler service (Go, external repo): task
 * registration, quiz delivery email, and executor completion callbacks.
 * All calls go through the APISIX key-auth internal routes (apikey header),
 * mirroring the app-pay / app-quiz internal clients.
 */

export class AppTaskError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface RegisterTaskResult {
  task_id: string;
  status: string;
}

export class AppTaskClient extends InternalServiceClient {
  constructor(opts?: { baseUrl?: string; apiKey?: string; timeoutMs?: number }) {
    super(
      {
        baseUrl: opts?.baseUrl ?? config.appTask.baseUrl,
        apiKey: opts?.apiKey ?? config.appTask.apiKey,
        timeoutMs: opts?.timeoutMs ?? config.appTask.timeoutMs,
      },
      "app-task",
    );
  }

  protected override error(message: string, status?: number): Error {
    return new AppTaskError(status ?? 0, message);
  }

  /** POST /tasks/register (service-to-service key-auth). */
  async registerTask(body: Record<string, unknown>): Promise<RegisterTaskResult> {
    const res = await this.request("POST", "/tasks/register", body);
    return this.json<RegisterTaskResult>(res, "app-task register failed");
  }

  /**
   * GET /tasks?domain=… — scheduler list (the shape is an array in practice;
   * envelope keys are tolerated defensively). Only status + payload surface
   * here — the task-quiz active-task cap counts a user's pending/running rows.
   */
  async listTasks(domain?: string): Promise<Array<{ status: string; payload: Record<string, unknown> }>> {
    const res = await this.request("GET", domain ? `/tasks?domain=${encodeURIComponent(domain)}` : "/tasks");
    const json = await this.json<unknown>(res, "app-task list failed");
    const rows = Array.isArray(json)
      ? json
      : ((json as { tasks?: unknown[] }).tasks ?? (json as { data?: unknown[] }).data ?? []);
    return rows.map((row) => {
      const r = (row && typeof row === "object" ? row : {}) as { status?: unknown; payload?: unknown };
      return {
        status: typeof r.status === "string" ? r.status : "",
        payload: (r.payload && typeof r.payload === "object" ? r.payload : {}) as Record<string, unknown>,
      };
    });
  }

  /** GET /tasks/{task_id} (scheduler view + logs). */
  async taskDetail(taskId: string): Promise<unknown> {
    const res = await this.request("GET", `/tasks/${encodeURIComponent(taskId)}`);
    return this.json<unknown>(res, "app-task detail failed");
  }

  /** POST /internal/email/send — quiz delivery mail (best-effort by callers). */
  async sendEmail(body: { to: string[]; cc: string[]; subject: string; html: string; reference_id: string }): Promise<void> {
    const res = await this.request("POST", "/internal/email/send", body);
    await this.json<unknown>(res, "app-task email failed");
  }

  /** POST /internal/task/{task_id}/complete — executor completion report. */
  async completeTask(taskId: string, status: "completed" | "failed", result: string, error: string): Promise<void> {
    const res = await this.request("POST", `/internal/task/${encodeURIComponent(taskId)}/complete`, {
      status,
      result,
      error,
    });
    await this.json<unknown>(res, "app-task complete failed");
  }
}

/** Fire-and-forget wrapper — app-task callbacks must never break the main flow. */
export function bestEffort(promise: Promise<void>, what: string): void {
  promise.catch((err) => {
    log.warn(`[${what}] failed (ignored): ${err instanceof Error ? err.message : err}`);
  });
}
