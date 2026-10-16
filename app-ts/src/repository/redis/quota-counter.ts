import { Redis } from "ioredis";
import { createLogger } from "../../logger.js";
import type { ConsumeResult, QuotaCounterStore } from "../quota.js";

const log = createLogger("QUOTA_REDIS");

/**
 * Lua: atomic check-and-increment — single round trip, no TOCTOU, and a
 * rejected caller never writes (no leaked counts on reject). ARGV: 1=limit,
 * 2=ttl seconds. Returns [allowed(0|1), count].
 */
const CONSUME_LUA = [
  "local cur = tonumber(redis.call('GET', KEYS[1]) or '0')",
  "local limit = tonumber(ARGV[1])",
  "if cur < limit then",
  "  local n = redis.call('INCR', KEYS[1])",
  "  if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end",
  "  return {1, n}",
  "end",
  "return {0, cur}",
].join("\n");

/** Per-command cap — a hung Redis must degrade to fail-open, not stall the turn. */
const COMMAND_TIMEOUT_MS = 2000;

function withTimeout<T>(p: Promise<T>, label: string): Promise<T | null> {
  return Promise.race([
    p.catch((err: unknown) => {
      log.warn(`[QUOTA_REDIS] ${label} failed (fail-open): ${err instanceof Error ? err.message : err}`);
      return null as T | null;
    }),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), COMMAND_TIMEOUT_MS)),
  ]);
}

/**
 * Redis-backed quota counter (mind-base:quota:* keys).
 * Every command is wrapped: on error/timeout it resolves null and the quota
 * service fails open — a Redis incident must never block chat.
 */
export class RedisQuotaCounter implements QuotaCounterStore {
  private readonly redis: Redis;
  private readonly closed = false;

  constructor(url: string) {
    this.redis = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: (times: number) => Math.min(times * 2000, 30_000),
    });
    this.redis.on("error", (err: Error) => {
      log.warn(`[QUOTA_REDIS] connection error (fail-open): ${err.message}`);
    });
    void this.redis.connect().catch((err: unknown) => {
      log.warn(`[QUOTA_REDIS] connect failed (will retry via ioredis): ${err instanceof Error ? err.message : err}`);
    });
  }

  async count(key: string): Promise<number | null> {
    const v = await withTimeout(this.redis.get(key), "get");
    return v === null ? null : Number(v) || 0;
  }

  async consume(key: string, limit: number, ttlSeconds: number): Promise<ConsumeResult | null> {
    if (limit < 0) return { allowed: true, count: 0 };
    const res = await withTimeout(
      this.redis.eval(CONSUME_LUA, 1, key, String(limit), String(ttlSeconds)) as Promise<[number, number]>,
      "consume",
    );
    if (res === null) return null;
    return { allowed: res[0] === 1, count: Number(res[1]) };
  }

  async add(key: string, delta: number, ttlSeconds: number): Promise<number | null> {
    const res = await withTimeout(this.redis.incrby(key, delta), "incrby");
    if (res === null) return null;
    if (res === delta) {
      // first write arms the TTL (parity with the consume path)
      await withTimeout(this.redis.expire(key, ttlSeconds), "expire");
    }
    return res;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}
