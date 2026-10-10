import { config } from "../config/index.js";
import { InternalServiceClient } from "../transport/internal-client.js";

/**
 * Client for the auth service's internal user-lookup face
 * (GET /internal/auth/user/{uid}, apikey-guarded). Used to resolve the
 * delivery email for scheduled-quiz tasks — the users table belongs to
 * app-auth, so nothing else reads it directly.
 */

export class AppAuthError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class AppAuthClient extends InternalServiceClient {
  private readonly emailCache = new Map<string, { at: number; email: string }>();

  constructor(opts?: { baseUrl?: string; apiKey?: string; timeoutMs?: number }) {
    super(
      {
        baseUrl: opts?.baseUrl ?? config.appAuth.baseUrl,
        apiKey: opts?.apiKey ?? config.appAuth.apiKey,
        timeoutMs: opts?.timeoutMs ?? config.appAuth.timeoutMs,
      },
      "app-auth",
    );
  }

  protected override error(message: string, status?: number): Error {
    return new AppAuthError(status ?? 0, message);
  }

  /** Resolve the user's email; "" when unset. Unknown user → AppAuthError 404. */
  async getUserEmail(uid: string): Promise<string> {
    const cached = this.emailCache.get(uid);
    if (cached && Date.now() - cached.at < 60_000) {
      return cached.email;
    }
    const res = await this.request("GET", `/internal/auth/user/${uid}`);
    const body = await this.json<{ email?: string }>(res, "app-auth user lookup failed");
    const email = body.email ?? "";
    this.emailCache.set(uid, { at: Date.now(), email });
    return email;
  }
}
