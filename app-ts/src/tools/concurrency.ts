/**
 * Counting semaphore with a bounded wait: protects downstream services from the
 * aggregate fan-out of concurrent agent turns. Policy is "shallow queue + fail fast" —
 * a caller waits at most `waitMs` for a slot, then gives up (no deep queues).
 */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<{ resolve: (release: (() => void) | null) => void; timer: NodeJS.Timeout }> = [];

  constructor(
    readonly max: number,
    private readonly name = "semaphore",
  ) {}

  get running(): number {
    return this.active;
  }

  get waiting(): number {
    return this.waiters.length;
  }

  /**
   * Wait up to `waitMs` for a slot. Resolves with a release function when granted,
   * or null when the wait budget expires (caller decides what "busy" means).
   */
  async acquire(waitMs: number): Promise<(() => void) | null> {
    if (this.active < this.max) {
      this.active += 1;
      return () => this.release();
    }
    if (waitMs <= 0) return null;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.timer === timer);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(null);
      }, waitMs);
      this.waiters.push({
        timer,
        resolve: (release) => {
          clearTimeout(timer);
          resolve(release);
        },
      });
    });
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters.shift();
    if (next) {
      this.active += 1;
      next.resolve(() => this.release());
    }
  }
}
