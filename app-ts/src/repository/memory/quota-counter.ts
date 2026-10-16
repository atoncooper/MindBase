import type { ConsumeResult, QuotaCounterStore } from "../quota.js";

/**
 * In-memory quota counter — vitest substitute AND the Redis-unavailable
 * fallback (fail-open semantics still apply: this store never returns null,
 * it is only wired when Redis is not configured).
 */
export class MemoryQuotaCounter implements QuotaCounterStore {
  private readonly values = new Map<string, { value: number; expiresAt: number }>();

  private live(key: string): { value: number; expiresAt: number } | undefined {
    const entry = this.values.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.values.delete(key);
      return undefined;
    }
    return entry;
  }

  async count(key: string): Promise<number | null> {
    return this.live(key)?.value ?? 0;
  }

  async consume(key: string, limit: number, ttlSeconds: number): Promise<ConsumeResult | null> {
    if (limit < 0) return { allowed: true, count: 0 };
    const cur = this.live(key)?.value ?? 0;
    if (cur >= limit) return { allowed: false, count: cur };
    const next = cur + 1;
    this.values.set(key, { value: next, expiresAt: Date.now() + ttlSeconds * 1000 });
    return { allowed: true, count: next };
  }

  async add(key: string, delta: number, ttlSeconds: number): Promise<number | null> {
    const next = (this.live(key)?.value ?? 0) + delta;
    this.values.set(key, { value: next, expiresAt: Date.now() + ttlSeconds * 1000 });
    return next;
  }

  async close(): Promise<void> {
    this.values.clear();
  }
}
