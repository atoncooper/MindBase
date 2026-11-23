/**
 * Quota API - 统一 AI 额度（token 口径，不是条数）.
 *
 * Backend contract: app-ts GET /quota/summary（X-Uid 由网关注入；匿名按 IP 桶）.
 * 三层窗口：滚动 5 小时 + 自然日 + 自然月；所有 AI 能力共享一个 token 池。
 */
import { request } from "./client";

export type QuotaTier = "free" | "vip" | "svip" | "promax";
export type QuotaWindow = "five_hour" | "day" | "month";

export interface QuotaWindowState {
  window: QuotaWindow;
  /** 已用标准 token（按模型单价归一） */
  used: number;
  /** 预算标准 token；-1 = 不限 */
  limit: number;
  /** 窗口完全重置时间（epoch ms） */
  resetAt: number;
  /** 已用百分比 0-100；limit<=0 时为 null */
  usedPercent: number | null;
  /** 剩余百分比 0-100；limit<=0 时为 null */
  remainingPercent: number | null;
}

export interface QuotaKindSummary {
  /** 配额种类：chat / chat_anon / chat_images / generate / grade / kg_build / vectorize / ocr / board */
  kind: string;
  /** 今日已用标准 token */
  used: number;
  /** 共享池无单项上限 → -1 */
  limit: number;
  /** 重置时间（epoch ms，上海自然日 0 点） */
  resetAt: number;
  /** 占当日预算百分比 0-100 */
  usedPercent: number | null;
  remainingPercent: number | null;
}

export interface QuotaPlanSummary {
  priceYuan: number;
  monthlyTokens: number;
  /** 包含的等值人民币（按参考价折算） */
  valueYuan: number;
  /** valueYuan / priceYuan；免费档为 0 */
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
  /** 每个真实 input token 扣多少标准 token */
  inputWeight: number;
  /** 每个真实 output token 扣多少标准 token */
  outputWeight: number;
  price?: { input: number; output: number };
}

export interface QuotaCostSummary {
  /** 当日累计成本（微元 1e-6 元） */
  microYuan: number;
  softMicroYuan: number;
  guardMicroYuan: number;
  guardEnabled: boolean;
  /** 降级阶梯级别：L0 全量 / L1 省流 */
  level: "L0" | "L1";
  resetAt: number;
}

export interface QuotaSummary {
  enabled: boolean;
  tier: QuotaTier;
  /** "app-pay" = 档位权威应答；"fallback" = 会员查询失败 → 按免费档展示 */
  tierSource: "app-pay" | "fallback";
  /** 统一计量单位 */
  unit: "credit";
  /** 5 小时 / 今日 / 本月 */
  windows: QuotaWindowState[];
  plan: QuotaPlanSummary;
  kinds: QuotaKindSummary[];
  /** 模型抵扣倍率（贵模型扣得更快） */
  models: QuotaModelRate[];
  /** 各档位套餐额度（升级对比用） */
  planCatalog: QuotaPlanOption[];
  cost: QuotaCostSummary;
  /** 计数存储不可用 → 本次按 fail-open 展示 */
  storeUnavailable: boolean;
}

export const quotaApi = {
  getSummary: () => request<QuotaSummary>("/quota/summary"),
};
