/** 科研域进程内指标：只做轻量计数，供 /agent/runtime 观测。 */
export class ResearchMetrics {
  private readonly counters = new Map<string, number>();
  private readonly startedAt = Date.now();

  inc(name: string, amount = 1): void {
    if (!Number.isFinite(amount) || amount <= 0) return;
    this.counters.set(name, (this.counters.get(name) ?? 0) + Math.floor(amount));
  }

  snapshot(): { startedAt: number; counters: Record<string, number> } {
    return { startedAt: this.startedAt, counters: Object.fromEntries(this.counters) };
  }
}
