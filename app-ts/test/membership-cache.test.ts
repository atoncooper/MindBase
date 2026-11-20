import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config/index.js";
import {
  __membershipCacheSizeForTest,
  __setMembershipTestHooks,
  resetMembershipCache,
  resolveTier,
  resolveTierDetailed,
  TIER_FREE,
  TIER_SVIP,
  TIER_VIP,
} from "../src/utils/membership.js";

/**
 * 消费侧缓存加固回归：单飞 / TTL 抖动 / 失败短 TTL / stale-while-revalidate /
 * 容量上限。全部走注入的时钟 + 随机数（__setMembershipTestHooks），不依赖真实
 * 网络与真实等待；fetch 一律 stub。
 */

const BASE = config.appPay.baseUrl;
const CACHE_TTL_MS = 10_000;
const FAILURE_TTL_MS = 10_000;

/** 可控时钟（基准值随每个用例重置）。 */
let clock = 1_000_000;

const originalAppPay: { apiKey: string; cacheTtlMs: number; failureCacheTtlMs: number } = {
  apiKey: config.appPay.apiKey,
  cacheTtlMs: config.appPay.cacheTtlMs,
  failureCacheTtlMs: config.appPay.failureCacheTtlMs,
};

function installHooks(overrides: { random?: () => number; maxEntries?: number } = {}): void {
  __setMembershipTestHooks({
    now: () => clock,
    random: overrides.random ?? (() => 0.5), // 0.5 → 无抖动偏移（TTL 恰为 base）
    maxEntries: overrides.maxEntries ?? 200_000,
  });
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function activeBody(tier: string): Record<string, unknown> {
  return { uid: 1, tier, active: true, expireAt: null };
}

function stubFetch(handler: () => Response | Promise<Response>): ReturnType<typeof vi.fn> {
  const fn = vi.fn(handler);
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** 冲掉无关宏任务，让后台刷新链（microtask）跑完。 */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

beforeAll(() => {
  config.appPay.apiKey = "test-internal-key";
  config.appPay.cacheTtlMs = CACHE_TTL_MS;
  config.appPay.failureCacheTtlMs = FAILURE_TTL_MS;
});

beforeEach(() => {
  clock = 1_000_000;
  installHooks();
});

afterEach(() => {
  resetMembershipCache();
  vi.unstubAllGlobals();
});

afterAll(() => {
  config.appPay.apiKey = originalAppPay.apiKey;
  config.appPay.cacheTtlMs = originalAppPay.cacheTtlMs;
  config.appPay.failureCacheTtlMs = originalAppPay.failureCacheTtlMs;
});

describe("membership cache hardening", () => {
  it("coalesces concurrent cache misses into one upstream fetch (single-flight)", async () => {
    let release!: (value: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = Array.from({ length: 8 }, () => resolveTierDetailed("1001"));
    // 并发调用在首个 await 前同步进入回源，其余共享同一个 in-flight Promise。
    expect(fetchMock).toHaveBeenCalledTimes(1);

    release(response(activeBody("VIP")));
    const results = await Promise.all(pending);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.tier)).toEqual(Array<string>(8).fill(TIER_VIP));
    expect(results.every((r) => r.source === "app-pay")).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE}/membership/1001`,
      expect.objectContaining({ headers: { apikey: config.appPay.apiKey } }),
    );
  });

  it("jitters the success TTL within ±15% (no early expiry, no late overrun)", async () => {
    const fetchMock = stubFetch(() => response(activeBody("VIP")));
    // random=0 → TTL 8500ms（下限）；random=1 → 11500ms（上限）。
    installHooks({ random: () => 0 });
    await expect(resolveTier("2001")).resolves.toBe(TIER_VIP);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    clock += 8_499; // 下限之前 → 仍命中
    await expect(resolveTier("2001")).resolves.toBe(TIER_VIP);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    clock += 2; // 越过下限 → 过期，旧值立即可用 + 后台刷新
    await expect(resolveTierDetailed("2001")).resolves.toEqual({ tier: TIER_VIP, source: "app-pay" });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const upperStart = clock;
    installHooks({ random: () => 1 });
    await expect(resolveTier("2002")).resolves.toBe(TIER_VIP);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    clock = upperStart + 11_499; // 上限之前 → 仍命中
    await expect(resolveTier("2002")).resolves.toBe(TIER_VIP);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    clock = upperStart + 11_501; // 越过上限 → 过期刷新
    await expect(resolveTier("2002")).resolves.toBe(TIER_VIP);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("caches fallback results for the short failure TTL, then retries", async () => {
    const fetchMock = stubFetch(() => new Response("down", { status: 503 }));
    await expect(resolveTierDetailed("3001")).resolves.toEqual({ tier: TIER_FREE, source: "fallback" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    clock += FAILURE_TTL_MS - 1; // 失败短 TTL 内 → 命中缓存，不再回源
    await expect(resolveTierDetailed("3001")).resolves.toEqual({ tier: TIER_FREE, source: "fallback" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    clock += 2; // 超过失败短 TTL → 过期后再度回源（这里是 stale 路径 + 后台刷新）
    await expect(resolveTierDetailed("3001")).resolves.toEqual({ tier: TIER_FREE, source: "fallback" });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("serves the stale tier immediately and refreshes it in the background", async () => {
    installHooks({ random: () => 0 }); // TTL 8500ms，便于精确越过过期点
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(activeBody("VIP")))
      .mockResolvedValueOnce(response(activeBody("SVIP")));
    vi.stubGlobal("fetch", fetchMock);

    await expect(resolveTier("4001")).resolves.toBe(TIER_VIP);

    clock += 8_501; // 过期：立即返回旧值（不等后台刷新）
    await expect(resolveTierDetailed("4001")).resolves.toEqual({ tier: TIER_VIP, source: "app-pay" });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // 后台刷新成功后，下一次调用拿到新档位。
    await expect(resolveTier("4001")).resolves.toBe(TIER_SVIP);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the last authoritative tier when the background refresh fails (no retry storm)", async () => {
    installHooks({ random: () => 0 }); // TTL 8500ms
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(activeBody("SVIP")))
      .mockResolvedValueOnce(new Response("down", { status: 500 }))
      .mockResolvedValueOnce(response(activeBody("VIP")));
    vi.stubGlobal("fetch", fetchMock);

    await expect(resolveTierDetailed("5001")).resolves.toEqual({ tier: TIER_SVIP, source: "app-pay" });

    clock += 8_501; // 过期 → 旧值立即返回，后台刷新失败
    await expect(resolveTierDetailed("5001")).resolves.toEqual({ tier: TIER_SVIP, source: "app-pay" });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    clock += 5_000; // 刷新失败后退避一个失败 TTL：旧值继续命中，不重复回源
    await expect(resolveTierDetailed("5001")).resolves.toEqual({ tier: TIER_SVIP, source: "app-pay" });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    clock += 5_100; // 退避到期 → 再刷新一次（这次成功）
    await expect(resolveTierDetailed("5001")).resolves.toEqual({ tier: TIER_SVIP, source: "app-pay" });
    await flush();
    await expect(resolveTier("5001")).resolves.toBe(TIER_VIP);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("bounds the cache and evicts expired entries before live ones", async () => {
    installHooks({ random: () => 1, maxEntries: 2 });
    const fetchMock = stubFetch(() => response(activeBody("VIP")));

    await resolveTier("6101"); // random=1 → TTL 11500ms
    installHooks({ random: () => 0, maxEntries: 2 });
    await resolveTier("6102"); // random=0 → TTL 8500ms
    expect(__membershipCacheSizeForTest()).toBe(2);

    clock += 8_600; // 6102 已过期，6101 仍有效
    await resolveTier("6103"); // 插入触发清理：先删过期（6102），保留 6101
    expect(__membershipCacheSizeForTest()).toBe(2);

    const before = fetchMock.mock.calls.length;
    await resolveTier("6101"); // 仍在 TTL 内 → 命中，不回源
    expect(fetchMock).toHaveBeenCalledTimes(before);
    await resolveTier("6102"); // 已过期且被淘汰 → 回源
    expect(fetchMock).toHaveBeenCalledTimes(before + 1);
  });

  it("evicts the oldest entry first when every entry is still fresh", async () => {
    installHooks({ random: () => 0.5, maxEntries: 3 });
    const fetchMock = stubFetch(() => response(activeBody("VIP")));

    for (const uid of ["6201", "6202", "6203"]) await resolveTier(uid);
    expect(__membershipCacheSizeForTest()).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await resolveTier("6204"); // 超限且无过期条目 → 按插入顺序淘汰最旧（6201）
    expect(__membershipCacheSizeForTest()).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    await resolveTier("6201"); // 已淘汰 → 回源
    expect(fetchMock).toHaveBeenCalledTimes(5);
    await resolveTier("6204"); // 仍命中
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});
