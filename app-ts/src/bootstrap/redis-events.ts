import { Redis } from "ioredis";
import { config } from "../config/index.js";
import { createLogger } from "../logger.js";
import type { VideoVectorizerService } from "../services/video-vectorizer.js";

const log = createLogger("BILI_EVENTS");

/**
 * Redis pub/sub bridge — the AI side's successor of the Python
 * bili_event_bridge. app-bili (Go) publishes:
 *   `bili:page_ready` — one ASR'd page → triggers per-page vectorization
 *       (idempotent task; state lives in the vector task repository).
 *   `bili:tasks`      — task progress. The old consumer was the Python WS
 *       fan-out; frontendv2 has no WebSocket consumer, so this bridge only
 *       logs at debug level (drop the handler when a real consumer appears).
 *
 * Redis unavailable at startup → periodic retry; connection drops reconnect
 * via ioredis's built-in retry strategy.
 */

const CHANNEL_PAGE_READY = "bili:page_ready";
const CHANNEL_TASKS = "bili:tasks";
const RESTART_DELAY_MS = 5000;

export class BiliEventBridge {
  private subscriber: Redis | null = null;
  private stopped = false;
  private retryTimer: NodeJS.Timeout | null = null;

  constructor(private readonly vectorizer: VideoVectorizerService) {}

  async start(): Promise<void> {
    if (!config.redis.url) {
      log.info("[BRIDGE] redis url not configured — bili:page_ready subscriber disabled");
      return;
    }
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    try {
      const subscriber = new Redis(config.redis.url, {
        lazyConnect: false,
        maxRetriesPerRequest: null,
        retryStrategy: (times: number) => Math.min(times * 1000, 30_000),
      });
      subscriber.on("error", (err: Error) => {
        log.warn(`[BRIDGE] redis error: ${err.message}`);
      });
      await subscriber.subscribe(CHANNEL_PAGE_READY, CHANNEL_TASKS);
      subscriber.on("message", (channel: string, payload: string) => {
        void this.handle(channel, payload).catch((err) => {
          log.warn(`[BRIDGE] handler error: ${err instanceof Error ? err.message : err}`);
        });
      });
      this.subscriber = subscriber;
      log.info(`[BRIDGE] subscribed channels=[${CHANNEL_PAGE_READY}, ${CHANNEL_TASKS}]`);
    } catch (err) {
      log.warn(`[BRIDGE] subscribe failed, retrying in ${RESTART_DELAY_MS / 1000}s: ${err instanceof Error ? err.message : err}`);
      this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, RESTART_DELAY_MS);
  }

  private async handle(channel: string, payload: string): Promise<void> {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      log.warn(`[BRIDGE] invalid payload on ${channel}`);
      return;
    }
    if (channel === CHANNEL_PAGE_READY) {
      const uid = String(data.uid); // 字符串承载，避免 int64 精度丢失
      const bvid = typeof data.bvid === "string" ? data.bvid : "";
      const cid = Number(data.cid);
      if (!uid || uid === "0" || !bvid || !Number.isFinite(cid)) {
        log.warn(`[BRIDGE] page_ready missing fields: ${payload.slice(0, 200)}`);
        return;
      }
      const result = await this.vectorizer.createTask({
        uid,
        bvid,
        cid,
        pageIndex: Number(data.page_index ?? 0) || 0,
        pageTitle: typeof data.page_title === "string" ? data.page_title : undefined,
      });
      log.info(`[BRIDGE] vectorization triggered bvid=${bvid} cid=${cid} task=${result.task_id ?? "skipped"}`);
      return;
    }
    // bili:tasks — no live consumer since the Python WS registry retired.
    log.debug(`[BRIDGE] task progress (no consumer): ${payload.slice(0, 200)}`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.subscriber) {
      await this.subscriber.quit().catch(() => this.subscriber?.disconnect());
      this.subscriber = null;
    }
  }
}
