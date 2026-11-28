"use client";

/**
 * AccountView - 个人中心（Google Workspace Admin 式主从结构）。
 *
 *   左侧 264px 导航：账户摘要 + 账户 / 登录与安全 / 服务与权益三组入口 +
 *                     技能商店 / 设置快捷入口 + 退出登录；
 *   右侧内容区：flex-1 自适应铺满剩余宽度；面包屑 + 页面标题 + 分区详情。
 *
 * 视觉采用 Google Account 配色（#f8f9fa 页面底、#dadce0 描边、#0b57d0 主色、
 * #202124 正文），通过 globals.css 的 .g-account 作用域覆盖语义 token，
 * 现有资料/邮箱/手机/密码/Coding Plan 卡片的业务逻辑保持不变。
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, ChevronRight, ExternalLink, UserRound } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useAppToast } from "@/lib/app-toast";
import {
    payApi,
    quotaApi,
    userApi,
    type PayMembership,
    type PayTierInfo,
    type ProfileData,
    type QuotaSummary,
    type SecurityOverview,
} from "@/lib/api";
import { ProfileCard } from "./profile-card";
import { EmailCard } from "./email-card";
import { PhoneCard } from "./phone-card";
import { PasswordCard } from "./password-card";
import { BilibiliBindModal } from "./bilibili-bind-modal";
import { CodingPlanCard } from "./coding-plan-card";
import { AccountOverview, OverviewMeta } from "./account-overview";
import {
    BilibiliSection,
    MembershipSection,
    QuotaSection,
    SecurityPending,
    SecurityUnavailable,
} from "./account-sections";
import { AccountSidebar } from "./account-sidebar";
import { isSectionKey, SECTION_META, type SectionKey } from "./account-config";
import { AccountCard, GoogleButton, GoogleLinkButton } from "./account-ui";

export function AccountView() {
    const router = useRouter();
    const { logout } = useAuth();
    const { show } = useAppToast();

    const [profile, setProfile] = useState<ProfileData | null>(null);
    const [security, setSecurity] = useState<SecurityOverview | null>(null);
    const [securityLoading, setSecurityLoading] = useState(true);
    const [securityError, setSecurityError] = useState<string | null>(null);
    // 会员态（app-pay）。拉取失败静默降级为「免费用户」，不阻塞个人中心。
    const [membership, setMembership] = useState<PayMembership | null>(null);
    const [tiers, setTiers] = useState<PayTierInfo[]>([]);
    // 用量摘要（/quota/summary）：概览与用量分区共用，失败静默。
    const [quotaSummary, setQuotaSummary] = useState<QuotaSummary | null>(null);

    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    // 允许 #email / #quota 等深链；初始渲染仍是骨架，不会造成 hydration 差异。
    const [active, setActive] = useState<SectionKey>(() => {
        if (typeof window === "undefined") return "overview";
        const hash = window.location.hash.replace("#", "");
        return isSectionKey(hash) ? hash : "overview";
    });
    const [bindOpen, setBindOpen] = useState(false);

    const flash = useCallback(
        (message: string, type: "success" | "error") => {
            show(type, message);
        },
        [show],
    );

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

    const loadSecurity = useCallback(async () => {
        setSecurityLoading(true);
        try {
            const s = await userApi.getSecurity();
            setSecurity(s);
            setSecurityError(null);
        } catch (e) {
            setSecurityError(e instanceof Error ? e.message : "安全信息加载失败");
        } finally {
            setSecurityLoading(false);
        }
    }, []);

    // 首屏：资料优先（快），安全概览在后台跑（B 站实时校验可能 2–8s）。
    useEffect(() => {
        let cancelled = false;
        loadMembership();
        (async () => {
            try {
                const p = await userApi.getProfile();
                if (cancelled) return;
                setProfile(p);
                setLoading(false);
                void loadSecurity();
            } catch (e) {
                if (cancelled) return;
                setError(e instanceof Error ? e.message : "加载失败");
                setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [loadMembership, loadSecurity]);

    const retryProfile = useCallback(async () => {
        setLoading(true);
        setError(null);
        loadMembership();
        try {
            const p = await userApi.getProfile();
            setProfile(p);
            setLoading(false);
            void loadSecurity();
        } catch (e) {
            setError(e instanceof Error ? e.message : "加载失败");
            setLoading(false);
        }
    }, [loadMembership, loadSecurity]);

    // 编辑成功后的后台刷新：不闪整页 loading，只更新资料并重查安全态。
    const reloadAfterEdit = useCallback(async () => {
        loadMembership();
        try {
            const p = await userApi.getProfile();
            setProfile(p);
            void loadSecurity();
        } catch (e) {
            flash(e instanceof Error ? e.message : "资料刷新失败", "error");
        }
    }, [flash, loadMembership, loadSecurity]);

    const selectSection = useCallback((key: SectionKey) => {
        setActive(key);
        if (typeof window !== "undefined") {
            window.history.replaceState(null, "", `#${key}`);
            window.scrollTo({ top: 0, behavior: "smooth" });
        }
    }, []);

    const handleLogout = useCallback(async () => {
        try {
            await logout();
        } finally {
            router.replace("/");
        }
    }, [logout, router]);

    if (loading) return <AccountSkeleton />;
    if (error || !profile) {
        return <AccountError message={error ?? "加载失败"} onRetry={() => void retryProfile()} />;
    }

    const securityRequired =
        active === "email" ||
        active === "phone" ||
        active === "password" ||
        active === "bilibili";

    const headerMeta =
        active === "overview" ? (
            <OverviewMeta profile={profile} onToast={flash} />
        ) : undefined;

    const headerAction =
        active === "overview" ? (
            <GoogleButton
                variant="outlined"
                className="h-8 px-3.5 text-[12px]"
                onClick={() => selectSection("profile")}
            >
                <UserRound className="h-3.5 w-3.5" />
                编辑资料
            </GoogleButton>
        ) : active === "membership" ? (
            <GoogleLinkButton href="/membership" variant="outlined" className="h-8 px-3.5 text-[12px]">
                <ExternalLink className="h-3.5 w-3.5" />
                会员中心
            </GoogleLinkButton>
        ) : active === "quota" ? (
            <GoogleLinkButton href="/quota" variant="outlined" className="h-8 px-3.5 text-[12px]">
                <ExternalLink className="h-3.5 w-3.5" />
                完整用量
            </GoogleLinkButton>
        ) : undefined;

    function renderSection() {
        if (securityRequired && !security) {
            return securityLoading ? (
                <SecurityPending />
            ) : (
                <SecurityUnavailable
                    error={securityError}
                    onRetry={() => void loadSecurity()}
                />
            );
        }

        switch (active) {
            case "overview":
                return (
                    <AccountOverview
                        profile={profile!}
                        security={security}
                        securityError={securityError}
                        membership={membership}
                        tiers={tiers}
                        quota={quotaSummary}
                        onNavigate={selectSection}
                        onRetrySecurity={() => void loadSecurity()}
                    />
                );
            case "profile":
                return (
                    <div className="w-full max-w-[1120px]">
                        <ProfileCard
                            profile={profile!}
                            membership={membership}
                            onUpdated={setProfile}
                            onToast={flash}
                        />
                    </div>
                );
            case "email":
                return (
                    <div className="w-full">
                        <EmailCard
                            profile={profile!}
                            security={security!}
                            onReload={() => void reloadAfterEdit()}
                            onToast={flash}
                        />
                    </div>
                );
            case "phone":
                return (
                    <div className="w-full">
                        <PhoneCard
                            profile={profile!}
                            security={security!}
                            onReload={() => void reloadAfterEdit()}
                            onToast={flash}
                        />
                    </div>
                );
            case "password":
                return (
                    <div className="w-full">
                        <PasswordCard
                            profile={profile!}
                            security={security!}
                            onReload={() => void reloadAfterEdit()}
                            onToast={flash}
                        />
                    </div>
                );
            case "bilibili":
                return (
                    <BilibiliSection
                        security={security!}
                        onBind={() => setBindOpen(true)}
                    />
                );
            case "membership":
                return <MembershipSection membership={membership} tiers={tiers} />;
            case "quota":
                return <QuotaSection quota={quotaSummary} />;
            case "coding-plan":
                return (
                    <CodingPlanCard
                        membership={membership}
                        quota={quotaSummary}
                        onToast={flash}
                    />
                );
            default:
                return null;
        }
    }

    return (
        <div className="g-account min-h-[calc(100dvh-3rem)]">
            <div className="w-full px-4 py-6 sm:px-6 lg:px-8 lg:py-8 xl:px-10">
                <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
                    <AccountSidebar
                        profile={profile}
                        security={security}
                        membership={membership}
                        active={active}
                        onSelect={selectSection}
                        onLogout={() => void handleLogout()}
                    />

                    <div className="min-w-0 flex-1">
                        <SectionHeader
                            active={active}
                            onSelect={selectSection}
                            action={headerAction}
                            metaLine={headerMeta}
                        />
                        <AnimatePresence mode="wait" initial={false}>
                            <motion.div
                                key={active}
                                initial={{ opacity: 0, y: 6 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -4 }}
                                transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
                            >
                                {renderSection()}
                            </motion.div>
                        </AnimatePresence>
                    </div>
                </div>
            </div>

            <BilibiliBindModal
                variant="google"
                isOpen={bindOpen}
                onClose={() => setBindOpen(false)}
                onBound={() => {
                    setBindOpen(false);
                    flash("B 站账号绑定成功", "success");
                    void reloadAfterEdit();
                }}
            />
        </div>
    );
}

/* ── 页面头部 ────────────────────────────────────────────────────── */

function SectionHeader({
    active,
    onSelect,
    action,
    metaLine,
}: {
    active: SectionKey;
    onSelect: (key: SectionKey) => void;
    action?: React.ReactNode;
    /** 概览页的账户元信息（UID / 注册时间等），由调用方传入。 */
    metaLine?: React.ReactNode;
}) {
    const meta = SECTION_META[active];
    return (
        <header className="mb-5 flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
            <div className="min-w-0">
                <nav className="flex items-center gap-1.5 text-[12px] text-secondary" aria-label="面包屑">
                    {active === "overview" ? (
                        <span>MindBase</span>
                    ) : (
                        <button
                            type="button"
                            onClick={() => onSelect("overview")}
                            className="rounded px-1 py-0.5 transition-colors hover:bg-[#f1f3f4] hover:text-accent"
                        >
                            个人中心
                        </button>
                    )}
                    <ChevronRight className="h-3 w-3 shrink-0 text-tertiary" />
                    <span className="truncate text-foreground">{meta.title}</span>
                </nav>
                <h1 className="mt-2 text-[26px] font-medium leading-8 text-foreground">
                    {meta.title}
                </h1>
                <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-secondary">
                    {meta.description}
                </p>
                {metaLine && <div className="mt-3">{metaLine}</div>}
            </div>
            {action && <div className="pt-7 max-sm:mt-1 max-sm:pt-0">{action}</div>}
        </header>
    );
}

function AccountSkeleton() {
    return (
        <div className="g-account min-h-[calc(100dvh-3rem)]" aria-busy="true">
            <div className="w-full px-4 py-6 sm:px-6 lg:px-8 lg:py-8 xl:px-10">
                <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
                    <div className="h-[220px] animate-pulse rounded-[12px] border border-border bg-surface lg:h-[430px] lg:w-[264px] lg:shrink-0" />
                    <div className="min-w-0 flex-1">
                        <div className="h-3 w-24 animate-pulse rounded bg-[#e8eaed]" />
                        <div className="mt-3 h-8 w-52 animate-pulse rounded bg-[#e8eaed]" />
                        <div className="mt-2 h-4 w-80 max-w-full animate-pulse rounded bg-[#f1f3f4]" />
                        <div className="mt-6 h-[280px] animate-pulse rounded-[12px] border border-border bg-surface" />
                        <div className="mt-4 grid gap-4 sm:grid-cols-2">
                            <div className="h-56 animate-pulse rounded-[12px] border border-border bg-surface" />
                            <div className="h-56 animate-pulse rounded-[12px] border border-border bg-surface" />
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

function AccountError({ message, onRetry }: { message: string; onRetry: () => void }) {
    return (
        <div className="g-account min-h-[calc(100dvh-3rem)]">
            <div className="mx-auto w-full max-w-[560px] px-5 py-16">
                <AccountCard>
                    <div className="flex flex-col items-center px-6 py-8 text-center">
                        <span className="grid h-12 w-12 place-items-center rounded-full bg-danger/10 text-danger">
                            <AlertCircle className="h-6 w-6" />
                        </span>
                        <h1 className="mt-4 text-[18px] font-medium text-foreground">
                            个人中心加载失败
                        </h1>
                        <p className="mt-1 break-words text-[13px] leading-relaxed text-secondary">
                            {message}
                        </p>
                        <GoogleButton onClick={onRetry} className="mt-5">
                            重试
                        </GoogleButton>
                    </div>
                </AccountCard>
            </div>
        </div>
    );
}
