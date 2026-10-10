"use client";

/**
 * SettingsView - 设置页.
 *
 * 用户无需（也不再支持）自行配置 API Key：对话 / 向量化 / 语音识别等全部
 * AI 能力由平台经 AI 网关统一提供，权益随会员档位。本页只做能力说明与
 * 会员引导（开通 / 管理入口在 /membership）。
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { Crown, Sparkles } from "lucide-react";
import { payApi, type PayMembership } from "@/lib/api";

const TIER_BADGE: Record<string, string> = {
    VIP: "bg-amber-100 text-amber-800 ring-amber-300",
    SVIP: "bg-zinc-900 text-amber-200 ring-zinc-700",
};

export function SettingsView() {
    const [membership, setMembership] = useState<PayMembership | null>(null);
    const [loaded, setLoaded] = useState(false);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const m = await payApi.getMembership();
                if (!cancelled) setMembership(m);
            } catch {
                /* best-effort：拿不到会员态按未加载处理，不阻塞页面 */
            } finally {
                if (!cancelled) setLoaded(true);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    const tier = membership?.active ? (membership.tier ?? "").toUpperCase() : "";
    const badgeClass = tier ? TIER_BADGE[tier] : undefined;

    return (
        <div className="flex flex-col gap-5 px-6 py-8 sm:px-10">
            {/* Header */}
            <div>
                <h1 className="text-[20px] font-semibold tracking-tight text-foreground">
                    设置
                </h1>
                <p className="mt-1 text-[13px] text-secondary">
                    AI 能力由平台统一提供，无需自行配置 API Key。
                </p>
            </div>

            {/* AI 能力说明 */}
            <section className="rounded-lg border border-border-subtle bg-surface px-5 py-5">
                <div className="flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-foreground" />
                    <h2 className="text-[15px] font-semibold tracking-tight text-foreground">
                        AI 能力
                    </h2>
                </div>
                <p className="mt-2 text-[13px] leading-relaxed text-secondary">
                    智能问答、知识库向量化、语音识别、出题与批改等模型调用全部由平台统一调度，
                    无需配置任何密钥。对话与检索所用的模型额度随会员档位提升。
                </p>
            </section>

            {/* 会员引导 */}
            <section className="rounded-lg border border-border-subtle bg-surface px-5 py-5">
                <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                        <div className="flex items-center gap-2">
                            <Crown className="h-4 w-4 text-foreground" />
                            <h2 className="text-[15px] font-semibold tracking-tight text-foreground">
                                会员权益
                            </h2>
                        </div>
                        <p className="mt-2 text-[13px] leading-relaxed text-secondary">
                            开通 VIP / SVIP 获取更高的模型调用配额与优先调度。
                        </p>
                        <div className="mt-3 flex items-center gap-2">
                            {loaded ? (
                                membership?.active ? (
                                    <>
                                        <span
                                            className={`rounded-full px-2.5 py-0.5 text-[12px] font-semibold ring-1 ${
                                                badgeClass ?? "bg-border-subtle text-foreground ring-border"
                                            }`}
                                        >
                                            {tier || "会员"}
                                        </span>
                                        {membership.expireAt && (
                                            <span className="text-[12px] text-secondary">
                                                {new Date(membership.expireAt).toLocaleDateString()} 到期
                                            </span>
                                        )}
                                        {membership.autoRenew && (
                                            <span className="text-[11px] text-tertiary">自动续费中</span>
                                        )}
                                    </>
                                ) : (
                                    <span className="text-[13px] text-secondary">当前未开通会员</span>
                                )
                            ) : (
                                <span className="text-[13px] text-tertiary">加载中…</span>
                            )}
                        </div>
                    </div>
                    <Link
                        href="/membership"
                        className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-foreground px-4 text-[13px] font-medium text-background transition-opacity hover:opacity-90"
                    >
                        <Crown className="h-3.5 w-3.5" />
                        {membership?.active ? "管理会员" : "开通 VIP"}
                    </Link>
                </div>
            </section>
        </div>
    );
}
