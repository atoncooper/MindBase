
/**
 * Usage ledger contract (observation-first):
 *  - ai_usage_daily: one aggregated row per day × uid × purpose × model
 *    (business view — what app-ts thinks it spent, with price snapshots);
 *  - ai_gateway_usage: raw Higress usage-logger reports (gateway view),
 *    reconciled against the daily rows by a daily job.
 * Price snapshots are recorded at write time — never recomputed after a
 * price change.
 */

export interface UsageTurnRecord {
  /** "YYYY-MM-DD" in the configured timezone */
  day: string;
  /** "0" = platform / anonymous */
  uid: string;
  /** billing label (llm provider X-Purpose), e.g. "chat" */
  purpose: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** micro-Yuan (1e-6 元) — integer accumulation, no float drift */
  costMicroYuan: number;
}

export interface GatewayUsageReport {
  requestId: string;
  uid?: string;
  model: string;
  purpose: string;
  promptTokens: number;
  completionTokens: number;
  status: string;
  receivedAt: number;
}

export interface UsageLedgerRepository {
  recordTurn(rec: UsageTurnRecord): Promise<void>;
  recordGatewayReport(report: GatewayUsageReport): Promise<void>;
  /** 某自然日的业务面聚合（对账 job 用） */
  summarizeDaily(day: string): Promise<DailyLedgerSummary>;
  /** 网关面在 [fromMs, toMs) 窗口内的聚合（对账 job 用） */
  summarizeGatewayWindow(fromMs: number, toMs: number): Promise<GatewayLedgerSummary>;
  close(): Promise<void>;
}

export interface DailyLedgerSummary {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costMicroYuan: number;
  rows: number;
}

export interface GatewayLedgerSummary {
  requests: number;
  promptTokens: number;
  completionTokens: number;
}

export interface UsagePrices {
  input: number;  // 元 / million input tokens
  output: number; // 元 / million output tokens
}

/**
 * tokens × 元/M-tok → micro-Yuan: cost(元) = tokens × price / 1e6, so
 * microYuan = tokens × price exactly — integer math, no drift.
 */
export function costMicroYuan(
  inputTokens: number,
  outputTokens: number,
  prices: UsagePrices | undefined,
): number {
  if (!prices) return 0;
  return Math.round(inputTokens * prices.input) + Math.round(outputTokens * prices.output);
}

