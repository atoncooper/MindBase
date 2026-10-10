import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { config } from "../src/config/index.js";
import {
  TIER_FREE,
  TIER_SVIP,
  TIER_VIP,
  resetMembershipCache,
  resolveTier,
} from "../src/utils/membership.js";

const BASE = config.appPay.baseUrl;

beforeAll(() => {
  // vitest env has no real APISIX_CONSUMER_KEY; an empty key would make
  // resolveTier skip the network entirely (by-design fail-open), so inject
  // a test key to exercise the fetch path.
  config.appPay.apiKey = "test-internal-key";
});

function mockFetchOnce(status: number, body: unknown) {
  const fn = vi.fn().mockResolvedValue(
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  resetMembershipCache();
  vi.unstubAllGlobals();
});

describe("resolveTier (app-pay integration)", () => {
  it("maps active VIP/SVIP to lowercase tiers", async () => {
    const fetchMock = mockFetchOnce(200, { uid: 7, tier: "VIP", active: true, expireAt: "2026-12-01T00:00:00" });
    await expect(resolveTier(7)).resolves.toBe(TIER_VIP);
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/membership/7`, expect.objectContaining({ headers: { apikey: config.appPay.apiKey } }));

    mockFetchOnce(200, { uid: 8, tier: "SVIP", active: true, expireAt: null });
    await expect(resolveTier(8)).resolves.toBe(TIER_SVIP);
  });

  it("maps inactive/unknown tiers and malformed payloads to free", async () => {
    mockFetchOnce(200, { uid: 1, tier: "VIP", active: false, expireAt: null });
    await expect(resolveTier(1)).resolves.toBe(TIER_FREE);

    mockFetchOnce(200, { uid: 2, tier: "GOLD", active: true, expireAt: null });
    await expect(resolveTier(2)).resolves.toBe(TIER_FREE);

    mockFetchOnce(200, null);
    await expect(resolveTier(3)).resolves.toBe(TIER_FREE);
  });

  it("fails open to free on non-200 and network errors", async () => {
    mockFetchOnce(503, { detail: "down" });
    await expect(resolveTier(4)).resolves.toBe(TIER_FREE);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
    );
    await expect(resolveTier(5)).resolves.toBe(TIER_FREE);
  });

  it("caches per uid within the TTL window (one fetch for repeated calls)", async () => {
    const fetchMock = mockFetchOnce(200, { uid: 9, tier: "SVIP", active: true, expireAt: null });
    await expect(resolveTier(9)).resolves.toBe(TIER_SVIP);
    await expect(resolveTier(9)).resolves.toBe(TIER_SVIP);
    await expect(resolveTier(9)).resolves.toBe(TIER_SVIP);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // different uid → its own cache entry + fetch
    mockFetchOnce(200, { uid: 10, tier: null, active: false, expireAt: null });
    await expect(resolveTier(10)).resolves.toBe(TIER_FREE);
  });

  it("skips the network entirely for invalid uids", async () => {
    const fetchMock = mockFetchOnce(200, { uid: 0, tier: "VIP", active: true, expireAt: null });
    await expect(resolveTier(undefined)).resolves.toBe(TIER_FREE);
    await expect(resolveTier("0")).resolves.toBe(TIER_FREE);
    await expect(resolveTier("abc")).resolves.toBe(TIER_FREE);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
