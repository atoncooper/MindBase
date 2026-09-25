"use client";

/**
 * AccountView - 个人中心 (OpenAI account style).
 *
 * Left-aligned full-width flex column: profile header, then a stack of cards.
 * Each card is read-only by default with an "编辑" button that toggles inline
 * edit mode (profile / email / phone / password all editable).
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
    Loader2,
    AlertCircle,
    Copy,
    Tv,
    Sparkles,
    KeyRound,
} from "lucide-react";
import { userApi, type ProfileData, type SecurityOverview } from "@/lib/api";
import { ProfileCard } from "./profile-card";
import { EmailCard } from "./email-card";
import { PhoneCard } from "./phone-card";
import { PasswordCard } from "./password-card";
import { FormCard, Tag } from "./form-card";
import { Row } from "./settings-group";

type Toast = { message: string; type: "success" | "error" };

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
        try {
            const [p, s] = await fetchAccount();
            setProfile(p);
            setSecurity(s);
            setError(null);
        } catch (e) {
            setError(e instanceof Error ? e.message : "加载失败");
        }
    }, []);

    // Initial load.
    useEffect(() => {
        let cancelled = false;
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
    }, []);

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
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6 px-6 py-8 sm:px-10">
            {toast && (
                <div
                    className={`fixed right-6 top-20 z-50 rounded-md border px-4 py-2.5 text-[13px] font-medium shadow-sm ${
                        toast.type === "success"
                            ? "border-success/20 bg-surface text-success"
                            : "border-danger/20 bg-surface text-danger"
                    }`}
                >
                    {toast.message}
                </div>
            )}

            {/* Profile header */}
            <div className="flex items-center gap-4">
                <Avatar url={profile.avatar} name={profile.nickname} uid={profile.uid} />
                <div className="min-w-0">
                    <h1 className="truncate text-[20px] font-semibold tracking-tight text-foreground">
                        {profile.nickname || `用户 ${profile.uid}`}
                    </h1>
                    {profile.bio && (
                        <p className="mt-0.5 truncate text-[13px] text-secondary">
                            {profile.bio}
                        </p>
                    )}
                    <div className="mt-0.5 flex items-center text-[12px] text-tertiary">
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
            </div>

            {/* 基础资料 */}
            <section className="flex flex-col gap-3">
                <SectionLabel>基础资料</SectionLabel>
                <ProfileCard profile={profile} onUpdated={setProfile} onToast={flash} />
            </section>

            {/* 登录与安全 */}
            <section className="flex flex-col gap-3">
                <SectionLabel>登录与安全</SectionLabel>
                <EmailCard profile={profile} onReload={load} onToast={flash} />
                <PhoneCard profile={profile} onReload={load} onToast={flash} />
                <PasswordCard
                    profile={profile}
                    security={security}
                    onReload={load}
                    onToast={flash}
                />

                {/* Bilibili binding (read-only) */}
                <FormCard title="B 站账号" description="B 站授权状态，用于同步收藏夹内容。">
                    <div className="flex items-center gap-3 px-5 py-3.5">
                        <Tv className="h-4 w-4 shrink-0 text-secondary" />
                        <div className="min-w-0 flex-1 text-[13px] text-foreground">
                            {security.bilibili.nickname || "未绑定"}
                        </div>
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
                    </div>
                </FormCard>
            </section>

            {/* 更多 */}
            <section className="flex flex-col gap-3">
                <SectionLabel>更多</SectionLabel>
                <FormCard title="快捷入口" description="前往相关管理页面。">
                    <Row
                        icon={<Sparkles className="h-4 w-4" />}
                        label="技能商店"
                        onClick={() => router.push("/skills")}
                    />
                    <Row
                        icon={<KeyRound className="h-4 w-4" />}
                        label="凭证管理"
                        onClick={() => router.push("/settings")}
                    />
                </FormCard>
            </section>
        </div>
    );
}

/** Tiny group caption above a cluster of cards (Apple settings style). */
function SectionLabel({ children }: { children: React.ReactNode }) {
    return (
        <h2 className="text-[11px] font-medium tracking-wider text-tertiary">
            {children}
        </h2>
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
    const initial = name?.[0] || String(uid).slice(0, 1);
    if (url) {
        return (
            // eslint-disable-next-line @next/next/no-img-element
            <img
                src={url}
                alt=""
                className="h-16 w-16 shrink-0 rounded-full object-cover ring-1 ring-border-subtle"
            />
        );
    }
    return (
        <div className="grid h-16 w-16 shrink-0 place-items-center rounded-full bg-foreground text-[22px] font-semibold text-surface">
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
