/** Tier vocabulary, normalized at the app-pay boundary (utils/membership.ts). */
export type QuotaTier = "free" | "vip" | "svip" | "promax";

/**
 * Quota counter contract: a per-day, per-key atomic counter.
 * Contract in the root, implementations by backend (memory / redis) — the
 * service layer (services/quota.ts) only sees this interface.
 *
 * Every method returns `null` when the store is UNAVAILABLE (Redis down / not
 * configured) — callers treat null as fail-open (allow)
 * (availability over quota precision).
 */
export interface ConsumeResult {
  allowed: boolean;
  /** count AFTER the increment (when allowed) or the current count (when rejected) */
  count: number;
}

export interface QuotaCounterStore {
  /** Current value; 0 when the key is missing; null = store unavailable. */
  count(key: string): Promise<number | null>;
  /**
   * Sum a bounded set of counters (the rolling 5-hour window is 60 buckets).
   * One MGET round trip on Redis; null = store unavailable.
   */
  sum(keys: string[]): Promise<number | null>;
  /**
   * Atomic check-and-increment: when the current value < limit, increment
   * (arming the TTL on first write) and allow; otherwise reject WITHOUT
   * writing (no leaked counts on reject). limit < 0 = unlimited (always
   * allow, no write). null = store unavailable (caller decides fail-open).
   *
   * Retained for the two count semantics that are NOT usage quotas: the
   * user-supplied Coding Plan turn cap and stock caps.
   */
  consume(key: string, limit: number, ttlSeconds: number): Promise<ConsumeResult | null>;
  /** Atomic increment by delta (negative allowed); arms the TTL on first write. */
  add(key: string, delta: number, ttlSeconds: number): Promise<number | null>;
  /**
   * Increment several counters as one unit (day + month + 5h bucket + kind
   * breakdown). Redis runs them in one MULTI; null = store unavailable.
   */
  addMany(entries: Array<{ key: string; delta: number; ttlSeconds: number }>): Promise<boolean | null>;
  /** Release resources (no-op for the memory store). */
  close(): Promise<void>;
}

