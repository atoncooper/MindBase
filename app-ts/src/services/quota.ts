import { createHash } from "node:crypto";
import { config } from "../config/index.js";
import { createLogger } from "../logger.js";
import { resolveTier } from "../utils/membership.js";
import { costMicroYuan } from "../repository/usage-ledger.js";
import type { QuotaCounterStore } from "../repository/quota.js";
import type { DegradeLevel } from "../utils/degrade.js";

const log = createLogger("QUOTA");

export type QuotaTier = "free" | "vip" | "svip";
export type { DegradeLevel };
export type QuotaKind =
  | "chat"        // logged-in chat turns
  | "chat_anon"   // anonymous chat turns (IP-hash bucket)
  | "chat_images" // chat image attachments (per image)
  | "generate"    // quiz generation batches (legacy app-quiz counter)
  | "grade"       // quiz grading calls (legacy app-quiz counter)
  | "kg_build"    // KG builds (per build)
  | "vectorize"   // per-page vectorization (per page)
  | "ocr"         // cloud OCR parsing
  | "board"       // board AI completions
  | "task_quiz_active"; // scheduled-quiz active-task cap (stock, not a daily counter)

export type QuotaVerdict = "allow" | "quota_exceeded" | "cost_guard";

export interface TurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/** Turn-start gate: the quota layer's whole decision for this chat turn. */
export interface QuotaGate {
  verdict: QuotaVerdict;
  kind: QuotaKind;
  tier: QuotaTier;
  used: number;
  limit: number;
  /** epoch ms of the next local midnight (Asia/Shanghai) */
  resetAt: number;
  /** degrade ladder level for this turn; context/model enforcement pending */
  level: DegradeLevel;
  /** running cost of the day (micro-Yuan) */
  costMicroYuan: number;
  /** counter store unavailable → verdict was chosen fail-open */
  storeUnavailable: boolean;
}

export interface QuotaKindSummary {
  kind: QuotaKind;
  used: number;
  /** -1 = unlimited */
  limit: number;
  resetAt: number;
}

export interface QuotaSummary {
  enabled: boolean;
  tier: QuotaTier;
  kinds: QuotaKindSummary[];
  cost: {
    microYuan: number;
    softMicroYuan: number;
    guardMicroYuan: number;
    guardEnabled: boolean;
    level: DegradeLevel;
    resetAt: number;
  };
}

/** TTL for day-scoped keys: well past midnight; the key carries the day, so expiry is just hygiene. */
const DAY_TTL_SECONDS = 48 * 3600;

/** sha256(ip) prefix — the anon bucket must not be reversible to an IP. */
export function hashClientKey(ip: string): string {
  return createHash("sha256").update(ip).digest("hex").slice(0, 24);
}

/** Epoch ms of the NEXT local midnight (config timezone; Asia/Shanghai has no DST). */
export function nextMidnight(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezone.name,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(now);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const elapsedMs = (get("hour") * 3600 + get("minute") * 60 + get("second")) * 1000;
  return now.getTime() - elapsedMs + 86_400_000;
}

const DAY_FORMATS = new Map<string, Intl.DateTimeFormat>();
function dayCompact(now: Date): string {
  const tz = config.timezone.name;
  let fmt = DAY_FORMATS.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    DAY_FORMATS.set(tz, fmt);
  }
  return fmt.format(now).replaceAll("-", "");
}

/** UTC calendar day, compact — app-quiz's legacy counter boundary (Beijing 08:00 reset). */
function utcDayCompact(now: Date): string {
  return now.toISOString().slice(0, 10).replaceAll("-", "");
}

/**
 * Member usage quota: Redis daily counters keyed
 * mind-base:quota:{kind}:{uid}:{YYYYMMDD} (Shanghai day); generate/grade share
 * app-quiz's legacy mind-base:quiz_quota:* counters (UTC day) so both stacks
 * keep one number during the cutover.
 *
 * Fail directions (guard-tested):
 *  - counter store unavailable  → fail-OPEN  (a Redis incident must not block chat)
 *  - app-pay tier unavailable   → fail-CLOSED to free (never oversell on a pay outage)
 * Counting is consume-on-success: failed/retried turns never consume.
 */
export class QuotaService {
  private readonly counter: QuotaCounterStore;
  private readonly tierOf: (uid: string | undefined) => Promise<string>;
  private readonly nowFn: () => Date;

  constructor(opts: {
    counter: QuotaCounterStore;
    resolveTier?: (uid: string | undefined) => Promise<string>;
    now?: () => Date;
  }) {
    this.counter = opts.counter;
    this.tierOf = opts.resolveTier ?? resolveTier;
    this.nowFn = opts.now ?? (() => new Date());
  }

  private tierNormalize(raw: string): QuotaTier {
    return raw === "vip" || raw === "svip" ? raw : "free";
  }

  limitFor(kind: QuotaKind, tier: QuotaTier): number {
    return config.quota.limits[kind]?.[tier] ?? -1; // unknown kind → unlimited (config is opt-in)
  }

  keyFor(kind: QuotaKind, id: string, now: Date): string {
    if (kind === "generate" || kind === "grade") {
      return `mind-base:quiz_quota:${kind}:${id}:${utcDayCompact(now)}`;
    }
    return `mind-base:quota:${kind}:${id}:${dayCompact(now)}`;
  }

  private costKey(id: string, now: Date): string {
    return `mind-base:quota:cost:${id}:${dayCompact(now)}`;
  }

  /** uid → logged-in kind; clientKey(IP hash) → anon kind; neither → unattributable. */
  private identity(uid: string | undefined, clientKey: string | undefined): { id: string; kind: QuotaKind } | null {
    if (uid) return { id: uid, kind: "chat" };
    if (clientKey) return { id: clientKey, kind: "chat_anon" };
    return null;
  }

  /**
   * Turn-start gate (before persistence/admission/harness). Returns null when
   * quota is disabled or the request is unattributable — callers skip gating.
   */
  async beginChatTurn(uid: string | undefined, clientKey?: string): Promise<QuotaGate | null> {
    const identity = this.identity(uid, clientKey);
    if (!config.quota.enabled || !identity) return null;
    const now = this.nowFn();
    const tier = this.tierNormalize(await this.tierOf(uid));
    const { id, kind } = identity;
    const limit = this.limitFor(kind, tier);
    const resetAt = nextMidnight(now);
    const base = { kind, tier, limit, resetAt, level: "L0" as DegradeLevel, costMicroYuan: 0, storeUnavailable: false };
    if (limit < 0) return { ...base, verdict: "allow", used: 0 };

    const [count, cost] = await Promise.all([
      this.counter.count(this.keyFor(kind, id, now)),
      this.counter.count(this.costKey(id, now)),
    ]);
    if (count === null) {
      log.warn(`[QUOTA] store unavailable, fail-open kind=${kind} id=${id.slice(0, 8)}…`);
      return { ...base, verdict: "allow", used: 0, storeUnavailable: true };
    }
    const costVal = cost ?? 0;
    const level = this.degradeLevel(tier, count, costVal);
    if (config.quota.costGuardEnabled) {
      const guard = config.quota.costGuardMicroYuan[tier] ?? 0;
      if (guard > 0 && costVal >= guard) {
        return { ...base, verdict: "cost_guard", used: count, level, costMicroYuan: costVal };
      }
    }
    if (count >= limit) {
      return { ...base, verdict: "quota_exceeded", used: count, level, costMicroYuan: costVal };
    }
    return { ...base, verdict: "allow", used: count, level, costMicroYuan: costVal };
  }

  /** Consume one turn + accumulate the day's cost; only called on success. */
  async completeChatTurn(
    uid: string | undefined,
    clientKey: string | undefined,
    usage: TurnUsage | undefined,
    model: string,
  ): Promise<void> {
    if (!config.quota.enabled) return;
    const identity = this.identity(uid, clientKey);
    if (!identity) return;
    const now = this.nowFn();
    await this.counter.add(this.keyFor(identity.kind, identity.id, now), 1, DAY_TTL_SECONDS);
    const micro = costMicroYuan(usage?.inputTokens ?? 0, usage?.outputTokens ?? 0, config.quota.prices[model]);
    if (micro > 0) {
      await this.counter.add(this.costKey(identity.id, now), micro, DAY_TTL_SECONDS);
    }
  }

  /**
   * Image attachments: check-then-add for a batch of n (race tolerance of one
   * batch is acceptable — the same tolerance the admission queue already has).
   * Over budget → false, nothing written.
   */
  async consumeImages(uid: string | undefined, clientKey: string | undefined, n: number): Promise<boolean> {
    if (!config.quota.enabled || n <= 0) return true;
    const identity = this.identity(uid, clientKey);
    if (!identity) return true;
    const now = this.nowFn();
    const tier = this.tierNormalize(await this.tierOf(uid));
    const limit = this.limitFor("chat_images", tier);
    if (limit < 0) return true;
    const key = this.keyFor("chat_images", identity.id, now);
    const cur = await this.counter.count(key);
    if (cur === null) return true; // fail-open
    if (cur + n > limit) return false;
    await this.counter.add(key, n, DAY_TTL_SECONDS);
    return true;
  }

  /**
   * Peek any counter kind without writing — the fast-fail half of two-phase
   * flows (peek before the expensive step, consume after it succeeds).
   * Returns null when quota is disabled or the store is unavailable → callers
   * fail open.
   */
  async peekKind(uid: string, kind: QuotaKind, n = 1): Promise<QuotaGate | null> {
    if (!config.quota.enabled || !uid) return null;
    const now = this.nowFn();
    const tier = this.tierNormalize(await this.tierOf(uid));
    const limit = this.limitFor(kind, tier);
    const count = await this.counter.count(this.keyFor(kind, uid, now));
    if (count === null) return null;
    return {
      verdict: limit >= 0 && count + n > limit ? "quota_exceeded" : "allow",
      kind,
      tier,
      used: count,
      limit,
      resetAt: nextMidnight(now),
      level: "L0",
      costMicroYuan: 0,
      storeUnavailable: false,
    };
  }

  /** Atomic consume of n units for a counter kind; false = over limit, nothing written. */
  async consumeKind(uid: string, kind: QuotaKind, n = 1): Promise<boolean> {
    if (!config.quota.enabled || !uid || n <= 0) return true;
    const now = this.nowFn();
    const tier = this.tierNormalize(await this.tierOf(uid));
    const limit = this.limitFor(kind, tier);
    if (limit < 0) return true;
    for (let i = 0; i < n; i += 1) {
      const res = await this.counter.consume(this.keyFor(kind, uid, now), limit, DAY_TTL_SECONDS);
      if (res === null) return true; // store unavailable mid-batch → fail open
      if (!res.allowed) return false;
    }
    return true;
  }

  /** Stock caps (e.g. active scheduled-quiz tasks): the tier's ceiling, -1 = unlimited. */
  async stockLimit(uid: string, kind: QuotaKind): Promise<number> {
    const tier = this.tierNormalize(await this.tierOf(uid));
    return this.limitFor(kind, tier);
  }

  /** GET /quota/summary payload: every configured kind + the cost block. */
  async summary(uid: string | undefined, clientKey?: string): Promise<QuotaSummary> {
    const now = this.nowFn();
    const tier = this.tierNormalize(await this.tierOf(uid));
    const resetAt = nextMidnight(now);
    const identity = this.identity(uid, clientKey);
    if (!config.quota.enabled || !identity) {
      return {
        enabled: config.quota.enabled,
        tier,
        kinds: [],
        cost: { microYuan: 0, softMicroYuan: 0, guardMicroYuan: 0, guardEnabled: false, level: "L0", resetAt },
      };
    }
    const kinds: QuotaKindSummary[] = [];
    let chatUsed = 0;
    for (const kind of Object.keys(config.quota.limits) as QuotaKind[]) {
      if (kind === "task_quiz_active") continue; // stock cap, not a daily counter — no meaningful "used"
      // 只返回与调用者身份相关的 kind：登录者不含未登录桶（chat_anon），未登录只看自己的桶
      if (identity.kind === "chat_anon" ? kind !== "chat_anon" : kind === "chat_anon") continue;
      const used = (await this.counter.count(this.keyFor(kind, identity.id, now))) ?? 0;
      if (kind === "chat") chatUsed = used;
      kinds.push({ kind, used, limit: this.limitFor(kind, tier), resetAt });
    }
    const costVal = (await this.counter.count(this.costKey(identity.id, now))) ?? 0;
    return {
      enabled: true,
      tier,
      kinds,
      cost: {
        microYuan: costVal,
        softMicroYuan: config.quota.costSoftMicroYuan[tier] ?? 0,
        guardMicroYuan: config.quota.costGuardMicroYuan[tier] ?? 0,
        guardEnabled: config.quota.costGuardEnabled,
        level: this.degradeLevel(tier, chatUsed, costVal),
        resetAt,
      },
    };
  }

  /** Degrade ladder: free by turn count, members by day cost. */
  private degradeLevel(tier: QuotaTier, chatCount: number, costVal: number): DegradeLevel {
    if (tier === "free") {
      return chatCount >= Math.max(1, config.quota.freeLadder.l0Turns) ? "L1" : "L0";
    }
    const soft = config.quota.costSoftMicroYuan[tier] ?? 0;
    return soft > 0 && costVal >= soft ? "L1" : "L0";
  }

  async close(): Promise<void> {
    await this.counter.close();
  }
}
