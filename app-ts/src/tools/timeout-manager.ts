import { randomUUID } from "node:crypto";
import { config } from "../config/index.js";
import { createLogger } from "../logger.js";

const log = createLogger("TIMEOUT");

/**
 * Central timeout manager: ONE place owns tool-execution budgets.
 *
 * - The model may pass `timeoutMs` per call (e.g. 30s, 60s, 30min); the manager clamps
 *   it to [minTimeoutMs, maxTimeoutMs] — never more than 1 hour — and falls back to the
 *   default budget when omitted. Tools never manage their own timers (no 自治).
 * - Each run gets an AbortController: on timeout the signal aborts (real cancellation
 *   for signal-aware I/O), the entry is removed from the active table ("超时则删除"),
 *   and the outcome is reported so the runtime can guide the model.
 * - HARD BUDGET: the run races the tool promise against the abort signal, so a tool
 *   that ignores its signal can never hang a ReAct step forever (it keeps running in
 *   the background, but the loop gets control back immediately).
 * - External cancellation: an optional caller signal (client disconnect / turn abort)
 *   aborts the same controller and is reported as `aborted` (not as a timeout) so the
 *   runtime does not blame the tool's breaker.
 * - The active table is observable (/agent/runtime) and self-cleans on settle.
 */
export interface TimeoutTicket {
  id: string;
  label: string;
  startedAt: number;
  budgetMs: number;
  remainingMs: number;
}

export type TimeoutOutcome<T> =
  | { ok: true; value: T; budgetMs: number }
  | { ok: false; timedOut: boolean; aborted: boolean; budgetMs: number };

export class TimeoutManager {
  private readonly active = new Map<
    string,
    { id: string; label: string; startedAt: number; budgetMs: number; timer: NodeJS.Timeout }
  >();

  /** Clamp a requested budget: undefined → default; out-of-range → min/max (1h ceiling). */
  resolveBudget(requestedMs: number | undefined): number {
    const { defaultTimeoutMs, minTimeoutMs, maxTimeoutMs } = config.tools;
    if (requestedMs === undefined || !Number.isFinite(requestedMs)) return defaultTimeoutMs;
    return Math.min(Math.max(Math.floor(requestedMs), minTimeoutMs), maxTimeoutMs);
  }

  /**
   * Run `fn` under a budget. On expiry (or external abort) the controller aborts,
   * the entry is deleted, and the outcome is reported immediately — even if `fn`
   * never settles.
   */
  async run<T>(
    label: string,
    requestedMs: number | undefined,
    fn: (signal: AbortSignal) => Promise<T>,
    externalSignal?: AbortSignal,
  ): Promise<TimeoutOutcome<T>> {
    const budgetMs = this.resolveBudget(requestedMs);
    const controller = new AbortController();
    const id = randomUUID();
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      this.active.delete(id);
      log.warn(`[TIMEOUT] ${label} aborted after ${budgetMs}ms (id=${id.slice(0, 8)})`);
    }, budgetMs);

    const onExternalAbort = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }

    const entry = { id, label, startedAt: Date.now(), budgetMs, timer };
    this.active.set(id, entry);

    // Reject as soon as the controller aborts, whichever cause fired first.
    const abortPromise = new Promise<never>((_resolve, reject) => {
      const fail = () => reject(new Error(`${label} aborted`));
      if (controller.signal.aborted) fail();
      else controller.signal.addEventListener("abort", fail, { once: true });
    });
    // The race consumer handles one branch; swallow the loser so a late rejection
    // (or a late success after a timeout) is never an unhandled rejection.
    abortPromise.catch(() => undefined);

    const work: Promise<T> = Promise.resolve().then(() => fn(controller.signal));
    work.catch(() => undefined);

    try {
      const value = await Promise.race([work, abortPromise]);
      return { ok: true, value, budgetMs };
    } catch (err) {
      if (controller.signal.aborted) {
        return { ok: false, timedOut, aborted: !timedOut, budgetMs };
      }
      throw err;
    } finally {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
      this.active.delete(id);
    }
  }

  /** Observability snapshot for /agent/runtime. */
  list(): TimeoutTicket[] {
    const now = Date.now();
    return [...this.active.values()].map((e) => ({
      id: e.id,
      label: e.label,
      startedAt: e.startedAt,
      budgetMs: e.budgetMs,
      remainingMs: Math.max(0, e.startedAt + e.budgetMs - now),
    }));
  }

  get size(): number {
    return this.active.size;
  }
}

export const timeoutManager = new TimeoutManager();
