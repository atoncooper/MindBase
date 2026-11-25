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
 *
 * 缓存加固（消费侧，避免缓存击穿/雪崩/无界增长）：
 *  - 单飞（per-uid in-flight）：并发 cache miss 只回源一次，其余等同一个 Promise；
 *  - TTL 抖动（±15%）：成功结果按 appPay.cacheTtlMs × random(0.85, 1.15) 过期，
 *    错峰失效，避免整批 uid 同时回源；
 *  - stale-while-revalidate：条目过期但仍有旧值时先回旧值、后台刷新；刷新失败
 *    静默保留旧值并退避一个失败 TTL（不会每请求重试，也无 unhandled rejection）；
 *  - 失败结果短 TTL：失败按 appPay.failureCacheTtlMs（默认 10s）缓存，支付服务
 *    恢复后最长 10s 即可回到权威档位，而不是被 60s 的长缓存掩盖；
 *  - 容量上限（200k 条）：超限先删过期条目，再按插入顺序淘汰最旧，禁止无界增长。
 */

export const TIER_FREE = "free";
export const TIER_VIP = "vip";
export const TIER_SVIP = "svip";
export const TIER_PROMAX = "promax";

const VALID_TIERS = new Set([TIER_VIP, TIER_SVIP, TIER_PROMAX]);

/** Scheduler priority: free is the lowest, ProMax the highest. */
export function tierRank(tier: string): number {
  if (tier === TIER_PROMAX) return 3;
  if (tier === TIER_SVIP) return 2;
  if (tier === TIER_VIP) return 1;
  return 0;
}

/** 成功结果 TTL 抖动范围（±15%）。 */
const SUCCESS_TTL_JITTER_MIN = 0.85;
const SUCCESS_TTL_JITTER_MAX = 1.15;

/** 失败结果默认短 TTL（config.appPay.failureCacheTtlMs 缺失/非法时的兜底值）。 */
const DEFAULT_FAILURE_CACHE_TTL_MS = 10_000;

/** 进程内档位缓存条数上限；超限先删过期、再按插入顺序删最旧（禁止无界增长）。 */
const DEFAULT_MAX_CACHE_ENTRIES = 200_000;

export type TierSource = "app-pay" | "fallback";

export interface ResolvedTier {
  tier: string;
  /**
   * "app-pay" = app-pay 权威应答（含真实的 active:false 免费用户）；
   * "fallback" = 查询失败（网络/鉴权/未配置 key）→ 按免费档展示。前者是
   * 用户真实档位，后者是降级口径——配额展示用 source 区分，避免"开了会员
   * 仍按免费档限额"的静默降级对用户完全不可见。
   */
  source: TierSource;
}

interface CacheEntry {
  tier: string;
  source: TierSource;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * per-uid 单飞表：同 uid 的回源 Promise 共享给所有等待者。
 * 前台 miss 与后台 stale 刷新都把 flight 登记在这里，避免回源风暴。
 */
const inFlight = new Map<string, Promise<ResolvedTier>>();

// ---------- 测试可注入 seam（生产代码永不调用） ----------

interface MembershipTestHooks {
  /** 替换 Date.now（可控时钟）。 */
  now?: () => number;
  /** 替换 Math.random（可判定 TTL 抖动边界）。 */
  random?: () => number;
  /** 缩小缓存容量，便于测试淘汰逻辑。 */
  maxEntries?: number;
}

let nowFn: () => number = () => Date.now();
let randomFn: () => number = () => Math.random();
let maxEntries = DEFAULT_MAX_CACHE_ENTRIES;

/**
 * 仅供测试：注入时钟/随机数/容量，使 TTL 抖动、过期与淘汰完全可判定。
 * 传 null 恢复生产默认（resetMembershipCache 也会恢复）。
 */
export function __setMembershipTestHooks(hooks: MembershipTestHooks | null): void {
  if (hooks === null) {
    nowFn = () => Date.now();
    randomFn = () => Math.random();
    maxEntries = DEFAULT_MAX_CACHE_ENTRIES;
    return;
  }
  if (hooks.now) nowFn = hooks.now;
  if (hooks.random) randomFn = hooks.random;
  if (hooks.maxEntries !== undefined) maxEntries = hooks.maxEntries;
}

/** 仅供测试：当前缓存条数（断言容量上限用）。 */
export function __membershipCacheSizeForTest(): number {
  return cache.size;
}

/** Test seam: clear the in-process TTL cache (and restore injected test hooks). */
export function resetMembershipCache(): void {
  cache.clear();
  inFlight.clear();
  __setMembershipTestHooks(null);
}

// ---------- 内部实现 ----------

function normalizeTier(view: unknown): string {
  if (view === null || typeof view !== "object") return TIER_FREE;
  const v = view as { tier?: unknown; active?: unknown };
  if (v.active !== true) return TIER_FREE;
  const tier = typeof v.tier === "string" ? v.tier.trim().toLowerCase() : "";
  return VALID_TIERS.has(tier) ? tier : TIER_FREE;
}

/** 成功结果的 TTL：base × random(0.85, 1.15)，错峰过期。 */
function successTtlMs(): number {
  const base = config.appPay.cacheTtlMs;
  if (!Number.isFinite(base) || base <= 0) return 0;
  const factor = SUCCESS_TTL_JITTER_MIN + (SUCCESS_TTL_JITTER_MAX - SUCCESS_TTL_JITTER_MIN) * randomFn();
  return Math.round(base * factor);
}

/** 失败结果的短 TTL（不做抖动：固定短窗口，支付恢复后尽快回到权威档位）。 */
function failureTtlMs(): number {
  const configured = config.appPay.failureCacheTtlMs;
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_FAILURE_CACHE_TTL_MS;
}

function currentMaxEntries(): number {
  const limit = Number.isFinite(maxEntries) ? Math.floor(maxEntries) : DEFAULT_MAX_CACHE_ENTRIES;
  return limit > 0 ? limit : DEFAULT_MAX_CACHE_ENTRIES;
}

/**
 * 超限清理：先删过期条目（尽量保留仍在 TTL 内的档位），仍超限再按 Map 的
 * 插入顺序淘汰最旧条目。写前调用，保证 set 之后 size <= 上限。
 */
function evictIfNeeded(now: number): void {
  const limit = currentMaxEntries();
  if (cache.size < limit) return;

  for (const [uid, entry] of cache) {
    if (cache.size < limit) return;
    if (entry.expiresAt <= now) cache.delete(uid);
  }

  while (cache.size >= limit) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function cacheSet(uid: string, tier: string, source: TierSource, expiresAt: number): void {
  // 仅新条目才需要腾位置（覆盖已有 uid 不会增长 Map，避免误淘汰无关条目）。
  if (!cache.has(uid)) evictIfNeeded(nowFn());
  cache.set(uid, { tier, source, expiresAt });
}

function trackInFlight(uid: string, flight: Promise<ResolvedTier>): Promise<ResolvedTier> {
  inFlight.set(uid, flight);
  const cleanup = (): void => {
    if (inFlight.get(uid) === flight) inFlight.delete(uid);
  };
  // then(cleanup, cleanup)：同时消费 reject，避免后台刷新产生 unhandled rejection。
  void flight.then(cleanup, cleanup);
  return flight;
}

interface LookupOutcome {
  /** true = app-pay 权威应答（tier 已归一化，可能是真实的 free）。 */
  ok: boolean;
  tier: string;
}

/** 单次 app-pay 查询：永不抛异常，失败返回 ok=false（fail-open free）。 */
async function queryAppPay(uid: string): Promise<LookupOutcome> {
  if (!config.appPay.apiKey) {
    // 配置缺失是部署级事故：每个请求都免费档。启动时另有 [BOOT] error 日志。
    log.warn("[MEMBERSHIP] appPay.apiKey empty — every uid resolves free (fallback)");
    return { ok: false, tier: TIER_FREE };
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.appPay.timeoutMs);
    try {
      const res = await fetch(`${config.appPay.baseUrl}/membership/${uid}`, {
        headers: { apikey: config.appPay.apiKey },
        signal: controller.signal,
      });
      if (res.ok) return { ok: true, tier: normalizeTier(await res.json()) };
      log.warn(`[MEMBERSHIP] lookup uid=${uid} status=${res.status} (fail-open free)`);
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    log.warn(`[MEMBERSHIP] lookup uid=${uid} failed: ${err instanceof Error ? err.message : err} (fail-open free)`);
  }
  return { ok: false, tier: TIER_FREE };
}

/** 前台 cache miss 的回源：成功写长 TTL，失败写短 TTL 的 fallback。 */
async function fetchAndCache(uid: string): Promise<ResolvedTier> {
  const outcome = await queryAppPay(uid);
  const now = nowFn();
  if (outcome.ok) {
    cacheSet(uid, outcome.tier, "app-pay", now + successTtlMs());
    return { tier: outcome.tier, source: "app-pay" };
  }
  // 失败只缓存失败短 TTL：支付服务恢复后很快回到权威档位。
  cacheSet(uid, TIER_FREE, "fallback", now + failureTtlMs());
  return { tier: TIER_FREE, source: "fallback" };
}

/**
 * 后台刷新（stale-while-revalidate）：
 *  - 成功：写新档位 + 抖动 TTL；
 *  - 失败：静默保留旧值，只把过期时间推后一个失败 TTL（刷新退避，防重试风暴）。
 */
function startBackgroundRefresh(uid: string, stale: CacheEntry): Promise<ResolvedTier> {
  const flight = (async (): Promise<ResolvedTier> => {
    const outcome = await queryAppPay(uid);
    const now = nowFn();
    if (outcome.ok) {
      cacheSet(uid, outcome.tier, "app-pay", now + successTtlMs());
      return { tier: outcome.tier, source: "app-pay" };
    }
    // 保留最后一次权威值（不把已知 VIP/SVIP/PROMAX 降级成 fallback free）。
    cacheSet(uid, stale.tier, stale.source, now + failureTtlMs());
    return { tier: stale.tier, source: stale.source };
  })();
  return trackInFlight(uid, flight);
}

/** 前台 miss 回源（leader 登记单飞；等待者在 resolveTierDetailed 里共享同一 Promise）。 */
async function resolveFromUpstream(uid: string): Promise<ResolvedTier> {
  const flight = trackInFlight(uid, fetchAndCache(uid));
  try {
    return await flight;
  } finally {
    if (inFlight.get(uid) === flight) inFlight.delete(uid);
  }
}

/**
 * Return the membership tier for `uid` (`free` | `vip` | `svip` | `promax`).
 * Must never throw and never block long: the chat admission path calls
 * this on every turn.
 */
export async function resolveTier(uid: string | undefined): Promise<string> {
  return (await resolveTierDetailed(uid)).tier;
}

/** resolveTier 的带来源版本：配额摘要等展示面用它区分真实免费与降级免费。 */
export async function resolveTierDetailed(uid: string | undefined): Promise<ResolvedTier> {
  if (uid === undefined || uid === "" || uid === "0") return { tier: TIER_FREE, source: "fallback" };
  // uid 是 int64（app-pay BigInteger / app-user snowflake），非纯数字视为非法
  // 输入：不发起网络请求，直接 fail-open free（与 0/空值同语义）。
  if (!/^\d+$/.test(uid)) return { tier: TIER_FREE, source: "fallback" };

  const now = nowFn();
  const hit = cache.get(uid);
  if (hit) {
    if (hit.expiresAt > now) return { tier: hit.tier, source: hit.source };
    // 已过期但有旧值：先回旧值（不阻塞调用方），后台刷新（同 uid 只跑一个）。
    if (!inFlight.has(uid)) startBackgroundRefresh(uid, { ...hit });
    return { tier: hit.tier, source: hit.source };
  }

  // 单飞：命中同一 uid 的回源 Promise，不再发第二个请求。
  const pending = inFlight.get(uid);
  if (pending) return pending;

  return resolveFromUpstream(uid);
}
