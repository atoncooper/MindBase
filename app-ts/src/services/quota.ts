import { createHash } from "node:crypto";
import { config } from "../config/index.js";
import { createLogger } from "../logger.js";
import { resolveTier, resolveTierDetailed, type ResolvedTier } from "../utils/membership.js";
import { costMicroYuan, type UsagePrices } from "../repository/usage-ledger.js";
import type { QuotaCounterStore } from "../repository/quota.js";
import type { DegradeLevel } from "../utils/degrade.js";

const log = createLogger("QUOTA");

export type QuotaTier = "free" | "vip" | "svip" | "promax";
export type { DegradeLevel };

/** 三层窗口：滚动 5 小时 / 自然日 / 自然月（上海时区）。 */
export type QuotaWindow = "five_hour" | "day" | "month";

export type QuotaKind =
  | "chat"
  | "chat_anon"
  | "chat_images"
  | "generate"
  | "grade"
  | "kg_build"
  | "vectorize"
  | "ocr"
  | "board"
  | "coding_plan"
  | "task_quiz_active"
  | "academic_analysis"
  | "academic_validation"
  | "academic_export"
  | "academic_experiment"
  | "office_export";

export type QuotaVerdict = "allow" | "quota_exceeded" | "cost_guard";

/** Human label for a quota window (SSE/HTTP error messages). */
export function quotaWindowName(window: QuotaWindow): string {
  if (window === "five_hour") return "5 小时滚动";
  if (window === "month") return "本月";
  return "今日";
}

export interface TurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/** One budget window as shown to the client / used for gating. */
export interface QuotaWindowState {
  window: QuotaWindow;
  /** normalized tokens consumed in this window */
  used: number;
  /** normalized token budget; -1 = unlimited */
  limit: number;
  /** epoch ms when the window has fully rolled over */
  resetAt: number;
  usedPercent: number | null;
  remainingPercent: number | null;
}

/** Turn-start gate: the quota layer's whole decision for this chat turn. */
export interface QuotaGate {
  verdict: QuotaVerdict;
  kind: QuotaKind;
  tier: QuotaTier;
  /** the blocking window (quota_exceeded) or the primary day window (allow) */
  window: QuotaWindow;
  used: number;
  limit: number;
  /** epoch ms of the window reset (day = next local midnight; month = next local month) */
  resetAt: number;
  /** degrade ladder level for this turn */
  level: DegradeLevel;
  /** running cost of the day (micro-Yuan) */
  costMicroYuan: number;
  /** counter store unavailable → verdict was chosen fail-open */
  storeUnavailable: boolean;
  /** all three windows at gate time (diagnostics / summary reuse) */
  windows?: QuotaWindowState[];
}

export interface QuotaKindSummary {
  kind: QuotaKind;
  /** normalized tokens consumed today */
  used: number;
  /** -1 = shared pool (no per-kind cap) */
  limit: number;
  resetAt: number;
  /** share of the day budget 0-100（limit<=0 时为 null） */
  usedPercent: number | null;
  remainingPercent: number | null;
}

export interface QuotaPlanSummary {
  priceYuan: number;
  /** included monthly normalized tokens */
  monthlyTokens: number;
  /** included list-price value (yuan): monthlyTokens × reference price */
  valueYuan: number;
  /** valueYuan / priceYuan (0 for free plans) */
  bonus: number;
  referencePricePerMTok: number;
  fiveHourTokens: number;
  dailyTokens: number;
}

/** One purchasable tier's token allowance (upgrade comparison). */
export interface QuotaPlanOption extends QuotaPlanSummary {
  tier: QuotaTier;
}

export interface QuotaModelRate {
  model: string;
  inputWeight: number;
  outputWeight: number;
  price?: { input: number; output: number };
}

/** Coding Plan（用户自带第三方套餐）单模型用量。 */
export interface QuotaCodingPlanModelUsage {
  model: string;
  /** 今日该模型实际消耗的 tokens */
  tokens: number;
}

/**
 * 用户自带 Coding Plan 的 token 用量：由第三方套餐支付，不计入平台 Credits。
 * 独立计数，与平台额度窗口/成本完全隔离——只统计、不限额。
 */
export interface QuotaCodingPlanUsage {
  /** 滚动 5 小时窗口内实际 token */
  fiveHourTokens: number;
  /** 自然日实际 token */
  dayTokens: number;
  /** 自然月实际 token */
  monthTokens: number;
  /** 今日按模型拆分（只含进程内见过的模型；token 总量不受影响） */
  byModel?: QuotaCodingPlanModelUsage[];
  /** 今日已计量的 Coding Plan 轮次 */
  turns: number;
}

export interface QuotaSummary {
  enabled: boolean;
  tier: QuotaTier;
  /**
   * "app-pay" = 档位来自 app-pay 权威应答；"fallback" = 会员查询失败（网络/
   * 鉴权/未配置 key）→ 按免费档展示。
   */
  tierSource: "app-pay" | "fallback";
  /** all usage is normalized token based */
  unit: "credit";
  windows: QuotaWindowState[];
  plan: QuotaPlanSummary;
  /** per-kind token breakdown (shared pool; no per-kind caps) */
  kinds: QuotaKindSummary[];
  /** model weight table so the client can explain expensive models burn faster */
  models: QuotaModelRate[];
  /** all tier allowances for upgrade comparison */
  planCatalog: QuotaPlanOption[];
  cost: {
    microYuan: number;
    softMicroYuan: number;
    guardMicroYuan: number;
    guardEnabled: boolean;
    level: DegradeLevel;
    resetAt: number;
  };
  /**
   * 用户自带 Coding Plan 的 token 用量（5h/日/月 + 今日按模型 + 轮次）：
   * 由套餐支付，不占平台 Credits；老版本客户端忽略该字段即可。
   */
  codingPlan: QuotaCodingPlanUsage;
  storeUnavailable: boolean;
}

/** 0-100 integer percentage; null means unlimited (limit<=0). */
export function quotaPercent(used: number, limit: number): number | null {
  if (limit <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((used / limit) * 100)));
}

/** TTL for day-scoped keys: well past midnight; the key carries the day. */
const DAY_TTL_SECONDS = 48 * 3600;
/** Monthly keys carry YYYYMM; 40 days covers the longest month. */
const MONTH_TTL_SECONDS = 40 * 86_400;
/** FIFO bound on the in-process Coding Plan model-id index used for byModel keys. */
const MAX_EXTERNAL_MODEL_IDS = 64;

/** sha256(ip) prefix — the anon bucket must not be reversible to an IP. */
export function hashClientKey(ip: string): string {
  return createHash("sha256").update(ip).digest("hex").slice(0, 24);
}

const PARTS_FORMATS = new Map<string, Intl.DateTimeFormat>();

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function localParts(now: Date): LocalParts {
  const tz = config.timezone.name;
  let fmt = PARTS_FORMATS.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    PARTS_FORMATS.set(tz, fmt);
  }
  const parts = fmt.formatToParts(now);
  const read = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

/** Epoch ms of the NEXT local midnight (config timezone; Asia/Shanghai has no DST). */
export function nextMidnight(now: Date): number {
  const p = localParts(now);
  const elapsedMs = (p.hour * 3600 + p.minute * 60 + p.second) * 1000;
  return now.getTime() - elapsedMs + 86_400_000;
}

/** Timezone offset (ms) of the wall clock at the instant: local wall time - UTC instant. */
function timezoneOffsetMs(at: Date): number {
  const p = localParts(at);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wallAsUtc - at.getTime();
}

/**
 * Epoch ms of the NEXT local month start (00:00 on the 1st, config timezone).
 * Uses the offset of the previous day and corrects once for DST boundaries.
 */
export function nextMonthStart(now: Date): number {
  const p = localParts(now);
  const firstOfNextAsUtc = Date.UTC(p.year, p.month, 1, 0, 0, 0);
  const previousOffset = timezoneOffsetMs(new Date(firstOfNextAsUtc - 86_400_000));
  let target = firstOfNextAsUtc - previousOffset;
  const exactOffset = timezoneOffsetMs(new Date(target));
  if (exactOffset !== previousOffset) target = firstOfNextAsUtc - exactOffset;
  return target;
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

function monthCompact(now: Date): string {
  const p = localParts(now);
  return String(p.year) + String(p.month).padStart(2, "0");
}

/**
 * Best-effort token estimate for providers that omit usage. Chinese counts ~1
 * token/char, Latin ~4 chars/token; used only as a billing fallback.
 */
export function estimateTokens(text: string | undefined): number {
  if (!text) return 0;
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length;
  const rest = Math.max(0, text.length - cjk);
  return Math.max(1, Math.ceil(cjk + rest / 4));
}

function clampWeight(weight: number): number {
  if (!Number.isFinite(weight) || weight <= 0) return 1;
  return Math.min(1000, Math.max(0.000001, weight));
}

/**
 * A model's quota weight: list price / reference price. Expensive models burn
 * the shared token budget faster; cheap models stretch it. Explicit
 * quota.modelWeights overrides the derivation (promo / negotiated rates).
 */
export function modelQuotaRate(model: string): { inputWeight: number; outputWeight: number } {
  if (isExternalModel(model)) return { inputWeight: 0, outputWeight: 0 };
  const explicit = config.quota.modelWeights?.[model];
  const reference = config.quota.referencePricePerMTok > 0 ? config.quota.referencePricePerMTok : 10;
  const price = config.quota.prices?.[model] ?? config.quota.prices?.[config.llm.model];
  const derivedInput = price && price.input > 0 ? price.input / reference : 1;
  const derivedOutput = price && price.output > 0 ? price.output / reference : 1;
  // Explicit 0 is meaningful (a free/promo model); derived values fall back to 1.
  const explicitWeight = (value: number | undefined, derived: number): number =>
    value == null ? clampWeight(derived) : Math.min(1000, Math.max(0, value));
  return {
    inputWeight: explicitWeight(explicit?.input, derivedInput),
    outputWeight: explicitWeight(explicit?.output, derivedOutput),
  };
}

/** Models paid outside the platform (Coding Plan) never consume platform quota. */
export function isExternalModel(model: string): boolean {
  return (config.quota.externalModels ?? []).includes(model);
}

/** The model list price used for cost accounting (falls back to the service default). */
export function priceFor(model: string): UsagePrices | undefined {
  return config.quota.prices?.[model] ?? config.quota.prices?.[config.llm.model];
}

/**
 * Convert raw provider usage into normalized quota tokens. One rounding per
 * turn (ceil): partial tokens are never free, and a failed turn never reaches
 * this function (consume-on-success).
 */
export function quotaTokensFor(model: string, usage: TurnUsage | undefined): number {
  if (!usage || isExternalModel(model)) return 0;
  const input = Math.max(0, usage.inputTokens ?? 0);
  let output = Math.max(0, usage.outputTokens ?? 0);
  const total = Math.max(0, usage.totalTokens ?? 0);
  if (output === 0 && total > input) output = total - input;
  if (input === 0 && output === 0 && total > 0) output = total;
  const rate = modelQuotaRate(model);
  const raw = input * rate.inputWeight + output * rate.outputWeight;
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.ceil(raw - 1e-9);
}

/**
 * 原始 provider token 总量（input + output，不乘平台权重）：用于用户自带
 * Coding Plan 的「实际消耗」统计。容忍只上报 total 的实现，非法值按 0 处理。
 */
export function rawTokensFor(usage: TurnUsage | undefined): number {
  if (!usage) return 0;
  const count = (value: number | undefined): number =>
    value != null && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  const input = count(usage.inputTokens);
  let output = count(usage.outputTokens);
  const total = count(usage.totalTokens);
  if (output === 0 && total > input) output = total - input;
  if (input === 0 && output === 0 && total > 0) output = total;
  return input + output;
}

/** Kinds shown in the per-kind breakdown. */
const TRACKED_KINDS: QuotaKind[] = [
  "chat",
  "chat_anon",
  "chat_images",
  "generate",
  "grade",
  "kg_build",
  "vectorize",
  "ocr",
  "board",
  "academic_analysis",
  "academic_validation",
  "academic_export",
  "academic_experiment",
  "office_export",
];

interface TierPlan {
  priceYuan: number;
  fiveHourTokens: number;
  dailyTokens: number;
  monthlyTokens: number;
  valueYuan: number;
}

/**
 * Unified AI quota: normalized tokens over a rolling 5-hour window, the local
 * calendar day, and the local calendar month. All AI capabilities share one
 * pool (chat actual usage; other operations estimated per call).
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
  private readonly tierDetailOf: (uid: string | undefined) => Promise<ResolvedTier>;
  /** 进程内见过的 Coding Plan 模型 id（Redis 计数键无法枚举，仅作 byModel 的键名候选）。 */
  private readonly externalModelsSeen = new Set<string>();

  constructor(opts: {
    counter: QuotaCounterStore;
    resolveTier?: (uid: string | undefined) => Promise<string>;
    now?: () => Date;
  }) {
    this.counter = opts.counter;
    this.tierOf = opts.resolveTier ?? resolveTier;
    this.tierDetailOf = opts.resolveTier
      ? async (uid) => ({ tier: await opts.resolveTier!(uid), source: "app-pay" })
      : resolveTierDetailed;
    this.nowFn = opts.now ?? (() => new Date());
  }

  private tierNormalize(raw: string): QuotaTier {
    return raw === "vip" || raw === "svip" || raw === "promax" ? raw : "free";
  }

  private planFor(tier: QuotaTier): TierPlan {
    const raw = config.quota.plans?.[tier] ?? config.quota.plans?.free;
    if (!raw) {
      return { priceYuan: 0, fiveHourTokens: -1, dailyTokens: -1, monthlyTokens: -1, valueYuan: 0 };
    }
    const priceYuan = raw.priceYuan ?? 0;
    const reference = config.quota.referencePricePerMTok > 0 ? config.quota.referencePricePerMTok : 10;
    const derivedMonthly = Math.max(
      0,
      Math.round(((priceYuan * Math.max(0, config.quota.planBonus ?? 0)) / reference) * 1_000_000),
    );
    // Partial local.yaml overrides must not silently block traffic: missing
    // windows are unlimited (-1), not zero.
    const dailyTokens = raw.dailyTokens ?? -1;
    const fiveHourTokens = raw.fiveHourTokens ?? (dailyTokens > 0 ? Math.ceil(dailyTokens / 5) : -1);
    const monthlyTokens = raw.monthlyTokens ?? (priceYuan > 0 ? derivedMonthly : -1);
    return {
      priceYuan,
      fiveHourTokens,
      dailyTokens,
      monthlyTokens,
      valueYuan: monthlyTokens > 0 ? (monthlyTokens * reference) / 1_000_000 : 0,
    };
  }

  /** Legacy count cap lookup — stock caps + Coding Plan only. */
  limitFor(kind: QuotaKind, tier: QuotaTier): number {
    return config.quota.limits?.[kind]?.[tier] ?? -1;
  }

  private tokenBase(id: string): string {
    return "mind-base:quota:tokens:" + id;
  }

  /** Rolling-window bucket keys: platform token and external (Coding Plan) counters share the scheme. */
  private rollingKeys(prefix: string, now: Date): string[] {
    const bucketMinutes = Math.max(1, config.quota.bucketMinutes || 5);
    const windowMinutes = Math.max(bucketMinutes, config.quota.fiveHourMinutes || 300);
    const bucketCount = Math.max(1, Math.ceil(windowMinutes / bucketMinutes));
    const bucket = Math.floor(now.getTime() / (bucketMinutes * 60_000));
    const keys: string[] = [];
    for (let i = 0; i < bucketCount; i += 1) keys.push(prefix + ":" + String(bucket - i));
    return keys;
  }

  private fiveHourKeys(id: string, now: Date): string[] {
    return this.rollingKeys(this.tokenBase(id) + ":5h", now);
  }

  private fiveHourTtlSeconds(): number {
    const windowMinutes = Math.max(1, config.quota.fiveHourMinutes || 300);
    const bucketMinutes = Math.max(1, config.quota.bucketMinutes || 5);
    return (windowMinutes + bucketMinutes) * 60 + 3600;
  }

  private fiveHourResetAt(now: Date): number {
    return now.getTime() + Math.max(1, config.quota.fiveHourMinutes || 300) * 60_000;
  }

  private dayKey(id: string, now: Date): string {
    return this.tokenBase(id) + ":day:" + dayCompact(now);
  }

  private monthKey(id: string, now: Date): string {
    return this.tokenBase(id) + ":month:" + monthCompact(now);
  }

  /**
   * 平台代付之外（Coding Plan）的独立计数键：与平台 token / cost / kind 键完全
   * 隔离，因此统计 Coding Plan 用量绝不会移动平台额度窗口。
   */
  private externalBase(id: string): string {
    return "mind-base:quota:external:" + id;
  }

  private externalFiveHourKeys(id: string, now: Date): string[] {
    return this.rollingKeys(this.externalBase(id) + ":5h", now);
  }

  private externalDayKey(id: string, now: Date): string {
    return this.externalBase(id) + ":day:" + dayCompact(now);
  }

  private externalMonthKey(id: string, now: Date): string {
    return this.externalBase(id) + ":month:" + monthCompact(now);
  }

  private externalTurnsKey(id: string, now: Date): string {
    return this.externalBase(id) + ":turns:" + dayCompact(now);
  }

  private externalModelDayKey(id: string, now: Date, model: string): string {
    return this.externalBase(id) + ":model:" + dayCompact(now) + ":" + model;
  }

  private kindKey(kind: QuotaKind, id: string, now: Date): string {
    return "mind-base:quota:kind:" + kind + ":" + id + ":" + dayCompact(now);
  }

  /** Public for tests/ops inspection. */
  costKey(id: string, now: Date): string {
    return "mind-base:quota:cost:" + id + ":" + dayCompact(now);
  }

  private codingPlanKey(id: string, now: Date): string {
    return "mind-base:quota:coding_plan:" + id + ":" + dayCompact(now);
  }

  /** Counter key for a kind (legacy helper retained for tests/ops). */
  keyFor(kind: QuotaKind, id: string, now: Date): string {
    return kind === "coding_plan" ? this.codingPlanKey(id, now) : this.kindKey(kind, id, now);
  }

  private kindCost(kind: QuotaKind): number {
    return Math.max(0, config.quota.kindTokenCost?.[kind] ?? 0);
  }

  /** uid → logged-in; clientKey(IP hash) → anon; neither → unattributable. */
  private identity(uid: string | undefined, clientKey: string | undefined): { id: string; kind: "chat" | "chat_anon" } | null {
    if (uid) return { id: uid, kind: "chat" };
    if (clientKey) return { id: clientKey, kind: "chat_anon" };
    return null;
  }

  private async readWindows(
    id: string,
    tier: QuotaTier,
    now: Date,
  ): Promise<{ windows: QuotaWindowState[]; unavailable: boolean }> {
    const plan = this.planFor(tier);
    const [five, day, month] = await Promise.all([
      this.counter.sum(this.fiveHourKeys(id, now)),
      this.counter.count(this.dayKey(id, now)),
      this.counter.count(this.monthKey(id, now)),
    ]);
    const unavailable = five === null || day === null || month === null;
    const values = [five ?? 0, day ?? 0, month ?? 0];
    const limits = [plan.fiveHourTokens, plan.dailyTokens, plan.monthlyTokens];
    const resets = [this.fiveHourResetAt(now), nextMidnight(now), nextMonthStart(now)];
    const names: QuotaWindow[] = ["five_hour", "day", "month"];
    const windows: QuotaWindowState[] = names.map((window, index) => {
      const used = values[index] ?? 0;
      const limit = limits[index] ?? 0;
      const usedPercent = quotaPercent(used, limit);
      return {
        window,
        used,
        limit,
        resetAt: resets[index] ?? now.getTime(),
        usedPercent,
        remainingPercent: usedPercent === null ? null : Math.max(0, 100 - usedPercent),
      };
    });
    return { windows, unavailable };
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
    const plan = this.planFor(tier);
    const { windows, unavailable } = await this.readWindows(identity.id, tier, now);
    const day = windows[1] ?? {
      window: "day" as const,
      used: 0,
      limit: plan.dailyTokens,
      resetAt: nextMidnight(now),
      usedPercent: null,
      remainingPercent: null,
    };
    const base: QuotaGate = {
      verdict: "allow",
      kind: identity.kind,
      tier,
      window: "day",
      used: day.used,
      limit: day.limit,
      resetAt: day.resetAt,
      level: "L0",
      costMicroYuan: 0,
      storeUnavailable: unavailable,
      windows,
    };
    if (unavailable) {
      log.warn("[QUOTA] store unavailable, fail-open kind=" + identity.kind + " id=" + identity.id.slice(0, 8) + "…");
      return base;
    }
    const level = this.degradeLevel(tier, day.used, day.limit);
    const costVal = (await this.counter.count(this.costKey(identity.id, now))) ?? 0;
    const blocked = windows.find((w) => w.limit >= 0 && w.used >= w.limit);
    if (!blocked && config.quota.costGuardEnabled) {
      const guard = config.quota.costGuardMicroYuan?.[tier] ?? 0;
      if (guard > 0 && costVal >= guard) {
        return { ...base, verdict: "cost_guard", level, costMicroYuan: costVal };
      }
    }
    const primary = blocked ?? day;
    return {
      ...base,
      verdict: blocked ? "quota_exceeded" : "allow",
      window: primary.window,
      used: primary.used,
      limit: primary.limit,
      resetAt: primary.resetAt,
      level,
      costMicroYuan: costVal,
    };
  }

  /**
   * Consume one successful chat turn: normalized tokens into the 5h/day/month
   * windows + the per-kind breakdown + the day cost ledger. Returns the quota
   * tokens charged (0 when no usage was reported).
   */
  async completeChatTurn(
    uid: string | undefined,
    clientKey: string | undefined,
    usage: TurnUsage | undefined,
    model: string,
  ): Promise<number> {
    if (!config.quota.enabled) return 0;
    const identity = this.identity(uid, clientKey);
    if (!identity) return 0;
    const tokens = quotaTokensFor(model, usage);
    const now = this.nowFn();
    if (tokens > 0) {
      await this.addUsage(identity.id, identity.kind, tokens, now);
    }
    const micro = isExternalModel(model)
      ? 0
      : costMicroYuan(usage?.inputTokens ?? 0, usage?.outputTokens ?? 0, priceFor(model));
    if (micro > 0) {
      await this.counter.add(this.costKey(identity.id, now), micro, DAY_TTL_SECONDS);
    }
    return tokens;
  }

  private async addUsage(id: string, kind: QuotaKind, tokens: number, now: Date): Promise<void> {
    if (tokens <= 0) return;
    const fiveKey = this.fiveHourKeys(id, now)[0];
    if (!fiveKey) return;
    const ok = await this.counter.addMany([
      { key: fiveKey, delta: tokens, ttlSeconds: this.fiveHourTtlSeconds() },
      { key: this.dayKey(id, now), delta: tokens, ttlSeconds: DAY_TTL_SECONDS },
      { key: this.monthKey(id, now), delta: tokens, ttlSeconds: MONTH_TTL_SECONDS },
      { key: this.kindKey(kind, id, now), delta: tokens, ttlSeconds: DAY_TTL_SECONDS },
    ]);
    if (ok === null) {
      log.warn("[QUOTA] usage write failed (fail-open) kind=" + kind + " tokens=" + tokens);
    }
  }

  /**
   * 记录一次平台代付之外（用户自带 Coding Plan）的成功轮次：只写独立计数
   * （5h / 日 / 月 + 今日轮次 + 今日按模型），不写平台窗口、不写成本、不动
   * kind 明细。token 为 provider 实际上报的 input + output（缺失时调用方用与
   * 平台轮次相同的估算兜底），不做平台权重归一。
   *
   * 不受 quota.enabled 门禁影响：这是「用户自付套餐」的用量账本，只统计、不限额。
   */
  async recordExternalTurn(
    uid: string | undefined,
    clientKey: string | undefined,
    usage: TurnUsage | undefined,
    model: string,
    source = "coding_plan",
  ): Promise<number> {
    const identity = this.identity(uid, clientKey);
    if (!identity) return 0;
    const tokens = rawTokensFor(usage);
    if (tokens <= 0) return 0;
    const now = this.nowFn();
    const fiveKey = this.externalFiveHourKeys(identity.id, now)[0];
    if (!fiveKey) return 0;
    const modelId = model.trim() || "unknown";
    this.noteExternalModel(modelId);
    const ok = await this.counter.addMany([
      { key: fiveKey, delta: tokens, ttlSeconds: this.fiveHourTtlSeconds() },
      { key: this.externalDayKey(identity.id, now), delta: tokens, ttlSeconds: DAY_TTL_SECONDS },
      { key: this.externalMonthKey(identity.id, now), delta: tokens, ttlSeconds: MONTH_TTL_SECONDS },
      { key: this.externalTurnsKey(identity.id, now), delta: 1, ttlSeconds: DAY_TTL_SECONDS },
      {
        key: this.externalModelDayKey(identity.id, now, modelId),
        delta: tokens,
        ttlSeconds: DAY_TTL_SECONDS,
      },
    ]);
    if (ok === null) {
      log.warn(
        "[QUOTA] external usage write failed (fail-open) source=" + source + " model=" + modelId + " tokens=" + tokens,
      );
    }
    return tokens;
  }

  /** byModel 的键名候选 = 本进程见过的模型 ∪ 配置里的 externalModels。 */
  private externalModelCandidates(): string[] {
    const models = new Set<string>(this.externalModelsSeen);
    for (const model of config.quota.externalModels ?? []) {
      if (model) models.add(model);
    }
    return [...models];
  }

  /** 记录见过的 Coding Plan 模型（仅用于 byModel 的键名，FIFO 上限 64）。 */
  private noteExternalModel(model: string): void {
    if (!model || this.externalModelsSeen.has(model)) return;
    if (this.externalModelsSeen.size >= MAX_EXTERNAL_MODEL_IDS) {
      const oldest = this.externalModelsSeen.values().next().value;
      if (oldest !== undefined) this.externalModelsSeen.delete(oldest);
    }
    this.externalModelsSeen.add(model);
  }

  /**
   * Coding Plan（平台代付之外）用量：5h / 日 / 月实际 token + 今日轮次 +
   * 今日按模型拆分。只读独立计数键；计数存储不可用时按 0 返回（fail-open）。
   */
  private async readCodingPlanUsage(id: string | undefined, now: Date): Promise<QuotaCodingPlanUsage> {
    if (!id) return { fiveHourTokens: 0, dayTokens: 0, monthTokens: 0, turns: 0 };
    const [five, day, month, turns] = await Promise.all([
      this.counter.sum(this.externalFiveHourKeys(id, now)),
      this.counter.count(this.externalDayKey(id, now)),
      this.counter.count(this.externalMonthKey(id, now)),
      this.counter.count(this.externalTurnsKey(id, now)),
    ]);
    const byModel: QuotaCodingPlanModelUsage[] = [];
    for (const model of this.externalModelCandidates()) {
      const tokens = (await this.counter.count(this.externalModelDayKey(id, now, model))) ?? 0;
      if (tokens > 0) byModel.push({ model, tokens });
    }
    byModel.sort((a, b) => b.tokens - a.tokens);
    return {
      fiveHourTokens: five ?? 0,
      dayTokens: day ?? 0,
      monthTokens: month ?? 0,
      ...(byModel.length > 0 ? { byModel } : {}),
      turns: turns ?? 0,
    };
  }

  /**
   * Check-only estimate for an upcoming operation (e.g. chat image attachments).
   * The actual charge comes from the turn's provider usage, so images are not
   * double-charged and failed turns stay free. Over budget → false; nothing written.
   */
  async canConsume(
    uid: string | undefined,
    clientKey: string | undefined,
    kind: QuotaKind,
    n: number,
  ): Promise<boolean> {
    if (!config.quota.enabled || n <= 0) return true;
    const identity = this.identity(uid, clientKey);
    if (!identity) return true;
    const cost = this.kindCost(kind) * n;
    if (cost <= 0) return true;
    const now = this.nowFn();
    const tier = this.tierNormalize(await this.tierOf(uid));
    const { windows, unavailable } = await this.readWindows(identity.id, tier, now);
    if (unavailable) return true;
    return !windows.some((w) => w.limit >= 0 && w.used + cost > w.limit);
  }

  /**
   * Peek any kind without writing — the fast-fail half of two-phase flows.
   * Returns null when quota is disabled or the store is unavailable.
   */
  async peekKind(uid: string, kind: QuotaKind, n = 1): Promise<QuotaGate | null> {
    if (!config.quota.enabled || !uid) return null;
    const now = this.nowFn();
    const tier = this.tierNormalize(await this.tierOf(uid));
    const plan = this.planFor(tier);

    if (kind === "coding_plan") {
      const limit = this.limitFor(kind, tier);
      const count = await this.counter.count(this.codingPlanKey(uid, now));
      if (count === null) return null;
      const { windows } = await this.readWindows(uid, tier, now);
      const day = windows[1];
      return {
        verdict: limit >= 0 && count + Math.max(1, n) > limit ? "quota_exceeded" : "allow",
        kind,
        tier,
        window: "day",
        used: count,
        limit,
        resetAt: nextMidnight(now),
        level: day ? this.degradeLevel(tier, day.used, day.limit) : "L0",
        costMicroYuan: 0,
        storeUnavailable: false,
        windows,
      };
    }

    const cost = this.kindCost(kind) * Math.max(1, n);
    const { windows, unavailable } = await this.readWindows(uid, tier, now);
    if (unavailable) return null;
    const day = windows[1] ?? {
      window: "day" as const,
      used: 0,
      limit: plan.dailyTokens,
      resetAt: nextMidnight(now),
      usedPercent: null,
      remainingPercent: null,
    };
    const blocked = cost > 0 ? windows.find((w) => w.limit >= 0 && w.used + cost > w.limit) : undefined;
    const primary = blocked ?? day;
    return {
      verdict: blocked ? "quota_exceeded" : "allow",
      kind,
      tier,
      window: primary.window,
      used: primary.used,
      limit: primary.limit,
      resetAt: primary.resetAt,
      level: this.degradeLevel(tier, day.used, day.limit),
      costMicroYuan: 0,
      storeUnavailable: false,
      windows,
    };
  }

  /**
   * Consume n estimated operations for a kind. Shared token pool: false when
   * the operation would overflow any window, nothing written.
   */
  async consumeKind(uid: string, kind: QuotaKind, n = 1): Promise<boolean> {
    if (!config.quota.enabled || !uid || n <= 0) return true;
    const now = this.nowFn();
    const tier = this.tierNormalize(await this.tierOf(uid));

    if (kind === "coding_plan") {
      const limit = this.limitFor(kind, tier);
      if (limit < 0) return true;
      for (let i = 0; i < n; i += 1) {
        const res = await this.counter.consume(this.codingPlanKey(uid, now), limit, DAY_TTL_SECONDS);
        if (res === null) return true;
        if (!res.allowed) return false;
      }
      return true;
    }

    const cost = this.kindCost(kind) * n;
    if (cost <= 0) return true;
    const { windows, unavailable } = await this.readWindows(uid, tier, now);
    if (unavailable) return true;
    const blocked = windows.find((w) => w.limit >= 0 && w.used + cost > w.limit);
    if (blocked) return false;
    await this.addUsage(uid, kind, cost, now);
    return true;
  }

  /** Stock caps (e.g. active scheduled-quiz tasks): the tier's ceiling, -1 = unlimited. */
  async stockLimit(uid: string, kind: QuotaKind): Promise<number> {
    const tier = this.tierNormalize(await this.tierOf(uid));
    return this.limitFor(kind, tier);
  }

  /**
   * GET /quota/summary payload: three token windows + per-kind breakdown + cost,
   * plus the Coding Plan (user-paid external) token usage in its own section.
   */
  async summary(uid: string | undefined, clientKey?: string): Promise<QuotaSummary> {
    const now = this.nowFn();
    const detail = await this.tierDetailOf(uid);
    const tier = this.tierNormalize(detail.tier);
    const plan = this.planFor(tier);
    const planSummary = this.planSummary(plan);
    const planCatalog: QuotaPlanOption[] = (["free", "vip", "svip", "promax"] as QuotaTier[]).map((t) => ({
      tier: t,
      ...this.planSummary(this.planFor(t)),
    }));
    const identity = this.identity(uid, clientKey);
    // Coding Plan 用量是「用户自付」的独立账：不受 quota.enabled 门禁影响。
    const codingPlan = await this.readCodingPlanUsage(identity?.id, now);
    const resetAt = nextMidnight(now);
    const costBase = {
      microYuan: 0,
      softMicroYuan: config.quota.costSoftMicroYuan?.[tier] ?? 0,
      guardMicroYuan: config.quota.costGuardMicroYuan?.[tier] ?? 0,
      guardEnabled: config.quota.costGuardEnabled,
      level: "L0" as DegradeLevel,
      resetAt,
    };

    if (!config.quota.enabled || !identity) {
      return {
        enabled: config.quota.enabled,
        tier,
        tierSource: detail.source,
        unit: "credit",
        windows: this.zeroWindows(plan, now),
        plan: planSummary,
        kinds: [],
        models: this.modelRates(),
        planCatalog,
        cost: costBase,
        codingPlan,
        storeUnavailable: false,
      };
    }

    const { windows, unavailable } = await this.readWindows(identity.id, tier, now);
    const kinds: QuotaKindSummary[] = [];
    for (const kind of TRACKED_KINDS) {
      if (identity.kind === "chat_anon" ? kind === "chat" : kind === "chat_anon") continue;
      const used = (await this.counter.count(this.kindKey(kind, identity.id, now))) ?? 0;
      const usedPercent = plan.dailyTokens > 0 ? quotaPercent(used, plan.dailyTokens) : null;
      kinds.push({
        kind,
        used,
        limit: -1,
        resetAt,
        usedPercent,
        remainingPercent: usedPercent === null ? null : Math.max(0, 100 - usedPercent),
      });
    }
    const costVal = (await this.counter.count(this.costKey(identity.id, now))) ?? 0;
    const day = windows[1];
    return {
      enabled: true,
      tier,
      tierSource: detail.source,
      unit: "credit",
      windows,
      plan: planSummary,
      kinds,
      models: this.modelRates(),
      planCatalog,
      cost: {
        ...costBase,
        microYuan: costVal,
        level: day ? this.degradeLevel(tier, day.used, day.limit) : "L0",
      },
      codingPlan,
      storeUnavailable: unavailable,
    };
  }

  private zeroWindows(plan: TierPlan, now: Date): QuotaWindowState[] {
    const limits = [plan.fiveHourTokens, plan.dailyTokens, plan.monthlyTokens];
    const resets = [this.fiveHourResetAt(now), nextMidnight(now), nextMonthStart(now)];
    const names: QuotaWindow[] = ["five_hour", "day", "month"];
    return names.map((window, index) => {
      const limit = limits[index] ?? 0;
      const usedPercent = quotaPercent(0, limit);
      return {
        window,
        used: 0,
        limit,
        resetAt: resets[index] ?? now.getTime(),
        usedPercent,
        remainingPercent: usedPercent === null ? null : 100,
      };
    });
  }

  private planSummary(plan: TierPlan): QuotaPlanSummary {
    const reference = config.quota.referencePricePerMTok > 0 ? config.quota.referencePricePerMTok : 10;
    return {
      priceYuan: plan.priceYuan,
      monthlyTokens: plan.monthlyTokens,
      valueYuan: Math.round(plan.valueYuan * 100) / 100,
      bonus: plan.priceYuan > 0 ? Math.round((plan.valueYuan / plan.priceYuan) * 100) / 100 : 0,
      referencePricePerMTok: reference,
      fiveHourTokens: plan.fiveHourTokens,
      dailyTokens: plan.dailyTokens,
    };
  }

  private modelRates(): QuotaModelRate[] {
    const models = new Set([
      ...Object.keys(config.quota.prices ?? {}),
      ...Object.keys(config.quota.modelWeights ?? {}),
    ]);
    return [...models].sort().map((model) => {
      const rate = modelQuotaRate(model);
      const price = config.quota.prices?.[model];
      return { model, ...rate, ...(price ? { price: { input: price.input, output: price.output } } : {}) };
    });
  }

  /** Degrade ladder: switch to L1 when the day's token budget is mostly spent. */
  private degradeLevel(tier: QuotaTier, dayUsed: number, dayLimit: number): DegradeLevel {
    if (dayLimit <= 0) return "L0";
    const threshold = config.quota.degradeAtPercent?.[tier] ?? 100;
    return (dayUsed / dayLimit) * 100 >= threshold ? "L1" : "L0";
  }

  async close(): Promise<void> {
    await this.counter.close();
  }
}
