/**
 * Quota API - 会员用量限制：每日各能力用量 + 当日成本状态.
 *
 * Backend contract: app-ts GET /quota/summary（X-Uid 由网关注入；匿名按 IP 桶）.
 * 消费方：聊天页升级引导横幅、会员中心用量区块、（M3）聊天页剩余角标.
 */
import { request } from "./client";

export type QuotaTier = "free" | "vip" | "svip";

export interface QuotaKindSummary {
  /** 配额种类：chat / chat_anon / chat_images / generate / grade / kg_build / vectorize / ocr / board */
  kind: string;
  /** 已用次数 */
  used: number;
  /** 每日上限；-1 = 不限 */
  limit: number;
  /** 重置时间（epoch ms，上海自然日 0 点） */
  resetAt: number;
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
  kinds: QuotaKindSummary[];
  cost: QuotaCostSummary;
}

export const quotaApi = {
  getSummary: () => request<QuotaSummary>("/quota/summary"),
};
