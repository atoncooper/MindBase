"use client";

/**
 * 个人中心「概览」仪表盘（Google Account 风格）。
 *
 * 结构：账户元信息内联在页面头部（UID / 注册时间 / 地区 / 语言 / 状态），
 * 正文为登录与安全清单 + 会员/用量双卡 → 快捷操作。不重复展示头像与昵称。
 */
import { useState } from "react";
import {
    AlertCircle,
    CalendarDays,
    Check,
    ChevronRight,
    Copy,
    Crown,
    Gauge,
    KeyRound,
    Languages,
    Mail,
    MapPin,
    ShieldCheck,
    Smartphone,
    Terminal,
    Tv,
    UserRound,
    Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type {
    PayMembership,
    PayTierInfo,
    ProfileData,
    QuotaSummary,
    SecurityOverview,
} from "@/lib/api";
import type { SectionKey } from "./account-config";
import {
    AccountCard,
    CardHeader,
    GoogleButton,
    ProgressBar,
    StatusChip,
} from "./account-ui";
import {
    formatCountdown,
    formatDate,
    formatTokens,
    formatYuanMicro,
    membershipTier,
    quotaPercent,
    tierDisplayName,
} from "./account-utils";

const LANG_LABELS: Record<string, string> = {
    zh: "中文",
    en: "English",
};

interface AccountOverviewProps {
    profile: ProfileData;
    security: SecurityOverview | null;
    securityError: string | null;
    membership: PayMembership | null;
    tiers: PayTierInfo[];
    quota: QuotaSummary | null;
    onNavigate: (key: SectionKey) => void;
    onRetrySecurity: () => void;
}

export function AccountOverview({
    profile,
    security,
    securityError,
    membership,
    tiers,
    quota,
    onNavigate,
    onRetrySecurity,
}: AccountOverviewProps) {
    return (
        <div className="space-y-4">
            <div className="grid gap-4 xl:grid-cols-2">
                <SecurityCard
                    profile={profile}
                    security={security}
                    securityError={securityError}
                    onNavigate={onNavigate}
                    onRetry={onRetrySecurity}
                />
                <div className="flex flex-col gap-4">
                    <MembershipCard
                        membership={membership}
                        tiers={tiers}
                        onNavigate={onNavigate}
                    />
                    <QuotaCard quota={quota} onNavigate={onNavigate} />
                </div>
            </div>

            <QuickActions onNavigate={onNavigate} />
        </div>
    );
}

/* ── 账户元信息（页面头部内联，不展示头像） ─────────────────────── */

export function OverviewMeta({
    profile,
    onToast,
}: {
    profile: ProfileData;
    onToast: (message: string, type: "success" | "error") => void;
}) {
    const [copied, setCopied] = useState(false);
    const language = LANG_LABELS[profile.language ?? ""] ?? profile.language ?? "语言未设置";
    const isActive = !profile.status || profile.status === "active";
    const statusLabel = isActive
        ? "正常"
        : profile.status === "disabled"
          ? "已禁用"
          : profile.status;

    async function copyUid() {
        try {
            await navigator.clipboard.writeText(String(profile.uid));
            setCopied(true);
            onToast("UID 已复制", "success");
            window.setTimeout(() => setCopied(false), 2000);
        } catch {
            onToast("复制失败", "error");
        }
    }

    return (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[12px] text-secondary">
            <button
                type="button"
                onClick={copyUid}
                className="inline-flex h-6 items-center gap-1 rounded-full border border-border bg-surface px-2.5 text-[11px] font-medium text-secondary transition-colors hover:bg-[#f8f9fa] hover:text-foreground"
            >
                UID {profile.uid}
                {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
            </button>
            <span className="inline-flex items-center gap-1.5">
                <CalendarDays className="h-3.5 w-3.5 text-tertiary" />
                {profile.created_at ? `注册于 ${formatDate(profile.created_at)}` : "注册时间未知"}
            </span>
            <span className="inline-flex items-center gap-1.5">
                <MapPin className="h-3.5 w-3.5 text-tertiary" />
                {profile.location || "地区未设置"}
            </span>
            <span className="inline-flex items-center gap-1.5">
                <Languages className="h-3.5 w-3.5 text-tertiary" />
                {language}
            </span>
            <StatusChip tone={isActive ? "success" : "warning"}>{statusLabel}</StatusChip>
        </div>
    );
}

/* ── 登录与安全 ──────────────────────────────────────────────────── */

function SecurityCard({
    profile,
    security,
    securityError,
    onNavigate,
    onRetry,
}: {
    profile: ProfileData;
    security: SecurityOverview | null;
    securityError: string | null;
    onNavigate: (key: SectionKey) => void;
    onRetry: () => void;
}) {
    const emailOk = Boolean(profile.email && profile.email_verified);
    const phoneOk = Boolean(profile.phone && profile.phone_verified);
    const passwordOk = Boolean(security?.has_password);
    const bilibiliOk = Boolean(security?.bilibili.valid);
    const done = [emailOk, phoneOk, passwordOk, bilibiliOk].filter(Boolean).length;
    const percent = (done / 4) * 100;
    const tone = percent >= 100 ? "success" : percent >= 50 ? "info" : "warning";

    return (
        <AccountCard className="flex h-full flex-col">
            <CardHeader
                icon={<ShieldCheck className="h-5 w-5" />}
                title="登录与安全"
                description="完善登录方式，降低账号被盗风险。"
                action={
                    <GoogleButton
                        variant="text"
                        onClick={() => onNavigate("password")}
                        className="h-8 px-2.5 text-[12px]"
                    >
                        管理
                    </GoogleButton>
                }
            />

            <div className="px-5 pb-2">
                <div className="flex items-center justify-between text-[12px]">
                    <span className="text-secondary">安全设置完成度</span>
                    <span className="font-medium text-foreground">
                        {done}/4
                    </span>
                </div>
                <ProgressBar value={percent} tone={tone} className="mt-2" />
            </div>

            {securityError && (
                <div className="mx-4 mb-2 flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-[11px] leading-relaxed text-warning">
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0 flex-1">安全信息加载失败：{securityError}</span>
                    <button
                        type="button"
                        onClick={onRetry}
                        className="shrink-0 font-medium underline underline-offset-2"
                    >
                        重试
                    </button>
                </div>
            )}

            <div className="px-2 pb-2">
                <SecurityRow
                    icon={<Mail className="h-4 w-4" />}
                    tint="bg-accent-soft text-accent"
                    label="邮箱"
                    value={profile.email || "未绑定"}
                    chip={
                        <StatusChip
                            tone={
                                profile.email_verified
                                    ? "success"
                                    : profile.email
                                      ? "warning"
                                      : "neutral"
                            }
                        >
                            {profile.email
                                ? profile.email_verified
                                    ? "已验证"
                                    : "未验证"
                                : "未绑定"}
                        </StatusChip>
                    }
                    onClick={() => onNavigate("email")}
                />
                <SecurityRow
                    icon={<Smartphone className="h-4 w-4" />}
                    tint="bg-success/10 text-success"
                    label="手机号"
                    value={profile.phone || "未绑定"}
                    chip={
                        <StatusChip
                            tone={
                                profile.phone_verified
                                    ? "success"
                                    : profile.phone
                                      ? "warning"
                                      : "neutral"
                            }
                        >
                            {profile.phone
                                ? profile.phone_verified
                                    ? "已验证"
                                    : "未验证"
                                : "未绑定"}
                        </StatusChip>
                    }
                    onClick={() => onNavigate("phone")}
                />
                <SecurityRow
                    icon={<KeyRound className="h-4 w-4" />}
                    tint="bg-warning/10 text-warning"
                    label="密码"
                    value="用于账号登录与二次验证"
                    chip={
                        <StatusChip tone={security?.has_password ? "success" : "neutral"}>
                            {security ? (security.has_password ? "已设置" : "未设置") : "同步中"}
                        </StatusChip>
                    }
                    onClick={() => onNavigate("password")}
                />
                <SecurityRow
                    icon={<Tv className="h-4 w-4" />}
                    tint="bg-[#fce8e6] text-[#d93025]"
                    label="B 站账号"
                    value={security?.bilibili.nickname || "未绑定"}
                    chip={
                        <StatusChip
                            tone={
                                security?.bilibili.valid
                                    ? "success"
                                    : security?.bilibili.bound
                                      ? "warning"
                                      : "neutral"
                            }
                        >
                            {security
                                ? security.bilibili.valid
                                    ? "可用"
                                    : security.bilibili.bound
                                      ? "已失效"
                                      : "未绑定"
                                : "同步中"}
                        </StatusChip>
                    }
                    onClick={() => onNavigate("bilibili")}
                />
            </div>

            <div className="mt-auto px-4 pb-4 pt-4">
                <div className="rounded-lg bg-[#f8f9fa] px-3 py-2.5 text-[11px] leading-relaxed text-secondary">
                    提示：绑定并验证邮箱或手机号后，修改密码会触发二次验证；B
                    站授权失效时收藏夹同步会暂停。
                </div>
            </div>
        </AccountCard>
    );
}

function SecurityRow({
    icon,
    tint,
    label,
    value,
    chip,
    onClick,
}: {
    icon: React.ReactNode;
    tint: string;
    label: string;
    value: string;
    chip: React.ReactNode;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className="group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-[#f8f9fa]"
        >
            <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-full", tint)}>
                {icon}
            </span>
            <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium text-foreground">{label}</span>
                <span className="block truncate text-[12px] text-secondary">{value}</span>
            </span>
            {chip}
            <ChevronRight className="h-4 w-4 shrink-0 text-tertiary transition-transform group-hover:translate-x-0.5" />
        </button>
    );
}

/* ── 会员 ────────────────────────────────────────────────────────── */

function MembershipCard({
    membership,
    tiers,
    onNavigate,
}: {
    membership: PayMembership | null;
    tiers: PayTierInfo[];
    onNavigate: (key: SectionKey) => void;
}) {
    const tier = membershipTier(membership);
    const paid = tier === "VIP" || tier === "SVIP" || tier === "PROMAX";
    const info = tiers.find((t) => t.tier.toUpperCase() === tier);
    const expire =
        membership?.active && membership.expireAt
            ? formatDate(membership.expireAt, true)
            : null;
    const benefits = info?.benefits?.length
        ? info.benefits.slice(0, 3)
        : !paid
          ? ["更高每日 AI 额度", "会员优先调度", "更大云盘空间"]
          : [];

    return (
        <AccountCard>
            <CardHeader
                icon={<Crown className="h-5 w-5" />}
                title="会员与订阅"
                action={
                    <StatusChip tone={paid ? "success" : "neutral"}>
                        {paid ? "生效中" : "未开通"}
                    </StatusChip>
                }
            />
            <div className="px-5 pb-5">
                <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                        <p className="text-[20px] font-medium leading-7 text-foreground">
                            {tierDisplayName(tier)}
                        </p>
                        <p className="mt-0.5 truncate text-[12px] text-secondary">
                            {paid && expire
                                ? `${expire} 到期${membership?.autoRenew ? " · 自动续费中" : ""}`
                                : info?.tagline || "升级会员解锁更高配额与优先调度"}
                        </p>
                    </div>
                    <span
                        className={cn(
                            "grid h-11 w-11 shrink-0 place-items-center rounded-full",
                            paid ? "bg-warning/10 text-warning" : "bg-[#f1f3f4] text-secondary",
                        )}
                    >
                        <Crown className="h-5 w-5" />
                    </span>
                </div>

                {benefits.length > 0 && (
                    <ul className="mt-4 space-y-1.5">
                        {benefits.map((benefit) => (
                            <li key={benefit} className="flex items-start gap-2 text-[12px] text-secondary">
                                <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
                                <span className="min-w-0">{benefit}</span>
                            </li>
                        ))}
                    </ul>
                )}

                <GoogleButton
                    variant={paid ? "outlined" : "filled"}
                    onClick={() => onNavigate("membership")}
                    className="mt-4 h-8 px-3.5 text-[12px]"
                >
                    {paid ? "管理订阅" : "查看会员权益"}
                </GoogleButton>
            </div>
        </AccountCard>
    );
}

/* ── 今日用量 ────────────────────────────────────────────────────── */

function QuotaCard({
    quota,
    onNavigate,
}: {
    quota: QuotaSummary | null;
    onNavigate: (key: SectionKey) => void;
}) {
    const day = quota?.windows?.find((w) => w.window === "day");
    const percent = day?.usedPercent ?? 0;
    const unlimited = day ? day.limit < 0 : false;
    const remaining = day?.remainingPercent ?? Math.max(0, 100 - percent);
    const tone = percent >= 100 ? "danger" : percent >= 80 ? "warning" : "info";

    return (
        <AccountCard>
            <CardHeader
                icon={<Gauge className="h-5 w-5" />}
                title="今日用量"
                action={
                    <GoogleButton
                        variant="text"
                        onClick={() => onNavigate("quota")}
                        className="h-8 px-2.5 text-[12px]"
                    >
                        详情
                    </GoogleButton>
                }
            />
            <div className="px-5 pb-5">
                {!quota ? (
                    <div className="rounded-lg bg-[#f8f9fa] px-3 py-3 text-[12px] leading-relaxed text-secondary">
                        用量数据暂时不可用，稍后可在「用量与额度」中重试。
                    </div>
                ) : !quota.enabled ? (
                    <div className="rounded-lg bg-[#f8f9fa] px-3 py-3 text-[12px] leading-relaxed text-secondary">
                        用量统计未启用，当前不限量。
                    </div>
                ) : (
                    <>
                        <div className="flex items-end justify-between gap-3">
                            <div className="flex items-baseline gap-2">
                                <span
                                    className={cn(
                                        "text-[30px] font-normal leading-none tabular-nums",
                                        percent >= 100
                                            ? "text-danger"
                                            : percent >= 80
                                              ? "text-warning"
                                              : "text-foreground",
                                    )}
                                >
                                    {percent}%
                                </span>
                                <span className="text-[12px] text-secondary">AI token</span>
                            </div>
                            <span className="pb-0.5 text-[11px] tabular-nums text-tertiary">
                                {day
                                    ? unlimited
                                        ? "不限量"
                                        : formatTokens(day.used) + "/" + formatTokens(day.limit)
                                    : "—"}
                            </span>
                        </div>
                        <ProgressBar value={percent} tone={tone} className="mt-2.5" />
                        <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-secondary">
                            <span>{unlimited ? "不限量" : `剩余 ${remaining}%`}</span>
                            <span>{formatCountdown(day?.resetAt ?? quota.cost.resetAt)}</span>
                        </div>
                        <div className="mt-4 flex items-center justify-between border-t border-border-subtle pt-3">
                            <span className="text-[12px] text-secondary">今日成本</span>
                            <span className="text-[13px] font-medium tabular-nums text-foreground">
                                {formatYuanMicro(quota.cost.microYuan)}
                            </span>
                        </div>
                    </>
                )}
            </div>
        </AccountCard>
    );
}

/* ── 快捷操作 ────────────────────────────────────────────────────── */

function QuickActions({ onNavigate }: { onNavigate: (key: SectionKey) => void }) {
    return (
        <AccountCard>
            <CardHeader
                icon={<Zap className="h-5 w-5" />}
                title="快捷操作"
                description="常做的账户操作，一步直达。"
            />
            <div className="grid gap-1 px-3 pb-3 sm:grid-cols-2 xl:grid-cols-4">
                <QuickAction
                    icon={<UserRound className="h-4 w-4" />}
                    title="编辑资料"
                    description="昵称、头像与简介"
                    onClick={() => onNavigate("profile")}
                />
                <QuickAction
                    icon={<KeyRound className="h-4 w-4" />}
                    title="修改密码"
                    description="账号登录与安全"
                    onClick={() => onNavigate("password")}
                />
                <QuickAction
                    icon={<Tv className="h-4 w-4" />}
                    title="B 站授权"
                    description="同步收藏夹内容"
                    onClick={() => onNavigate("bilibili")}
                />
                <QuickAction
                    icon={<Terminal className="h-4 w-4" />}
                    title="Coding Plan"
                    description="第三方编程套餐"
                    onClick={() => onNavigate("coding-plan")}
                />
            </div>
        </AccountCard>
    );
}

function QuickAction({
    icon,
    title,
    description,
    onClick,
}: {
    icon: React.ReactNode;
    title: string;
    description: string;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className="group flex items-center gap-3 rounded-lg px-3 py-3 text-left transition-colors hover:bg-[#f8f9fa]"
        >
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
                {icon}
            </span>
            <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-foreground">
                    {title}
                </span>
                <span className="block truncate text-[11px] text-secondary">{description}</span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-tertiary opacity-0 transition-opacity group-hover:opacity-100" />
        </button>
    );
}
