/**
 * Shared M2M transport for the app-*-client adapters: baseUrl trimming, the
 * apikey header, request timeouts, JSON body parsing and the Go wire error
 * convention ({"detail": ...}).
 *
 * DOMAIN SEMANTICS stay in each client — caching, fail-open vs fail-closed,
 * typed errors (via the error() hook). This class only stops the four
 * internal clients from re-implementing transport plumbing; it does NOT
 * merge the services themselves (each Go service remains the authority for
 * its own data — AGENTS.md §2.13-§2.19).
 */

export interface InternalClientOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
}

export class InternalServiceClient {
  protected readonly baseUrl: string;
  protected readonly apiKey: string;
  protected readonly timeoutMs: number;

  constructor(
    opts: InternalClientOptions,
    /** service label for logs/error context, e.g. "app-bili" */
    private readonly service: string,
  ) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey ?? "";
    this.timeoutMs = opts.timeoutMs;
  }

  /** Map a failed call to the domain client's own error type (override). */
  protected error(message: string, status?: number): Error {
    return new Error(`[${this.service}] ${message}`);
  }

  /** apikey rides every M2M call; uid becomes the gateway-injected identity header. */
  protected headers(uid?: string, extra?: Record<string, string>): Record<string, string> {
    return {
      ...(uid !== undefined ? { "X-Uid": String(uid) } : {}),
      ...(this.apiKey ? { apikey: this.apiKey } : {}),
      ...extra,
    };
  }

  protected async request(method: string, path: string, body?: unknown, uid?: string): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(uid, body !== undefined ? { "Content-Type": "application/json" } : undefined),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  /** Read the body once; non-2xx throws this.error() with the {"detail": ...} message when present. */
  protected async json<T>(res: Response, what: string): Promise<T> {
    const text = await res.text();
    if (!res.ok) {
      let detail = text;
      try {
        const parsed = JSON.parse(text) as { detail?: string };
        if (parsed && typeof parsed.detail === "string") detail = parsed.detail;
      } catch {
        /* keep the raw body */
      }
      throw this.error(detail || `${what} (HTTP ${res.status})`, res.status);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }
}
