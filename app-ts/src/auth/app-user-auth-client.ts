import { config } from "../config/index.js";
import type { CodingPlan } from "../llm/coding-plan.js";
import { InternalServiceClient } from "../transport/internal-client.js";

/**
 * Clients for app-user's internal M2M faces (apikey-guarded, one service, three
 * listeners):
 *   - GET /internal/auth/user/{uid}            (auth listener 8006)
 *   - GET /internal/settings/coding-plan/{uid} (settings listener 8015)
 *
 * The Coding Plan face lives in the settings domain (user configuration, not
 * identity), so it has its own base URL / config section.
 */

export class AppUserAuthError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Coding Plan lookup TTL: a newly added/edited plan becomes visible within 30s. */
const CODING_PLAN_CACHE_MS = 30_000;

/**
 * Coding Plan M2M client (settings listener, /internal/settings/coding-plan).
 * Kept separate from the auth listener client because the two faces listen on
 * different ports of the same app-user process.
 */
export class AppUserSettingsClient extends InternalServiceClient {
  constructor(opts?: { baseUrl?: string; apiKey?: string; timeoutMs?: number }) {
    super(
      {
        baseUrl: opts?.baseUrl ?? config.appUserSettings.baseUrl,
        apiKey: opts?.apiKey ?? config.appUserSettings.apiKey,
        timeoutMs: opts?.timeoutMs ?? config.appUserSettings.timeoutMs,
      },
      "app-user-settings",
    );
  }

  protected override error(message: string, status?: number): Error {
    return new AppUserAuthError(status ?? 0, message);
  }

  /**
   * Fetch the user's active Coding Plan (internal M2M face, apikey-guarded).
   *
   * Contract: 200 → plan; 404 → null (no usable plan); every other failure
   * (403 non-VIP / 503 membership service down / network) is thrown so the
   * caller falls back to the platform gateway. Never returns the plaintext key
   * to logs — only this client and the model factory see it.
   */
  async getCodingPlan(uid: string): Promise<CodingPlan | null> {
    try {
      const res = await this.request("GET", `/internal/settings/coding-plan/${uid}`);
      const body = await this.json<{ plan?: CodingPlan }>(res, "app-user coding plan lookup failed");
      return body.plan ?? null;
    } catch (err) {
      if (err instanceof AppUserAuthError && err.status === 404) {
        return null;
      }
      throw err;
    }
  }
}

export class AppUserAuthClient extends InternalServiceClient {
  private readonly emailCache = new Map<string, { at: number; email: string }>();
  /** uid → plan (null = the internal face answered 404: no usable plan for this user). */
  private readonly codingPlanCache = new Map<string, { at: number; plan: CodingPlan | null }>();
  /** Coding Plan face (settings listener 8015). */
  private readonly settings: AppUserSettingsClient;

  constructor(opts?: {
    baseUrl?: string;
    apiKey?: string;
    timeoutMs?: number;
    settingsBaseUrl?: string;
    settingsApiKey?: string;
    settingsTimeoutMs?: number;
  }) {
    super(
      {
        baseUrl: opts?.baseUrl ?? config.appAuth.baseUrl,
        apiKey: opts?.apiKey ?? config.appAuth.apiKey,
        timeoutMs: opts?.timeoutMs ?? config.appAuth.timeoutMs,
      },
      "app-user",
    );
    this.settings = new AppUserSettingsClient({
      baseUrl: opts?.settingsBaseUrl,
      apiKey: opts?.settingsApiKey,
      timeoutMs: opts?.settingsTimeoutMs,
    });
  }

  protected override error(message: string, status?: number): Error {
    return new AppUserAuthError(status ?? 0, message);
  }

  /** Resolve the user's email; "" when unset. Unknown user → AppUserAuthError 404. */
  async getUserEmail(uid: string): Promise<string> {
    const cached = this.emailCache.get(uid);
    if (cached && Date.now() - cached.at < 60_000) {
      return cached.email;
    }
    const res = await this.request("GET", `/internal/auth/user/${uid}`);
    const body = await this.json<{ email?: string }>(res, "app-user user lookup failed");
    const email = body.email ?? "";
    this.emailCache.set(uid, { at: Date.now(), email });
    return email;
  }

  /**
   * Fetch the user's active Coding Plan (settings listener M2M face).
   * 200 → plan; 404 → null (no usable plan); anything else throws so the
   * caller falls back to the platform gateway. Cached for 30s.
   */
  async getCodingPlan(uid: string): Promise<CodingPlan | null> {
    const cached = this.codingPlanCache.get(uid);
    if (cached && Date.now() - cached.at < CODING_PLAN_CACHE_MS) {
      return cached.plan;
    }
    const plan = await this.settings.getCodingPlan(uid);
    this.codingPlanCache.set(uid, { at: Date.now(), plan });
    return plan;
  }
}
