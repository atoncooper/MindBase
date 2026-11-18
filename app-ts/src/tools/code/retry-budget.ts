import { createHash } from "node:crypto";

/**
 * Per-code-version retry budget. A code version is the full executable input
 * (language + code + files); changing any of them creates a new version with a
 * fresh budget. The initial run + at most 5 retries = 6 attempts.
 */
export interface RetryDecision {
  allowed: boolean;
  key: string;
  version: string;
  attempt: number;
  maxAttempts: number;
  remainingRetries: number;
}

interface Entry {
  attempts: number;
  updatedAt: number;
}

export class CodeRetryBudget {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly maxAttempts = 6,
    private readonly ttlMs = 6 * 60 * 60 * 1000,
  ) {}

  begin(identity: {
    uid?: string;
    sessionId?: string;
    language: string;
    code: string;
    files?: Array<{ path: string; content: string }>;
  }): RetryDecision {
    this.cleanup();
    const version = createHash("sha256")
      .update(
        JSON.stringify({
          language: identity.language,
          code: identity.code,
          files: identity.files ?? [],
        }),
      )
      .digest("hex")
      .slice(0, 12);
    const key = [identity.uid ?? "-", identity.sessionId ?? "no-session", version].join("|");
    const entry = this.entries.get(key) ?? { attempts: 0, updatedAt: Date.now() };
    const attempt = entry.attempts + 1;
    if (attempt > this.maxAttempts) {
      return {
        allowed: false,
        key,
        version,
        attempt: entry.attempts,
        maxAttempts: this.maxAttempts,
        remainingRetries: 0,
      };
    }
    entry.attempts = attempt;
    entry.updatedAt = Date.now();
    this.entries.set(key, entry);
    return {
      allowed: true,
      key,
      version,
      attempt,
      maxAttempts: this.maxAttempts,
      remainingRetries: Math.max(0, this.maxAttempts - attempt),
    };
  }

  /** A successful run clears the version so later edits/reruns start fresh. */
  success(key: string): void {
    this.entries.delete(key);
  }

  /** The run never reached the sandbox (quota/transport): do not consume budget. */
  refund(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.attempts = Math.max(0, entry.attempts - 1);
    if (entry.attempts === 0) this.entries.delete(key);
    else this.entries.set(key, entry);
  }

  private cleanup(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [key, entry] of this.entries) {
      if (entry.updatedAt < cutoff) this.entries.delete(key);
    }
  }
}
