import { MongoClient, type Collection, type Db } from "mongodb";
import { config } from "../../config/index.js";
import { createLogger } from "../../logger.js";
import type { AsrTranscript, KgSourceStore } from "../kg-sources.js";

const log = createLogger("KG_SOURCES");

/**
 * Mongo adapter — READ-ONLY cross-DB accessor into the Python backend's Mongo
 * database (mind_base.asr_documents). Contract + memory fallback live in
 * ../kg-sources.ts and ../memory/kg-sources.ts.
 */

interface AsrDoc {
  content?: string;
  page_title?: string;
}

export class MongoKgSourceStore implements KgSourceStore {
  private constructor(
    private readonly client: MongoClient,
    private readonly col: Collection<AsrDoc>,
  ) {}

  static async connect(): Promise<MongoKgSourceStore | null> {
    const { uri, timeoutMs } = config.mongo;
    if (!uri) return null;
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: timeoutMs,
      connectTimeoutMS: timeoutMs,
    });
    try {
      await client.connect();
      await client.db("admin").command({ ping: 1 });
      // cross-DB by design: the source of truth lives in the Python backend's database
      const db = client.db(config.kg.sourceDatabase) as Db;
      const store = new MongoKgSourceStore(client, db.collection<AsrDoc>(config.kg.sourceCollection));
      return store;
    } catch (err) {
      log.warn(`[KG_SOURCES] connect failed (KG build will be unable to read ASR text): ${err instanceof Error ? err.message : err}`);
      await client.close().catch(() => undefined);
      return null;
    }
  }

  async getLatest(bvid: string, cid: number): Promise<AsrTranscript | undefined> {
    const doc = await this.col
      .findOne({ bvid, cid, is_latest: true } as Record<string, unknown>, { sort: { version: -1 } });
    if (!doc) return undefined;
    return {
      content: doc.content ?? "",
      pageTitle: doc.page_title ?? "",
    };
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => undefined);
  }
}
