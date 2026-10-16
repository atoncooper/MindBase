import { MongoClient, type Db, type Collection } from "mongodb";
import { config } from "../../config/index.js";
import { createLogger } from "../../logger.js";
import type {
  DailyLedgerSummary,
  GatewayLedgerSummary,
  GatewayUsageReport,
  UsageLedgerRepository,
  UsageTurnRecord,
} from "../usage-ledger.js";

const log = createLogger("MONGO_LEDGER");

interface DailyDoc {
  _id: string; // day|uid|purpose|model
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

interface GatewayDoc {
  requestId: string;
  uid?: string;
  model: string;
  purpose: string;
  promptTokens: number;
  completionTokens: number;
  status: string;
  receivedAt: number;
}

/**
 * MongoDB usage ledger (database mind_base_ts): aggregated ai_usage_daily rows
 * (upsert-increment) + raw ai_gateway_usage reports (append-only). This is the
 * successor of the Python backend's credential_usage ledger; the Higress
 * usage-logger posts to /internal/ai-usage which lands here.
 */
export class MongoUsageLedger implements UsageLedgerRepository {
  private constructor(
    private readonly client: MongoClient,
    private readonly daily: Collection<DailyDoc>,
    private readonly gateway: Collection<GatewayDoc>,
  ) {}

  static async connect(): Promise<MongoUsageLedger | null> {
    const { uri, database, timeoutMs } = config.mongo;
    if (!uri) return null;
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: timeoutMs,
      connectTimeoutMS: timeoutMs,
    });
    try {
      await client.connect();
      await client.db("admin").command({ ping: 1 });
      const db = client.db(database);
      const store = new MongoUsageLedger(
        client,
        db.collection<DailyDoc>(config.quota.usageDailyCollection),
        db.collection<GatewayDoc>(config.quota.gatewayUsageCollection),
      );
      await store.ensureIndexes();
      return store;
    } catch (err) {
      log.warn(`[MONGO_LEDGER] connect failed, usage ledger falls back to memory: ${err instanceof Error ? err.message : err}`);
      await client.close().catch(() => undefined);
      return null;
    }
  }

  private async ensureIndexes(): Promise<void> {
    await this.daily.createIndex({ uid: 1, day: 1 });
    await this.gateway.createIndex({ receivedAt: -1 });
    await this.gateway.createIndex({ requestId: 1 });
  }

  async recordTurn(rec: UsageTurnRecord): Promise<void> {
    const id = [rec.day, rec.uid, rec.purpose, rec.model].join("|");
    await this.daily.updateOne(
      { _id: id },
      {
        $inc: {
          calls: 1,
          inputTokens: rec.inputTokens,
          outputTokens: rec.outputTokens,
          costMicroYuan: rec.costMicroYuan,
        },
        $set: { updatedAt: Date.now() },
        $setOnInsert: { day: rec.day, uid: rec.uid, purpose: rec.purpose, model: rec.model },
      },
      { upsert: true },
    );
  }

  async recordGatewayReport(report: GatewayUsageReport): Promise<void> {
    await this.gateway.insertOne({ ...report });
  }

  async summarizeDaily(day: string): Promise<DailyLedgerSummary> {
    const rows = await this.daily
      .aggregate<{
        calls: number; inputTokens: number; outputTokens: number; costMicroYuan: number; rows: number;
      }>([
        { $match: { day } },
        {
          $group: {
            _id: null,
            calls: { $sum: "$calls" },
            inputTokens: { $sum: "$inputTokens" },
            outputTokens: { $sum: "$outputTokens" },
            costMicroYuan: { $sum: "$costMicroYuan" },
            rows: { $sum: 1 },
          },
        },
      ])
      .toArray();
    const r = rows[0];
    return r
      ? { calls: r.calls, inputTokens: r.inputTokens, outputTokens: r.outputTokens, costMicroYuan: r.costMicroYuan, rows: r.rows }
      : { calls: 0, inputTokens: 0, outputTokens: 0, costMicroYuan: 0, rows: 0 };
  }

  async summarizeGatewayWindow(fromMs: number, toMs: number): Promise<GatewayLedgerSummary> {
    const rows = await this.gateway
      .aggregate<{ requests: number; promptTokens: number; completionTokens: number }>([
        { $match: { receivedAt: { $gte: fromMs, $lt: toMs } } },
        {
          $group: {
            _id: null,
            requests: { $sum: 1 },
            promptTokens: { $sum: "$promptTokens" },
            completionTokens: { $sum: "$completionTokens" },
          },
        },
      ])
      .toArray();
    const r = rows[0];
    return r
      ? { requests: r.requests, promptTokens: r.promptTokens, completionTokens: r.completionTokens }
      : { requests: 0, promptTokens: 0, completionTokens: 0 };
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => undefined);
  }
}
