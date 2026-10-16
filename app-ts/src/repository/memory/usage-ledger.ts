import type {
  DailyLedgerSummary,
  GatewayLedgerSummary,
  GatewayUsageReport,
  UsageLedgerRepository,
  UsageTurnRecord,
} from "../usage-ledger.js";

interface DailyRow {
  day: string;
  uid: string;
  purpose: string;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costMicroYuan: number;
  updatedAt: number;
}

/** In-memory ledger — vitest substitute + Mongo-unavailable fallback. */
export class MemoryUsageLedger implements UsageLedgerRepository {
  private readonly rows = new Map<string, DailyRow>();
  private readonly gateway: GatewayUsageReport[] = [];

  private static key(day: string, uid: string, purpose: string, model: string): string {
    return [day, uid, purpose, model].join("|");
  }

  async recordTurn(rec: UsageTurnRecord): Promise<void> {
    const key = MemoryUsageLedger.key(rec.day, rec.uid, rec.purpose, rec.model);
    const row = this.rows.get(key);
    if (row) {
      row.calls += 1;
      row.inputTokens += rec.inputTokens;
      row.outputTokens += rec.outputTokens;
      row.costMicroYuan += rec.costMicroYuan;
      row.updatedAt = Date.now();
      return;
    }
    this.rows.set(key, { ...rec, calls: 1, updatedAt: Date.now() });
  }

  async recordGatewayReport(report: GatewayUsageReport): Promise<void> {
    this.gateway.push(report);
  }

  async summarizeDaily(day: string): Promise<DailyLedgerSummary> {
    const sum = { calls: 0, inputTokens: 0, outputTokens: 0, costMicroYuan: 0, rows: 0 };
    for (const row of this.rows.values()) {
      if (row.day !== day) continue;
      sum.calls += row.calls;
      sum.inputTokens += row.inputTokens;
      sum.outputTokens += row.outputTokens;
      sum.costMicroYuan += row.costMicroYuan;
      sum.rows += 1;
    }
    return sum;
  }

  async summarizeGatewayWindow(fromMs: number, toMs: number): Promise<GatewayLedgerSummary> {
    const sum = { requests: 0, promptTokens: 0, completionTokens: 0 };
    for (const r of this.gateway) {
      if (r.receivedAt >= fromMs && r.receivedAt < toMs) {
        sum.requests += 1;
        sum.promptTokens += r.promptTokens;
        sum.completionTokens += r.completionTokens;
      }
    }
    return sum;
  }

  /** Test/observability accessors. */
  snapshot(): DailyRow[] {
    return [...this.rows.values()].sort((a, b) => a.day.localeCompare(b.day));
  }

  gatewayReports(): GatewayUsageReport[] {
    return [...this.gateway];
  }

  async close(): Promise<void> {
    this.rows.clear();
    this.gateway.length = 0;
  }
}
