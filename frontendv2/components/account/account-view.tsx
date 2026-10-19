"use client";

/**
 * AccountView - 个人中心（Apple 账户页式主从结构）。
 *
 * 结构参考 appleid.apple.com / iOS 设置：
 *   主视图 —— 居中 Hero（大头像 / 昵称 + 会员徽章 / UID）+ 会员卡 +
 *            iOS 式分组列表（行 = 着色图标 + 标签 + 当前值 + Chevron）；
 *   详情视图 —— 点击行右侧推入：蓝色「‹ 返回」+ 大标题 + 对应设置卡。
 *
 * 编辑业务全部复用现有设置卡组件（profile / email / phone / password），
 * 本次仅重构页面结构与导航方式，卡片内部逻辑零改动。
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import {
    AlertCircle,
    ChevronLeft,
    ChevronRight,
    Copy,
    Crown,
    Gauge,
    KeyRound,
    Loader2,
    Mail,
    ShieldCheck,
    Smartphone,
    Sparkles,
    Tv,
    User,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
    userApi,
    payApi,
    quotaApi,
    type ProfileData,
    type SecurityOverview,
    type PayMembership,
    type PayTierInfo,
    type QuotaSummary,
} from "@/lib/api";
import { ProfileCard } from "./profile-card";
import { EmailCard } from "./email-card";
import { PhoneCard } from "./phone-card";
import { PasswordCard } from "./password-card";
import { BilibiliBindModal } from "./bilibili-bind-modal";
import { Tag } from "./form-card";

type Toast = { message: string; type: "success" | "error" };
/** 详情页键：profile=个人资料；email/phone/password/bilibili=登录与安全 */
type DetailKey = "profile" | "email" | "phone" | "password" | "bilibili";

const EASE: [number, number, number, number] = [0.28, 0.11, 0.32, 1];

const DETAIL_TITLES: Record<DetailKey, string> = {
    profile: "个人资料",
    email: "邮箱",
    phone: "手机号",
    password: "密码",
    bilibili: "B 站账号",
};

async function fetchAccount(): Promise<[ProfileData, SecurityOverview]> {
    return Promise.all([userApi.getProfile(), userApi.getSecurity()]);
}

export function AccountView() {
    const router = useRouter();
    const [profile, setProfile] = useState<ProfileData | null>(null);
    const [security, setSecurity] = useState<SecurityOverview | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [toast, setToast] = useState<Toast | null>(null);
    const [bindOpen, setBindOpen] = useState(false);
    const [detail, setDetail] = useState<DetailKey | null>(null);
    // 会员态（app-pay）。拉取失败静默降级为「免费用户」，不阻塞个人中心。
    const [membership, setMembership] = useState<PayMembership | null>(null);
    const [tiers, setTiers] = useState<PayTierInfo[]>([]);
    // 用量摘要（/quota/summary）：仅用于入口行的迷你展示，失败静默。
    const [quotaSummary, setQuotaSummary] = useState<QuotaSummary | null>(null);

    const loadMembership = useCallback(() => {
        payApi
            .getMembership()
            .then((m) => setMembership(m))
            .catch(() => setMembership(null));
        payApi
            .tiers()
            .then((t) => setTiers(t))
            .catch(() => setTiers([]));
        quotaApi
            .getSummary()
            .then((q) => setQuotaSummary(q))
            .catch(() => setQuotaSummary(null));
    }, []);

    const flash = useCallback((message: string, type: "success" | "error") => {
        setToast({ message, type });
        setTimeout(() => setToast(null), type === "error" ? 6000 : 3000);
    }, []);

    async function copyUid(uid: number) {
        try {
            await navigator.clipboard.writeText(String(uid));
            flash("UID 已复制", "success");
        } catch {
            flash("复制失败", "error");
        }
    }

    // Reload after an edit (no full-page spinner).
    const load = useCallback(async () => {
        loadMembership();
        try {
            const [p, s] = await fetchAccount();
            setProfile(p);
            setSecurity(s);
            setError(null);
        } catch (e) {
            setError(e instanceof Error ? e.message : "加载失败");
        }
    }, [loadMembership]);

    // Initial load.
    useEffect(() => {
        let cancelled = false;
        loadMembership();
        (async () => {
            setLoading(true);
            try {
                const [p, s] = await fetchAccount();
                if (!cancelled) {
                    setProfile(p);
                    setSecurity(s);
                    setError(null);
                }
            } catch (e) {
                if (!cancelled) setError(e instanceof Error ? e.message : "加载失败");
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [loadMembership]);

    // 详情视图：进入滚动到顶 + ESC 返回。
    useEffect(() => {
        if (detail === null) return;
        window.scrollTo({ top: 0 });
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setDetail(null);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [detail]);

    if (loading) {
        return (
            <div className="flex h-[calc(100dvh-3rem)] items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-tertiary" />
            </div>
        );
    }

    if (error) {
        return (
            <div className="px-6 py-8 sm:px-10">
                <div className="flex items-center gap-2 rounded-lg border-l-2 border-foreground bg-border-subtle px-4 py-3 text-[13px] text-foreground">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    {error}
                </div>
            </div>
        );
    }

    if (!profile || !security) return null;

    return (
        <div className="mx-auto w-full max-w-[620px] px-6 py-10 sm:px-8">
            {toast && (
                <div
                    className={cn(
                        "fixed right-6 top-20 z-50 rounded-md border px-4 py-2.5 text-[13px] font-medium shadow-sm",
                        toast.type === "success"
                            ? "border-success/20 bg-surface text-success"
                            : "border-danger/20 bg-surface text-danger",
                    )}
                >
                    {toast.message}
                </div>
            )}

            <AnimatePresence mode="wait" initial={false}>
                {detail === null ? (
                    /* ── 主视图 ─────────────────────────────────── */
                    <motion.div
                        key="master"
                        initial={{ opacity: 0, x: -20 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: -20 }}
                        transition={{ duration: 0.24, ease: EASE }}
                    >
                        {/* Hero —— appleid.apple.com 式居中头像 */}
                        <div className="flex flex-col items-center pb-8 pt-2 text-center">
                            <Avatar url={profile.avatar} name={profile.nickname} uid={profile.uid} />
                            <h1 className="mt-4 flex items-center gap-2.5 text-[24px] font-semibold tracking-tight text-foreground">
                                <span className="max-w-[320px] truncate">
                                    {profile.nickname || "用户 " + profile.uid}
                                </span>
                                <TierBadge membership={membership} />
                            </h1>
                            {profile.bio && (
                                <p className="mt-1 max-w-[420px] text-[13px] leading-relaxed text-secondary">
                                    {profile.bio}
                                </p>
                            )}
                            <div className="mt-1.5 flex items-center text-[12px] text-tertiary">
                                <span>UID {profile.uid}</span>
                                <button
                                    type="button"
                                    onClick={() => copyUid(profile.uid)}
                                    aria-label="复制 UID"
                                    className="mx-0.5 inline-flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-border-subtle hover:text-foreground"
                                >
                                    <Copy className="h-3 w-3" />
                                </button>
                                {profile.created_at && (
                                    <span>· 注册于 {fmtDate(profile.created_at)}</span>
                                )}
                            </div>
                        </div>

                        {/* 会员卡（实色深底，无渐变无模糊） */}
                        <MembershipCard
                            membership={membership}
                            tiers={tiers}
                            onOpen={() => router.push("/membership")}
                        />

                        {/* 个人资料 */}
                        <Group title="个人资料">
                            <ListRow
                                icon={<User className="h-4 w-4" />}
                                tint="bg-accent-soft text-accent"
                                label="昵称、简介、地区与语言"
                                value={profile.nickname || "未设置"}
                                onClick={() => setDetail("profile")}
                            />
                        </Group>

                        {/* 登录与安全 */}
                        <Group title="登录与安全">
                            <ListRow
                                icon={<Mail className="h-4 w-4" />}
                                tint="bg-sky-500/10 text-sky-600"
                                label="邮箱"
                                value={profile.email || "未绑定"}
                                tag={
                                    profile.email ? (
                                        <Tag tone={profile.email_verified ? "ok" : "warn"}>
                                            {profile.email_verified ? "已验证" : "未验证"}
                                        </Tag>
                                    ) : undefined
                                }
                                onClick={() => setDetail("email")}
                            />
                            <ListRow
                                icon={<Smartphone className="h-4 w-4" />}
                                tint="bg-emerald-500/10 text-emerald-600"
                                label="手机号"
                                value={profile.phone || "未绑定"}
                                tag={
                                    profile.phone ? (
                                        <Tag tone={profile.phone_verified ? "ok" : "warn"}>
                                            {profile.phone_verified ? "已验证" : "未验证"}
                                        </Tag>
                                    ) : undefined
                                }
                                onClick={() => setDetail("phone")}
                            />
                            <ListRow
                                icon={<KeyRound className="h-4 w-4" />}
                                tint="bg-orange-500/10 text-orange-600"
                                label="密码"
                                value={security.has_password ? "••••••••" : "未设置"}
                                onClick={() => setDetail("password")}
                            />
                            <ListRow
                                icon={<Tv className="h-4 w-4" />}
                                tint="bg-pink-500/10 text-pink-600"
                                label="B 站账号"
                                value={security.bilibili.nickname || "未绑定"}
                                tag={
                                    <Tag
                                        tone={
                                            security.bilibili.valid
                                                ? "ok"
                                                : security.bilibili.bound
                                                  ? "warn"
                                                  : "neutral"
                                        }
                                    >
                                        {security.bilibili.valid
                                            ? "可用"
                                            : security.bilibili.bound
                                              ? "已失效"
                                              : "未绑定"}
                                    </Tag>
                                }
                                onClick={() => setDetail("bilibili")}
                            />
                        </Group>

                        {/* 更多 */}
                        <Group title="更多">
                            <ListRow
                                icon={<Gauge className="h-4 w-4" />}
                                tint="bg-teal-500/10 text-teal-600"
                                label="用量与额度"
                                value={
                                    quotaSummary?.enabled
                                        ? `AI 问答 ${quotaSummary.kinds.find((k) => k.kind === "chat")?.used ?? 0}/${quotaSummary.kinds.find((k) => k.kind === "chat")?.limit ?? 0}`
                                        : "每日用量"
                                }
                                tag={
                                    quotaSummary?.tierSource === "fallback" ? (
                                        <Tag tone="warn">权益同步失败</Tag>
                                    ) : undefined
                                }
                                onClick={() => router.push("/quota")}
                            />
                            <ListRow
                                icon={<Crown className="h-4 w-4" />}
                                tint="bg-amber-500/10 text-amber-600"
                                label="会员中心"
                                value="等级 · 开通 · 续费"
                                onClick={() => router.push("/membership")}
                            />
                            <ListRow
                                icon={<Sparkles className="h-4 w-4" />}
                                tint="bg-violet-500/10 text-violet-600"
                                label="技能商店"
                                onClick={() => router.push("/skills")}
                            />
                            <ListRow
                                icon={<ShieldCheck className="h-4 w-4" />}
                                tint="bg-zinc-500/10 text-zinc-600"
                                label="凭证管理"
                                onClick={() => router.push("/settings")}
                            />
                        </Group>
                    </motion.div>
                ) : (
                    /* ── 详情视图（iOS push）────────────────────── */
                    <motion.div
                        key={detail}
                        initial={{ opacity: 0, x: 24 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: 24 }}
                        transition={{ duration: 0.24, ease: EASE }}
                    >
                        <DetailHeader title={DETAIL_TITLES[detail]} onBack={() => setDetail(null)} />
                        {detail === "profile" && (
                            <ProfileCard profile={profile} onUpdated={setProfile} onToast={flash} />
                        )}
                        {detail === "email" && (
                            <EmailCard profile={profile} onReload={load} onToast={flash} />
                        )}
                        {detail === "phone" && (
                            <PhoneCard profile={profile} onReload={load} onToast={flash} />
                        )}
                        {detail === "password" && (
                            <PasswordCard
                                profile={profile}
                                security={security}
                                onReload={load}
                                onToast={flash}
                            />
                        )}
                        {detail === "bilibili" && (
                            <BilibiliDetail security={security} onBind={() => setBindOpen(true)} />
                        )}
                    </motion.div>
                )}
            </AnimatePresence>

            <BilibiliBindModal
                isOpen={bindOpen}
                onClose={() => setBindOpen(false)}
                onBound={() => {
                    setBindOpen(false);
                    flash("B 站账号绑定成功", "success");
                    void load();
                }}
            />
        </div>
    );
}

/* ── 布局原语 ───────────────────────────────────────────────────── */

/** iOS 式分组列表：13px 灰标题 + 18px 圆角白卡 + 发丝分隔。 */
function Group({ title, children }: { title?: string; children: React.ReactNode }) {
    return (
        <section className="mt-8">
            {title && (
                <h2 className="mb-2 px-1 text-[13px] font-medium text-secondary">{title}</h2>
            )}
            <div className="overflow-hidden rounded-[18px] border border-border-subtle bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
                {children}
            </div>
        </section>
    );
}

/** 设置行：着色图标方块 + 标签 + 徽章 + 当前值 + Chevron，整行可点。 */
function ListRow({
    icon,
    tint,
    label,
    value,
    tag,
    onClick,
}: {
    icon: React.ReactNode;
    /** 图标方块底色/字色，iOS 设置风格 */
    tint: string;
    label: string;
    value?: string;
    tag?: React.ReactNode;
    onClick?: () => void;
}) {
    const content = (
        <>
            <span className={cn("grid h-7 w-7 shrink-0 place-items-center rounded-[8px]", tint)}>
                {icon}
            </span>
            <span className="flex-1 truncate text-[14px] font-medium text-foreground">{label}</span>
            {value !== undefined && (
                <span className="max-w-[40%] truncate text-[13px] text-tertiary">{value}</span>
            )}
            {tag}
            {onClick && <ChevronRight className="h-4 w-4 shrink-0 text-tertiary" />}
        </>
    );
    const className = cn(
        "flex w-full items-center gap-3 border-b border-border-subtle px-4 py-3 text-left transition-colors last:border-b-0",
        onClick && "cursor-pointer hover:bg-border-subtle/60",
    );
    if (onClick) {
        return (
            <button type="button" onClick={onClick} className={className}>
                {content}
            </button>
        );
    }
    return <div className={className}>{content}</div>;
}

/** 详情页顶栏：iOS 式蓝色返回键 + 大标题。 */
function DetailHeader({ title, onBack }: { title: string; onBack: () => void }) {
    return (
        <div className="mb-5">
            <button
                type="button"
                onClick={onBack}
                className="inline-flex items-center gap-0.5 text-[14px] font-medium text-accent transition-opacity hover:opacity-70"
            >
                <ChevronLeft className="h-4 w-4" />
                返回
            </button>
            <h1 className="mt-2 text-[26px] font-semibold tracking-tight text-foreground">
                {title}
            </h1>
        </div>
    );
}

/* ── 业务块 ─────────────────────────────────────────────────────── */

/** B 站账号详情：授权状态行 + 说明 + 绑定按钮（扫码弹窗由父级持有）。 */
function BilibiliDetail({
    security,
    onBind,
}: {
    security: SecurityOverview;
    onBind: () => void;
}) {
    const tone = security.bilibili.valid
        ? "ok"
        : security.bilibili.bound
          ? "warn"
          : "neutral";
    const status = security.bilibili.valid
        ? "可用"
        : security.bilibili.bound
          ? "已失效"
          : "未绑定";
    return (
        <Group>
            <div className="flex items-center gap-3 border-b border-border-subtle px-5 py-3.5">
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-[8px] bg-pink-500/10 text-pink-600">
                    <Tv className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-medium text-foreground">B 站账号</div>
                    <div className="truncate text-[12px] text-tertiary">
                        {security.bilibili.nickname || "未绑定"}
                    </div>
                </div>
                <Tag tone={tone}>{status}</Tag>
            </div>
            <div className="px-5 py-4">
                <p className="text-[12px] leading-relaxed text-secondary">
                    B 站授权用于同步收藏夹内容并构建知识库。
                    {security.bilibili.bound && !security.bilibili.valid &&
                        " 当前授权已失效，同步不可用，请重新绑定。"}
                    {!security.bilibili.bound && " 尚未绑定 B 站账号，绑定后即可同步收藏夹。"}
                </p>
                {!security.bilibili.valid && (
                    <button
                        type="button"
                        onClick={onBind}
                        className="btn-pill btn-primary mt-4 h-9 px-5 text-[13px]"
                    >
                        {security.bilibili.bound ? "重新绑定" : "扫码绑定"}
                    </button>
                )}
            </div>
        </Group>
    );
}

function Avatar({
    url,
    name,
    uid,
}: {
    url: string | null;
    name: string | null;
    uid: number;
}) {
    const [failed, setFailed] = useState(false);
    const initial = name?.[0] || String(uid).slice(0, 1);
    // URL 加载失败（外链头像被墙/防盗链/混合内容等）→ 回退首字母，不留破图
    if (url && !failed) {
        return (
            // eslint-disable-next-line @next/next/no-img-element
            <img
                src={url}
                alt=""
                onError={() => setFailed(true)}
                className="h-[88px] w-[88px] shrink-0 rounded-full object-cover ring-1 ring-border"
            />
        );
    }
    return (
        <div className="grid h-[88px] w-[88px] shrink-0 place-items-center rounded-full bg-foreground text-[30px] font-semibold text-surface">
            {initial}
        </div>
    );
}

function fmtDate(iso: string | null): string {
    if (!iso) return "";
    try {
        return new Date(iso).toLocaleDateString("zh-CN", {
            year: "numeric",
            month: "long",
        });
    } catch {
        return iso;
    }
}

/** 会员卡：实色深底（无渐变/模糊），点击进入会员中心。 */
function MembershipCard({
    membership,
    tiers,
    onOpen,
}: {
    membership: PayMembership | null;
    tiers: PayTierInfo[];
    onOpen: () => void;
}) {
    const tier = membership?.active ? (membership.tier ?? "").toUpperCase() : "FREE";
    const info =
        tiers.find((t) => t.tier.toUpperCase() === tier) ??
        tiers.find((t) => t.tier.toUpperCase() === "FREE");
    const isPaid = tier === "VIP" || tier === "SVIP";
    const expire =
        membership?.active && membership.expireAt
            ? new Date(membership.expireAt).toLocaleDateString("zh-CN")
            : null;
    return (
        <button
            type="button"
            onClick={onOpen}
            className="group flex w-full items-center gap-4 rounded-[18px] bg-zinc-900 px-5 py-4 text-left transition-opacity hover:opacity-95"
        >
            <span
                className={cn(
                    "grid h-10 w-10 shrink-0 place-items-center rounded-[10px]",
                    isPaid ? "bg-amber-400/15" : "bg-zinc-800",
                )}
            >
                <Crown className={cn("h-5 w-5", isPaid ? "text-amber-400" : "text-zinc-500")} />
            </span>
            <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                    <span
                        className={cn(
                            "text-[15px] font-semibold",
                            isPaid ? "text-amber-400" : "text-zinc-100",
                        )}
                    >
                        {info?.name ?? (isPaid ? tier : "免费用户")}
                    </span>
                    {expire && <span className="text-[11px] text-zinc-500">{expire} 到期</span>}
                </span>
                <span className="mt-0.5 block truncate text-[12px] text-zinc-400">
                    {info?.tagline ?? "升级会员解锁更高配额与优先调度"}
                </span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-zinc-600 transition-transform group-hover:translate-x-0.5" />
        </button>
    );
}

/** 会员等级徽章：app-pay tier（VIP|SVIP|null）+ active；免费/失效展示「免费用户」。 */
function TierBadge({ membership }: { membership: PayMembership | null }) {
    const tier = membership?.active ? (membership.tier ?? "").toUpperCase() : "";
    if (tier === "SVIP") {
        return (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-400 px-2 py-0.5 text-[11px] font-semibold text-zinc-900">
                <Crown className="h-3 w-3" />
                SVIP
            </span>
        );
    }
    if (tier === "VIP") {
        return (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800 ring-1 ring-amber-300">
                <Crown className="h-3 w-3" />
                VIP
            </span>
        );
    }
    return (
        <span className="inline-flex shrink-0 items-center rounded-full border border-border-subtle bg-surface px-2 py-0.5 text-[11px] text-tertiary">
            免费用户
        </span>
    );
}
