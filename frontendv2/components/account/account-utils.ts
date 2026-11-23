import type { PayMembership, QuotaKindSummary } from "@/lib/api";

/** 账户域各能力的展示名（与 /quota/summary 的 kind 对齐）。 */
export const QUOTA_KIND_LABELS: Record<string, string> = {
    chat: "AI 问答",
    chat_anon: "AI 问答（未登录）",
    chat_images: "聊天图片附件",
    generate: "出题（批）",
    grade: "批改",
    kg_build: "知识图谱构建",
    vectorize: "视频向量化（分P）",
    ocr: "OCR 识别",
    board: "AI 补全",
    task_quiz_active: "定时出题任务",
};

/**
 * 日期展示：默认只到月份（账户页信息密度低，避免过长）；
 * withDay=true 用于会员到期等需要精确到日的场景。
 */
export function formatDate(iso: string | null | undefined, withDay = false): string {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString(
        "zh-CN",
        withDay
            ? { year: "numeric", month: "long", day: "numeric" }
            : { year: "numeric", month: "long" },
    );
}

/** 标准 token → 紧凑展示（1.2 万 / 3.4 亿）。 */
export function formatTokens(tokens: number): string {
    if (tokens < 0) return "不限";
    if (!Number.isFinite(tokens)) return "0";
    if (tokens >= 100_000_000) return (tokens / 100_000_000).toFixed(2) + " 亿";
    if (tokens >= 10_000) {
        const wan = tokens / 10_000;
        return (wan >= 1_000 ? Math.round(wan) : Math.round(wan * 10) / 10) + " 万";
    }
    return Math.max(0, Math.round(tokens)).toLocaleString("zh-CN");
}

/** 微元（1e-6 元）→ 展示金额；小额保留 4 位，避免显示成 ¥0.00。 */
export function formatYuanMicro(microYuan: number): string {
    const yuan = microYuan / 1e6;
    if (!Number.isFinite(yuan)) return "¥0.00";
    if (yuan > 0 && yuan < 0.01) return `¥${yuan.toFixed(4)}`;
    return `¥${yuan.toFixed(2)}`;
}

/** 每日额度重置倒计时（上海自然日 0 点由后端给出 resetAt）。 */
export function formatCountdown(resetAt: number): string {
    const remaining = Math.max(0, resetAt - Date.now());
    const h = Math.floor(remaining / 3_600_000);
    const m = Math.floor((remaining % 3_600_000) / 60_000);
    if (h <= 0 && m <= 0) return "即将重置";
    return h > 0 ? `${h} 小时 ${m} 分后重置` : `${m} 分钟后重置`;
}

/** 会员档位归一化：无行 / 已过期一律回落到 FREE。 */
export function membershipTier(m: PayMembership | null): string {
    if (!m?.active) return "FREE";
    return (m.tier ?? "").toUpperCase() || "FREE";
}

/** 档位中文名（Google Account 式完整称谓）。 */
export function tierDisplayName(tier: string): string {
    switch (tier.toUpperCase()) {
        case "VIP":
            return "VIP 会员";
        case "SVIP":
            return "SVIP 会员";
        case "PROMAX":
            return "ProMax 会员";
        case "FREE":
            return "免费版";
        default:
            return tier || "免费版";
    }
}

/** 已用百分比：后端已算则直接用，否则按 used/limit 兜底。 */
export function quotaPercent(kind: QuotaKindSummary): number {
    if (kind.usedPercent !== null && Number.isFinite(kind.usedPercent)) {
        return Math.max(0, Math.min(100, Math.round(kind.usedPercent)));
    }
    if (kind.limit > 0) {
        return Math.max(0, Math.min(100, Math.round((kind.used / kind.limit) * 100)));
    }
    return 0;
}
