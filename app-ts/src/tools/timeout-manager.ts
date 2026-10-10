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
  | { ok: false; timedOut: true; budgetMs: number };

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

  /** Run `fn` under a budget. Aborts + deletes the entry on expiry; cleans up on settle. */
  async run<T>(
    label: string,
    requestedMs: number | undefined,
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<TimeoutOutcome<T>> {
    const budgetMs = this.resolveBudget(requestedMs);
    const controller = new AbortController();
    const id = randomUUID();
    const entry = {
      id,
      label,
      startedAt: Date.now(),
      budgetMs,
      timer: setTimeout(() => {
        controller.abort();
        this.active.delete(id);
        log.warn(`[TIMEOUT] ${label} aborted after ${budgetMs}ms (id=${id.slice(0, 8)})`);
      }, budgetMs),
    };
    this.active.set(id, entry);
    try {
      const value = await fn(controller.signal);
      return { ok: true, value, budgetMs };
    } catch (err) {
      // an aborted signal usually surfaces as an AbortError; keep it recognizable
      if (controller.signal.aborted) {
        return { ok: false, timedOut: true, budgetMs };
      }
      throw err;
    } finally {
      clearTimeout(entry.timer);
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
