import { config } from "../config/index.js";
import { createLogger } from "../logger.js";
import { formatDateIn } from "../utils/datetime.js";
import { nextMidnight } from "./quota.js";
import type { UsageLedgerRepository } from "../repository/usage-ledger.js";

const log = createLogger("RECON");

/**
 * 双账本对账（观测性，不拦截主链路）：
 *  - 业务面 ai_usage_daily：按轮记录（一轮 ReAct 可能对应多次模型调用），
 *    带写时价格快照；
 *  - 网关面 ai_gateway_usage：usage-logger 按模型 HTTP 请求上报。v0 在请求
 *    头阶段 fire-and-forget，token 数恒为 0（SSE body 解析留 v1）——因此
 *    网关 token 全零时对账记 missing_data，而不是误报差异。
 * 口径说明：turns ≠ requests，故数字对不齐是结构性的；本 job 的价值在于
 * 让两侧曲线每日可见，v1（网关 token 到位）后 tokenDiffRatio 才有意义。
 */

export interface ReconResult {
  ranAt: number;
  /** 对账的自然日（上海，昨天） */
  day: string;
  business: { calls: number; inputTokens: number; outputTokens: number; costMicroYuan: number; rows: number };
  gateway: { requests: number; promptTokens: number; completionTokens: number };
  /** 双端 token 总量差异率；missing_data 时为 null */
  tokenDiffRatio: number | null;
  status: "ok" | "warn" | "missing_data";
}

const emptyBusiness = { calls: 0, inputTokens: 0, outputTokens: 0, costMicroYuan: 0, rows: 0 };
const emptyGateway = { requests: 0, promptTokens: 0, completionTokens: 0 };

export class UsageReconciliationJob {
  private timer: NodeJS.Timeout | null = null;
  private last: ReconResult | null = null;
  private running = false;

  constructor(
    private readonly ledger: UsageLedgerRepository,
    private readonly opts: { intervalMs?: number; now?: () => Date } = {},
  ) {}

  /** 启动周期对账（启动即补跑一次昨日窗口）；intervalMs <= 0 = 关闭。 */
  start(): void {
    const intervalMs = this.opts.intervalMs ?? config.quota.reconIntervalMs;
    if (intervalMs <= 0) {
      log.info("[RECON] disabled (reconIntervalMs <= 0)");
      return;
    }
    void this.runOnce().catch((err: unknown) =>
      log.warn(`[RECON] initial run failed: ${err instanceof Error ? err.message : err}`));
    this.timer = setInterval(() => {
      void this.runOnce().catch((err: unknown) =>
        log.warn(`[RECON] run failed: ${err instanceof Error ? err.message : err}`));
    }, intervalMs);
    this.timer.unref?.();
    log.info(`[RECON] started interval=${Math.round(intervalMs / 60000)}min`);
  }

  async runOnce(): Promise<ReconResult> {
    if (this.running && this.last) return this.last; // 防重入
    this.running = true;
    try {
      const now = (this.opts.now ?? (() => new Date()))();
      const todayStart = nextMidnight(now) - 86_400_000;
      const yesterdayStart = todayStart - 86_400_000;
      const day = formatDateIn(new Date(now.getTime() - 86_400_000));
      const business = await this.ledger.summarizeDaily(day);
      const gateway = await this.ledger.summarizeGatewayWindow(yesterdayStart, todayStart);
      const bizTokens = business.inputTokens + business.outputTokens;
      const gwTokens = gateway.promptTokens + gateway.completionTokens;
      let status: ReconResult["status"];
      let tokenDiffRatio: number | null = null;
      if (gateway.requests === 0 || gwTokens === 0) {
        status = "missing_data";
      } else {
        tokenDiffRatio = Math.abs(bizTokens - gwTokens) / Math.max(bizTokens, gwTokens, 1);
        status = tokenDiffRatio > 0.1 ? "warn" : "ok";
      }
      const result: ReconResult = { ranAt: Date.now(), day, business, gateway, tokenDiffRatio, status };
      this.last = result;
      log.info(
        `[RECON] day=${day} status=${status} bizCalls=${business.calls} bizTokens=${bizTokens} ` +
        `gwRequests=${gateway.requests} gwTokens=${gwTokens}`,
      );
      return result;
    } finally {
      this.running = false;
    }
  }

  /** 最近一次对账结果（/agent/runtime quota 段消费）。 */
  snapshot(): ReconResult | null {
    return this.last;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
