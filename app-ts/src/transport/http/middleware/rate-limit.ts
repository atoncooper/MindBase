import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * In-process sliding-window rate limiter (mirrors the per-IP semantics of Python rl_*; moves to Redis for multi-worker deployments, same note as the main app).
 * Returns a Fastify preHandler; 429 when over the limit, without leaking internal info.
 */
export interface RateLimiterOptions {
  windowMs: number;
  max: number;
}

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly opts: RateLimiterOptions) {}

  /** Returns whether to allow; rejected entries are not recorded (does not punish the retrier's window) */
  allow(key: string, now = Date.now()): boolean {
    const window = this.hits.get(key);
    const cutoff = now - this.opts.windowMs;
    const recent = (window ?? []).filter((t) => t > cutoff);
    if (recent.length >= this.opts.max) {
      this.hits.set(key, recent);
      this.maybeGc(now);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    this.maybeGc(now);
    return true;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  /** Memory-leak guard: clears empty/expired windows when the key count exceeds a threshold */
  private lastGc = 0;
  private maybeGc(now: number): void {
    if (this.hits.size < 10_000 || now - this.lastGc < 60_000) return;
    this.lastGc = now;
    const cutoff = now - this.opts.windowMs;
    for (const [k, ts] of this.hits) {
      const recent = ts.filter((t) => t > cutoff);
      if (recent.length === 0) this.hits.delete(k);
      else this.hits.set(k, recent);
    }
  }
}

export function rateLimitHook(limiter: SlidingWindowLimiter) {
  return (req: FastifyRequest, reply: FastifyReply, done: () => void): void => {
    const key = req.ip;
    if (!limiter.allow(key)) {
      reply.status(429).send({ detail: "请求过于频繁，请稍后再试" });
      return;
    }
    done();
  };
}
