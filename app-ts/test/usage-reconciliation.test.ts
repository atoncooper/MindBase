import { describe, it, expect } from "vitest";
import { UsageReconciliationJob } from "../src/services/usage-reconciliation.js";
import { MemoryUsageLedger } from "../src/repository/memory/usage-ledger.js";
import { formatDateIn } from "../src/utils/datetime.js";

/**
 * 双账本对账（观测性）：昨日窗口的业务面（按轮）vs 网关面（按模型请求）。
 * usage-logger v0 的网关 token 恒为 0 → missing_data；两侧都有 token 后才
 * 计算 tokenDiffRatio（>10% → warn）。
 */

const NOW = new Date("2026-10-15T10:00:00Z"); // 上海 10-15 18:00
// 昨日窗口（上海）= UTC [10-13T16:00Z, 10-14T16:00Z)

describe("UsageReconciliationJob", () => {
  it("reconciles yesterday: ok when both sides align", async () => {
    const ledger = new MemoryUsageLedger();
    const day = formatDateIn(new Date(NOW.getTime() - 86_400_000));
    await ledger.recordTurn({ day, uid: "7", purpose: "chat", model: "m", inputTokens: 1000, outputTokens: 500, costMicroYuan: 10 });
    await ledger.recordGatewayReport({
      requestId: "r1", model: "m", purpose: "chat",
      promptTokens: 1000, completionTokens: 500, status: "request",
      receivedAt: Date.UTC(2026, 9, 14, 12, 0, 0),
    });
    const res = await new UsageReconciliationJob(ledger, { intervalMs: 0, now: () => NOW }).runOnce();
    expect(res.day).toBe(day);
    expect(res.business?.calls).toBe(1);
    expect(res.gateway?.requests).toBe(1);
    expect(res.status).toBe("ok");
  });

  it("missing_data when the gateway reported nothing (v0 token-free reports)", async () => {
    const res = await new UsageReconciliationJob(new MemoryUsageLedger(), { intervalMs: 0, now: () => NOW }).runOnce();
    expect(res.status).toBe("missing_data");
    expect(res.gateway?.requests).toBe(0);
    expect(res.tokenDiffRatio).toBeNull();
  });

  it("warn when token totals diverge beyond 10%", async () => {
    const ledger = new MemoryUsageLedger();
    const day = formatDateIn(new Date(NOW.getTime() - 86_400_000));
    await ledger.recordTurn({ day, uid: "7", purpose: "chat", model: "m", inputTokens: 10000, outputTokens: 0, costMicroYuan: 2 });
    await ledger.recordGatewayReport({
      requestId: "r1", model: "m", purpose: "chat",
      promptTokens: 1000, completionTokens: 0, status: "request",
      receivedAt: Date.UTC(2026, 9, 14, 12, 0, 0),
    });
    const res = await new UsageReconciliationJob(ledger, { intervalMs: 0, now: () => NOW }).runOnce();
    expect(res.status).toBe("warn");
    expect(res.tokenDiffRatio).toBeCloseTo(0.9, 5);
  });

  it("snapshot exposes the last run; interval 0 schedules nothing", async () => {
    const job = new UsageReconciliationJob(new MemoryUsageLedger(), { intervalMs: 0, now: () => NOW });
    job.start();
    expect(job.snapshot()).toBeNull();
    job.stop();
  });
});
