"use client";

/**
 * 个人中心右侧的分区内容：B 站授权 / 会员订阅 / 用量额度 / 安全加载态。
 *
 * 全部使用 Google Account 风格的白色描边卡片；数据只来自 account-view
 * 已经拉取的 profile/security/membership/quota，不在这里发请求。
 */
import {
    AlertCircle,
    BarChart3,
    Check,
    Coins,
    Crown,
    Gauge,
    Loader2,
    ShieldCheck,
    Sparkles,
    Tv,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type {
    PayMembership,
    PayTierInfo,
    QuotaKindSummary,
    QuotaSummary,
    SecurityOverview,
} from "@/lib/api";
import {
    AccountCard,
    CardHeader,
    GoogleButton,
    GoogleLinkButton,
    MetaItem,
    ProgressBar,
    StatusChip,
} from "./account-ui";
import {
    formatCountdown,
    formatDate,
    formatYuanMicro,
    membershipTier,
    quotaPercent,
    QUOTA_KIND_LABELS,
    tierDisplayName,
} from "./account-utils";

/* ── B 站授权 ────────────────────────────────────────────────────── */

const BILIBILI_SCOPES = [
    { title: "收藏夹与视频列表", description: "用于选择要构建知识库的内容。" },
    { title: "视频标题、简介与封面", description: "用于生成可检索的知识条目。" },
    { title: "登录态与同步状态", description: "仅用于维持收藏夹同步，不修改 B 站数据。" },
];

export function BilibiliSection({
    security,
    onBind,
}: {
    security: SecurityOverview;
    onBind: () => void;
}) {
    const b = security.bilibili;
    const tone = b.valid ? "success" : b.bound ? "warning" : "neutral";
    const status = b.valid ? "可用" : b.bound ? "已失效" : "未绑定";
    const description =
        b.message ||
        (b.valid
            ? "授权正常，收藏夹同步可用。"
            : b.bound
              ? "当前授权已失效，重新绑定后即可继续同步。"
              : "尚未绑定 B 站账号，绑定后即可同步收藏夹。");

    return (
        <div className="w-full space-y-4">
            <AccountCard>
                <CardHeader
                    icon={<Tv className="h-5 w-5" />}
                    title="B 站账号"
                    description="用于同步收藏夹与视频列表。"
                    action={<StatusChip tone={tone}>{status}</StatusChip>}
                />
                <div className="px-5 pb-5">
                    <div className="flex items-center gap-3 rounded-lg bg-[#f8f9fa] p-3.5">
                        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[#fce8e6] text-[#d93025]">
                            <Tv className="h-5 w-5" />
                        </span>
                        <div className="min-w-0 flex-1">
                            <p className="truncate text-[13px] font-medium text-foreground">
                                {b.nickname || "未绑定 B 站账号"}
                            </p>
                            <p className="truncate text-[11px] text-secondary">
                                {b.mid ? `MID ${b.mid}` : "扫码后自动关联当前账户"}
                            </p>
                        </div>
                    </div>

                    <p className="mt-4 text-[12px] leading-relaxed text-secondary">{description}</p>

                    <div className="mt-4 flex flex-wrap items-center gap-2">
                        <GoogleButton
                            variant={b.valid ? "outlined" : "filled"}
                            onClick={onBind}
                        >
                            {b.valid ? "重新授权" : b.bound ? "重新绑定" : "扫码绑定"}
                        </GoogleButton>
                        {b.valid && (
                            <span className="text-[11px] text-tertiary">
                                授权有效，可随时重新扫码刷新
                            </span>
                        )}
                    </div>
                </div>
            </AccountCard>

            <AccountCard>
                <CardHeader
                    icon={<ShieldCheck className="h-5 w-5" />}
                    title="授权范围"
                    description="MindBase 只读取以下信息，不会修改你的 B 站数据。"
                />
                <ul className="space-y-3 px-5 pb-5 pt-1">
                    {BILIBILI_SCOPES.map((scope) => (
                        <li key={scope.title} className="flex items-start gap-3">
                            <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-success/10 text-success">
                                <Check className="h-3.5 w-3.5" />
                            </span>
                            <span className="min-w-0">
                                <span className="block text-[13px] font-medium text-foreground">
                                    {scope.title}
                                </span>
                                <span className="block text-[12px] leading-relaxed text-secondary">
                                    {scope.description}
                                </span>
                            </span>
                        </li>
                    ))}
                </ul>
            </AccountCard>
        </div>
    );
}

/* ── 会员与订阅 ──────────────────────────────────────────────────── */

const DEFAULT_UPGRADE_BENEFITS = [
    "更高的每日 AI 调用额度",
    "会员优先调度队列",
    "更大的云盘空间",
    "Coding Plan 第三方编程套餐",
];

export function MembershipSection({
    membership,
    tiers,
}: {
    membership: PayMembership | null;
    tiers: PayTierInfo[];
}) {
    const tier = membershipTier(membership);
    const paid = tier === "VIP" || tier === "SVIP";
    const info = tiers.find((t) => t.tier.toUpperCase() === tier);
    const expire =
        membership?.active && membership.expireAt
            ? formatDate(membership.expireAt, true)
            : "—";
    const benefits = info?.benefits?.length ? info.benefits : DEFAULT_UPGRADE_BENEFITS;

    return (
        <div className="space-y-4">
            <AccountCard>
                <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex items-start gap-4">
                        <span
                            className={cn(
                                "grid h-12 w-12 shrink-0 place-items-center rounded-full",
                                paid ? "bg-warning/10 text-warning" : "bg-accent-soft text-accent",
                            )}
                        >
                            <Crown className="h-6 w-6" />
                        </span>
                        <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                                <h2 className="text-[20px] font-medium leading-7 text-foreground">
                                    {tierDisplayName(tier)}
                                </h2>
                                <StatusChip tone={paid ? "success" : "neutral"}>
                                    {paid ? "生效中" : "未开通"}
                                </StatusChip>
                            </div>
                            <p className="mt-1 text-[12px] leading-relaxed text-secondary">
                                {paid
                                    ? `${expire} 到期${membership?.autoRenew ? " · 自动续费中" : ""}`
                                    : info?.tagline || "升级会员解锁更高额度、优先调度与更多权益。"}
                            </p>
                        </div>
                    </div>
                    <GoogleLinkButton
                        href="/membership"
                        variant={paid ? "outlined" : "filled"}
                        className="self-start"
                    >
                        {paid ? "管理订阅" : "升级会员"}
                    </GoogleLinkButton>
                </div>

                <dl className="grid grid-cols-2 gap-4 border-t border-border-subtle px-5 py-4 sm:grid-cols-4">
                    <MetaItem label="当前档位" value={tier} />
                    <MetaItem label="到期时间" value={paid ? expire : "—"} />
                    <MetaItem label="自动续费" value={membership?.autoRenew ? "已开启" : "未开启"} />
                    <MetaItem label="权益项" value={`${benefits.length} 项`} />
                </dl>
            </AccountCard>

            <AccountCard>
                <CardHeader
                    icon={<Sparkles className="h-5 w-5" />}
                    title="专属权益"
                    description={paid ? "当前档位包含的权益。" : "升级后即可解锁以下权益。"}
                />
                <ul className="grid gap-2 px-5 pb-5 pt-1 sm:grid-cols-2">
                    {benefits.map((benefit) => (
                        <li key={benefit} className="flex items-start gap-2.5">
                            <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-success/10 text-success">
                                <Check className="h-3 w-3" />
                            </span>
                            <span className="text-[13px] leading-relaxed text-foreground">
                                {benefit}
                            </span>
                        </li>
                    ))}
                </ul>
            </AccountCard>

            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-accent-soft px-4 py-3">
                <p className="text-[12px] leading-relaxed text-[#041e49]">
                    会员开通、续费与订单记录统一在会员中心管理。
                </p>
                <GoogleLinkButton href="/membership" variant="text">
                    前往会员中心
                </GoogleLinkButton>
            </div>
        </div>
    );
}

/* ── 用量与额度 ──────────────────────────────────────────────────── */

export function QuotaSection({ quota }: { quota: QuotaSummary | null }) {
    if (!quota) {
        return (
            <AccountCard>
                <CardHeader
                    icon={<Gauge className="h-5 w-5" />}
                    title="用量与额度"
                    description="每日 0 点（Asia/Shanghai）重置。"
                />
                <div className="px-5 pb-5">
                    <div className="rounded-lg bg-[#f8f9fa] px-4 py-4 text-[12px] leading-relaxed text-secondary">
                        用量数据暂时不可用（/quota/summary 未返回）。可能是会员服务或统计服务短暂不可达。
                    </div>
                    <GoogleLinkButton href="/quota" variant="outlined" className="mt-3">
                        打开用量页重试
                    </GoogleLinkButton>
                </div>
            </AccountCard>
        );
    }

    if (!quota.enabled) {
        return (
            <AccountCard>
                <CardHeader
                    icon={<Gauge className="h-5 w-5" />}
                    title="用量与额度"
                    description="每日 0 点（Asia/Shanghai）重置。"
                />
                <div className="px-5 pb-5">
                    <div className="rounded-lg bg-[#f8f9fa] px-4 py-4 text-[12px] leading-relaxed text-secondary">
                        用量统计未启用（quota.enabled=false），当前不限量。
                    </div>
                </div>
            </AccountCard>
        );
    }

    const chat =
        quota.kinds.find((k) => k.kind === "chat") ??
        quota.kinds.find((k) => k.kind === "chat_anon");
    const percent = chat ? quotaPercent(chat) : 0;
    const unlimited = chat ? chat.limit < 0 : false;
    const remaining = chat?.remainingPercent ?? Math.max(0, 100 - percent);
    const tone = percent >= 100 ? "danger" : percent >= 80 ? "warning" : "info";
    const cost = quota.cost;

    return (
        <div className="space-y-4">
            {quota.tierSource === "fallback" && (
                <div className="flex items-start gap-2.5 rounded-lg bg-warning/10 px-4 py-3 text-[12px] leading-relaxed text-warning">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                        会员权益同步失败，当前按免费档展示额度。恢复后会自动按实际档位生效。
                    </span>
                </div>
            )}

            <div className="grid gap-4 md:grid-cols-2">
                <AccountCard>
                    <CardHeader
                        icon={<Gauge className="h-5 w-5" />}
                        title="今日概览"
                        description={`${formatCountdown(cost.resetAt)} · 每日 0 点重置`}
                    />
                    <div className="px-5 pb-5">
                        <div className="flex items-end justify-between gap-3">
                            <div className="flex items-baseline gap-2">
                                <span
                                    className={cn(
                                        "text-[38px] font-normal leading-none tabular-nums",
                                        percent >= 100
                                            ? "text-danger"
                                            : percent >= 80
                                              ? "text-warning"
                                              : "text-foreground",
                                    )}
                                >
                                    {percent}%
                                </span>
                                <span className="text-[12px] text-secondary">AI 问答已用</span>
                            </div>
                            <span className="pb-1 text-[11px] tabular-nums text-tertiary">
                                {chat
                                    ? unlimited
                                        ? "不限量"
                                        : `${chat.used}/${chat.limit}`
                                    : "—"}
                            </span>
                        </div>
                        <ProgressBar value={percent} tone={tone} className="mt-3" />
                        <p className="mt-3 text-[11px] text-secondary">
                            {unlimited ? "当前档位不限量" : `剩余 ${remaining}%`}
                        </p>
                        <dl className="mt-4 grid grid-cols-2 gap-4 border-t border-border-subtle pt-3">
                            <MetaItem label="已用次数" value={chat ? String(chat.used) : "—"} />
                            <MetaItem
                                label="剩余额度"
                                value={
                                    chat
                                        ? unlimited
                                            ? "不限量"
                                            : String(Math.max(0, chat.limit - chat.used))
                                        : "—"
                                }
                            />
                        </dl>
                    </div>
                </AccountCard>

                <AccountCard>
                    <CardHeader
                        icon={<Coins className="h-5 w-5" />}
                        title="今日成本"
                        action={
                            cost.level === "L1" ? (
                                <StatusChip tone="warning">省流模式</StatusChip>
                            ) : undefined
                        }
                    />
                    <div className="space-y-3 px-5 pb-5">
                        {[
                            {
                                label: "已产生",
                                value: formatYuanMicro(cost.microYuan),
                                hint: "全能力合计",
                            },
                            {
                                label: "省流阈值",
                                value:
                                    cost.softMicroYuan > 0
                                        ? formatYuanMicro(cost.softMicroYuan)
                                        : "—",
                                hint: "超过后进入 L1",
                            },
                            {
                                label: "熔断阈值",
                                value: formatYuanMicro(cost.guardMicroYuan),
                                hint: cost.guardEnabled ? "超过当日冻结" : "未启用",
                            },
                        ].map((row) => (
                            <div
                                key={row.label}
                                className="flex items-center justify-between gap-3 border-b border-border-subtle pb-2.5 last:border-0 last:pb-0"
                            >
                                <div className="min-w-0">
                                    <p className="text-[13px] text-foreground">{row.label}</p>
                                    <p className="text-[11px] text-secondary">{row.hint}</p>
                                </div>
                                <p className="shrink-0 text-[16px] tabular-nums text-foreground">
                                    {row.value}
                                </p>
                            </div>
                        ))}
                    </div>
                </AccountCard>
            </div>

            <AccountCard>
                <CardHeader
                    icon={<BarChart3 className="h-5 w-5" />}
                    title="各能力用量"
                    description="仅统计成功的调用，失败与重试不消耗额度。"
                />
                <div className="px-5 pb-3">
                    {quota.kinds.length === 0 ? (
                        <p className="py-4 text-[12px] text-secondary">暂无可统计的额度项。</p>
                    ) : (
                        quota.kinds.map((kind, index) => (
                            <QuotaKindRow
                                key={kind.kind}
                                kind={kind}
                                last={index === quota.kinds.length - 1}
                            />
                        ))
                    )}
                </div>
            </AccountCard>

            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-[#f8f9fa] px-4 py-3">
                <p className="text-[12px] leading-relaxed text-secondary">
                    配额按自然日 0 点重置，展示已用百分比；成本按价格快照折算，仅供参考。
                </p>
                <GoogleLinkButton href="/quota" variant="text">
                    打开完整用量页
                </GoogleLinkButton>
            </div>
        </div>
    );
}

function QuotaKindRow({ kind, last }: { kind: QuotaKindSummary; last: boolean }) {
    const label = QUOTA_KIND_LABELS[kind.kind] ?? kind.kind;
    const unlimited = kind.limit < 0;
    const percent = quotaPercent(kind);
    const tone = percent >= 100 ? "danger" : percent >= 80 ? "warning" : "info";

    return (
        <div className={cn("py-3", !last && "border-b border-border-subtle")}>
            <div className="flex items-baseline justify-between gap-3">
                <span className="text-[13px] font-medium text-foreground">{label}</span>
                <span
                    className={cn(
                        "text-[11px] tabular-nums",
                        percent >= 100 ? "text-danger" : "text-secondary",
                    )}
                >
                    {unlimited ? "不限量" : `${percent}% · ${kind.used}/${kind.limit}`}
                </span>
            </div>
            {!unlimited && <ProgressBar value={percent} tone={tone} className="mt-2" />}
        </div>
    );
}

/* ── 安全信息加载态 ──────────────────────────────────────────────── */

export function SecurityPending() {
    return (
        <AccountCard>
            <div className="flex items-start gap-3 p-5">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
                    <Loader2 className="h-5 w-5 animate-spin" />
                </span>
                <div className="min-w-0">
                    <h2 className="text-[15px] font-medium text-foreground">
                        正在检查账户安全信息…
                    </h2>
                    <p className="mt-1 text-[12px] leading-relaxed text-secondary">
                        B 站授权状态需要实时校验，通常需要几秒钟；其他资料不受影响。
                    </p>
                </div>
            </div>
        </AccountCard>
    );
}

export function SecurityUnavailable({
    error,
    onRetry,
}: {
    error: string | null;
    onRetry: () => void;
}) {
    return (
        <AccountCard>
            <div className="flex items-start gap-3 p-5">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-danger/10 text-danger">
                    <AlertCircle className="h-5 w-5" />
                </span>
                <div className="min-w-0">
                    <h2 className="text-[15px] font-medium text-foreground">
                        安全信息暂时不可用
                    </h2>
                    <p className="mt-1 break-words text-[12px] leading-relaxed text-secondary">
                        {error || "无法获取安全信息，请稍后重试。"}
                    </p>
                    <GoogleButton variant="outlined" onClick={onRetry} className="mt-4">
                        重试
                    </GoogleButton>
                </div>
            </div>
        </AccountCard>
    );
}
