import { config } from "../config/index.js";
import { createLogger } from "../logger.js";

const log = createLogger("MEMBERSHIP");

/**
 * Membership tier resolution for scheduling priority — live implementation
 * (app-pay integration): `GET {appPay.baseUrl}/membership/{uid}` through the
 * APISIX key-auth internal route with the `apikey` header, mirroring
 * app-go/app-cloud/internal/service/quota.go.
 *
 * Contract: never throw, never block long — the chat admission path calls
 * this on every turn. Any failure (timeout / non-200 / missing key) fails
 * open to `free` and is cached briefly so an outage doesn't turn into a
 * per-turn request storm. Response DTO: `{uid, tier: "VIP"|"SVIP"|null,
 * active, expireAt}` — `active:false` or unknown tier → free.
 */

export const TIER_FREE = "free";
export const TIER_VIP = "vip";
export const TIER_SVIP = "svip";

const VALID_TIERS = new Set([TIER_VIP, TIER_SVIP]);

interface CacheEntry {
  tier: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Test seam: clear the in-process TTL cache. */
export function resetMembershipCache(): void {
  cache.clear();
}

function normalizeTier(view: unknown): string {
  if (view === null || typeof view !== "object") return TIER_FREE;
  const v = view as { tier?: unknown; active?: unknown };
  if (v.active !== true) return TIER_FREE;
  const tier = typeof v.tier === "string" ? v.tier.trim().toLowerCase() : "";
  return VALID_TIERS.has(tier) ? tier : TIER_FREE;
}

/**
 * Return the membership tier for `uid` (`free` | `vip` | `svip`).
 * Must never throw and never block long: the chat admission path calls
 * this on every turn.
 */
export async function resolveTier(uid: string | undefined): Promise<string> {
  if (uid === undefined || uid === "" || uid === "0") return TIER_FREE;
  // uid 是 int64（app-pay BigInteger / app-auth snowflake），非纯数字视为非法
  // 输入：不发起网络请求，直接 fail-open free（与 0/空值同语义）。
  if (!/^\d+$/.test(uid)) return TIER_FREE;

  const now = Date.now();
  const hit = cache.get(uid);
  if (hit && hit.expiresAt > now) return hit.tier;

  let tier = TIER_FREE;
  if (config.appPay.apiKey) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.appPay.timeoutMs);
      try {
        const res = await fetch(`${config.appPay.baseUrl}/membership/${uid}`, {
          headers: { apikey: config.appPay.apiKey },
          signal: controller.signal,
        });
        if (res.ok) {
          tier = normalizeTier(await res.json());
        } else {
          log.warn(`[MEMBERSHIP] lookup uid=${uid} status=${res.status} (fail-open free)`);
        }
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      log.warn(`[MEMBERSHIP] lookup uid=${uid} failed: ${err instanceof Error ? err.message : err} (fail-open free)`);
    }
  }
  cache.set(uid, { tier, expiresAt: now + config.appPay.cacheTtlMs });
  return tier;
}
