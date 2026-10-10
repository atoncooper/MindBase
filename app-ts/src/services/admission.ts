import { config } from "../config/index.js";

/**
 * Turn-level weighted admission queue for chat (`scheduling.*` config).
 *
 * Caps how many chat turns execute at once; when the limit is reached, new
 * turns enter a bounded waiting queue and are dequeued by **weighted
 * priority**: higher membership tiers first (`tierWeights`), with aging so
 * long-waiting low-tier requests are not starved. Waiting past
 * `queueTimeoutMs` → `QueueTimeoutError`; a full queue → `QueueFullError`
 * (immediate reject, no enqueue).
 *
 * Layering note: this gates *turns* (one slot per chat turn). The tool-level
 * fan-out gate (`tools/concurrency.ts` Semaphore, `tools.maxConcurrent`)
 * sits underneath it and is unaffected.
 *
 * In-memory by design: the service runs as a single process; the queue and
 * its limits are per-process (see the tool-gate precedent). Revisit only if
 * multi-instance deployment lands.
 */

export class QueueFullError extends Error {
  constructor(readonly waiting: number, readonly maxSize: number) {
    super(`admission queue full (${waiting}/${maxSize})`);
    this.name = "QueueFullError";
  }
}

export class QueueTimeoutError extends Error {
  constructor(readonly waitedMs: number) {
    super(`admission queue wait exceeded ${waitedMs}ms`);
    this.name = "QueueTimeoutError";
  }
}

export interface AdmissionQueueOptions {
  maxConcurrent: number;
  queueMaxSize: number;
  tierWeights: Record<string, number>;
  agingWindowMs: number;
  agingStep: number;
}

export interface AdmissionStats {
  active: number;
  maxConcurrent: number;
  queueLen: number;
  queueMaxSize: number;
  waitingByTier: Record<string, number>;
}

/** One admission request: queued → acquired → released (or cancelled). */
export class AdmissionTicket {
  acquired: boolean;
  cancelled = false;
  readonly enqueuedAt = Date.now();

  private readonly notify: Promise<void>;
  private signal!: () => void;

  constructor(
    readonly uid: string,
    readonly tier: string,
    readonly baseWeight: number,
    readonly seq: number,
    acquired = false,
  ) {
    this.acquired = acquired;
    this.notify = new Promise((resolve) => (this.signal = resolve));
  }

  get waitedMs(): number {
    return Date.now() - this.enqueuedAt;
  }

  /**
   * Wait up to `timeoutMs` for a state change (woken/cancelled).
   * Resolves with the current `acquired` state — false just means "check
   * again later" (progress tick or raced wakeup), not failure.
   */
  async wait(timeoutMs: number): Promise<boolean> {
    if (this.acquired || this.cancelled) return this.acquired;
    await Promise.race([
      this.notify,
      new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, timeoutMs))),
    ]);
    return this.acquired;
  }

  /** @internal woken by the queue on grant or cancel */
  _signal(): void {
    this.signal();
  }
}

export class WeightedAdmissionQueue {
  private active = 0;
  private readonly waiters: AdmissionTicket[] = [];
  private nextSeq = 0;

  constructor(private readonly opts: AdmissionQueueOptions) {
    this.opts.maxConcurrent = Math.max(1, Math.floor(opts.maxConcurrent));
    this.opts.queueMaxSize = Math.max(0, Math.floor(opts.queueMaxSize));
    this.opts.agingWindowMs = Math.max(1, opts.agingWindowMs);
  }

  get running(): number {
    return this.active;
  }

  get waiting(): number {
    return this.waiters.length;
  }

  /**
   * Register a turn. Grants a slot immediately when one is free and nobody
   * is already waiting (preserves queue fairness); otherwise enqueues.
   * @throws QueueFullError when the waiting queue is at capacity.
   */
  enqueue(uid: string, tier = "free"): AdmissionTicket {
    const normalized = (tier || "free").toLowerCase();
    if (this.active < this.opts.maxConcurrent && this.waiters.length === 0) {
      this.active += 1;
      return new AdmissionTicket(uid, normalized, this.weightOf(normalized), this.nextSeq++, true);
    }
    if (this.waiters.length >= this.opts.queueMaxSize) {
      throw new QueueFullError(this.waiters.length, this.opts.queueMaxSize);
    }
    const ticket = new AdmissionTicket(uid, normalized, this.weightOf(normalized), this.nextSeq++);
    this.waiters.push(ticket);
    return ticket;
  }

  /** Give back an acquired slot and wake the best waiter, if any. */
  release(ticket: AdmissionTicket): void {
    if (!ticket.acquired) return;
    ticket.acquired = false;
    this.active = Math.max(0, this.active - 1);
    this.wakeNext();
  }

  /** Remove a still-queued ticket (client disconnect / timeout). No-op otherwise. */
  cancel(ticket: AdmissionTicket): void {
    if (ticket.cancelled || ticket.acquired) return;
    ticket.cancelled = true;
    const i = this.waiters.indexOf(ticket);
    if (i >= 0) this.waiters.splice(i, 1);
    ticket._signal();
  }

  /** 1-based queue position (0 once acquired/cancelled). */
  position(ticket: AdmissionTicket): number {
    if (ticket.acquired || ticket.cancelled) return 0;
    const mine = this.sortKey(ticket);
    let ahead = 0;
    for (const w of this.waiters) {
      if (w !== ticket && this.compare(this.sortKey(w), mine) < 0) ahead += 1;
    }
    return ahead + 1;
  }

  stats(): AdmissionStats {
    const waitingByTier: Record<string, number> = {};
    for (const w of this.waiters) {
      waitingByTier[w.tier] = (waitingByTier[w.tier] ?? 0) + 1;
    }
    return {
      active: this.active,
      maxConcurrent: this.opts.maxConcurrent,
      queueLen: this.waiters.length,
      queueMaxSize: this.opts.queueMaxSize,
      waitingByTier,
    };
  }

  private weightOf(tier: string): number {
    return this.opts.tierWeights?.[tier] ?? 0;
  }

  /**
   * Effective weight grows by `agingStep` every `agingWindowMs` of waiting:
   * a free user queued long enough overtakes a freshly arrived member
   * instead of starving.
   */
  private effectiveWeight(t: AdmissionTicket): number {
    const agedWindows = Math.floor((Date.now() - t.enqueuedAt) / this.opts.agingWindowMs);
    return t.baseWeight + agedWindows * this.opts.agingStep;
  }

  /** Sort key: higher effective weight first, then FIFO (lower seq first). */
  private sortKey(t: AdmissionTicket): [number, number] {
    return [-this.effectiveWeight(t), t.seq];
  }

  private compare(a: [number, number], b: [number, number]): number {
    return a[0] - b[0] || a[1] - b[1];
  }

  private wakeNext(): void {
    if (this.waiters.length === 0 || this.active >= this.opts.maxConcurrent) return;
    let best = 0;
    for (let i = 1; i < this.waiters.length; i++) {
      if (this.compare(this.sortKey(this.waiters[i]), this.sortKey(this.waiters[best])) < 0) best = i;
    }
    const [ticket] = this.waiters.splice(best, 1);
    this.active += 1;
    ticket.acquired = true;
    ticket._signal();
  }
}

// ── process-wide singleton (config snapshotted on first use) ─────────

let singleton: WeightedAdmissionQueue | null | undefined;

/**
 * Returns the process-wide queue, or `null` when `scheduling.enabled=false`.
 * Built once from config on first use — changes require a restart.
 */
export function getAdmissionQueue(): WeightedAdmissionQueue | null {
  if (singleton === undefined) {
    singleton = config.scheduling.enabled
      ? new WeightedAdmissionQueue({
          maxConcurrent: config.scheduling.maxConcurrent,
          queueMaxSize: config.scheduling.queueMaxSize,
          tierWeights: config.scheduling.tierWeights,
          agingWindowMs: config.scheduling.agingWindowMs,
          agingStep: config.scheduling.agingStep,
        })
      : null;
  }
  return singleton;
}

/** Full view for /agent/runtime, including the enabled flag. */
export function admissionStatus(): AdmissionStats & { enabled: boolean } {
  const queue = getAdmissionQueue();
  if (!queue) {
    return {
      enabled: false,
      active: 0,
      maxConcurrent: 0,
      queueLen: 0,
      queueMaxSize: 0,
      waitingByTier: {},
    };
  }
  return { enabled: true, ...queue.stats() };
}
