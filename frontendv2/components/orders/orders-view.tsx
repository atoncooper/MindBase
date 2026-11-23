"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
    ArrowUpRight,
    Check,
    ChevronLeft,
    ChevronRight,
    Copy,
    CreditCard,
    Loader2,
    ReceiptText,
} from "lucide-react";
import { payApi, formatYuan, type PayOrder, type PayOrderPage } from "@/lib/api/pay";
import { emitAppToast } from "@/lib/app-toast";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<string, string> = {
    CREATED: "待支付",
    PAID: "已支付",
    DELIVERED: "已开通",
    CLOSED: "已关闭",
    REFUNDING: "退款中",
    REFUNDED: "已退款",
};

function isExpired(order: PayOrder): boolean {
    if (order.status !== "CREATED" || !order.expiresAt) return false;
    return new Date(order.expiresAt).getTime() <= Date.now();
}

function channelLabel(channel: string): string {
    return channel === "ALIPAY" ? "支付宝" : channel === "MOCK" ? "模拟支付" : channel;
}

/** Compact page window: 1 … 4 5 6 … 12 */
function pageWindow(current: number, total: number): Array<number | "…"> {
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    const pages = new Set([1, total, current - 1, current, current + 1]);
    const sorted = [...pages].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
    const out: Array<number | "…"> = [];
    for (const n of sorted) {
        const prev = out[out.length - 1];
        if (typeof prev === "number" && n - prev > 1) out.push("…");
        out.push(n);
    }
    return out;
}

export function OrdersView() {
    const [data, setData] = useState<PayOrderPage | null>(null);
    const [page, setPage] = useState(1);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [cancelling, setCancelling] = useState<string | null>(null);
    const [copied, setCopied] = useState<string | null>(null);

    const load = useCallback(async (nextPage: number) => {
        setLoading(true);
        setError(null);
        try {
            const result = await payApi.listOrdersPage(nextPage, 10);
            setData(result);
            setPage(result.page);
        } catch (err) {
            setError(err instanceof Error ? err.message : "订单记录加载失败");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load(page);
        // Deliberately only on mount: page changes are driven by goToPage below.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    function goToPage(next: number) {
        if (loading || !data) return;
        if (next < 1 || next > Math.max(1, Math.ceil(data.total / data.pageSize))) return;
        void load(next);
    }

    async function copyOrderNo(orderNo: string) {
        try {
            await navigator.clipboard.writeText(orderNo);
            setCopied(orderNo);
            window.setTimeout(() => setCopied(null), 1500);
        } catch {
            emitAppToast("error", "复制失败，请手动选择订单号");
        }
    }

    async function cancelOrder(order: PayOrder) {
        setCancelling(order.orderNo);
        try {
            await payApi.cancelOrder(order.orderNo);
            emitAppToast("success", "订单已取消");
            const nextPage = data && data.items.length === 1 && page > 1 ? page - 1 : page;
            await load(nextPage);
        } catch (err) {
            emitAppToast("error", err instanceof Error ? err.message : "取消失败");
        } finally {
            setCancelling(null);
        }
    }

    const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
    const pages = useMemo(() => pageWindow(page, totalPages), [page, totalPages]);

    return (
        <div className="min-h-[calc(100dvh-3rem)] bg-[#f5f6f8]">
            <div className="mx-auto w-full max-w-[1100px] px-5 py-8 sm:px-8 sm:py-10">
                <header className="flex flex-wrap items-end justify-between gap-4">
                    <div>
                        <p className="text-[12px] text-tertiary">
                            <Link href="/membership" className="transition-colors hover:text-foreground">
                                会员中心
                            </Link>
                            <span className="mx-1.5">/</span>
                            订单记录
                        </p>
                        <h1 className="mt-2 text-[26px] font-medium leading-8 text-foreground">订单记录</h1>
                        <p className="mt-1 text-[13px] leading-relaxed text-secondary">
                            查看会员开通、续费与升级记录。待支付订单可在这里取消，或前往会员中心继续支付。
                        </p>
                    </div>
                    <Link
                        href="/membership"
                        className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border bg-surface px-4 text-[12px] font-medium text-foreground shadow-sm transition-colors hover:bg-white"
                    >
                        <CreditCard className="h-3.5 w-3.5" />
                        会员中心
                    </Link>
                </header>

                <div className="mt-6 flex items-center justify-between rounded-xl border border-border-subtle bg-surface px-4 py-3">
                    <div className="flex items-center gap-2 text-[12px] text-secondary">
                        <ReceiptText className="h-4 w-4 text-tertiary" />
                        共 <span className="font-medium text-foreground">{data?.total ?? 0}</span> 笔订单
                    </div>
                    <span className="text-[11px] text-tertiary">
                        {data ? `第 ${page} / ${totalPages} 页` : "加载中…"}
                    </span>
                </div>

                {loading ? (
                    <div className="mt-4 space-y-3" aria-busy="true">
                        {[0, 1, 2].map((i) => (
                            <div key={i} className="h-40 animate-pulse rounded-2xl border border-border-subtle bg-surface" />
                        ))}
                    </div>
                ) : error ? (
                    <div className="mt-4 rounded-2xl border border-danger/20 bg-danger/5 p-6 text-center">
                        <p className="text-[13px] text-danger">{error}</p>
                        <button
                            type="button"
                            onClick={() => void load(page)}
                            className="mt-3 text-[12px] font-medium text-accent hover:underline"
                        >
                            重试
                        </button>
                    </div>
                ) : !data || data.items.length === 0 ? (
                    <div className="mt-4 rounded-2xl border border-border-subtle bg-surface px-6 py-16 text-center">
                        <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-accent-soft text-accent">
                            <ReceiptText className="h-5 w-5" />
                        </span>
                        <h2 className="mt-4 text-[15px] font-medium text-foreground">还没有订单</h2>
                        <p className="mt-1 text-[12px] text-secondary">开通会员后，订单记录会显示在这里。</p>
                        <Link
                            href="/membership"
                            className="mt-5 inline-flex h-9 items-center gap-1 rounded-full bg-[#1f2329] px-4 text-[12px] font-medium text-white"
                        >
                            去看看会员
                            <ArrowUpRight className="h-3.5 w-3.5" />
                        </Link>
                    </div>
                ) : (
                    <div className="mt-4 space-y-3">
                        {data.items.map((order) => {
                            const expired = isExpired(order);
                            const payable = order.status === "CREATED" && !expired;
                            const paid = order.status === "PAID" || order.status === "DELIVERED";
                            return (
                                <article
                                    key={order.orderNo}
                                    className={cn(
                                        "rounded-2xl border bg-surface p-5 shadow-[0_1px_2px_rgba(60,64,67,0.04)]",
                                        paid ? "border-amber-300/50" : "border-border-subtle"
                                    )}
                                >
                                    <div className="flex flex-wrap items-start justify-between gap-3">
                                        <div className="min-w-0">
                                            <div className="flex flex-wrap items-center gap-2">
                                                <h2 className="text-[15px] font-semibold text-foreground">
                                                    {order.productTitle}
                                                </h2>
                                                <span
                                                    className={cn(
                                                        "rounded-full px-2 py-0.5 text-[11px] font-medium",
                                                        paid && "bg-emerald-50 text-emerald-700",
                                                        payable && "bg-amber-50 text-amber-700",
                                                        order.status === "CLOSED" && "bg-zinc-100 text-zinc-500",
                                                        !paid && !payable && order.status !== "CLOSED" && "bg-zinc-100 text-zinc-600"
                                                    )}
                                                >
                                                    {STATUS_LABEL[order.status] ?? order.status}
                                                </span>
                                            </div>
                                            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-tertiary">
                                                <span>{channelLabel(order.channel)}</span>
                                                <span>·</span>
                                                <span>{order.durationDays} 天</span>
                                                <span>·</span>
                                                <span>{order.createdAt ? new Date(order.createdAt).toLocaleString() : "—"}</span>
                                            </p>
                                        </div>
                                        <div className="shrink-0 text-right">
                                            <span className="text-[22px] font-semibold tracking-tight text-foreground">
                                                <span className="text-[13px] font-normal text-secondary">¥</span>
                                                {formatYuan(order.amountCents)}
                                            </span>
                                        </div>
                                    </div>

                                    <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-2 border-t border-border-subtle pt-4 text-[12px] sm:grid-cols-2">
                                        <div className="flex min-w-0 items-center gap-2">
                                            <dt className="shrink-0 text-tertiary">订单号</dt>
                                            <dd className="flex min-w-0 items-center gap-1.5">
                                                <code className="truncate font-mono text-[11px] text-foreground">{order.orderNo}</code>
                                                <button
                                                    type="button"
                                                    onClick={() => void copyOrderNo(order.orderNo)}
                                                    className="inline-flex shrink-0 items-center gap-0.5 text-[11px] text-accent hover:underline"
                                                    aria-label={copied === order.orderNo ? "已复制订单号" : "复制订单号"}
                                                >
                                                    {copied === order.orderNo ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                                                    {copied === order.orderNo ? "已复制" : "复制"}
                                                </button>
                                            </dd>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <dt className="shrink-0 text-tertiary">支付渠道</dt>
                                            <dd className="text-foreground">{channelLabel(order.channel)}</dd>
                                        </div>
                                        {payable && order.expiresAt && (
                                            <div className="flex items-center gap-2">
                                                <dt className="shrink-0 text-tertiary">支付截止</dt>
                                                <dd className="text-secondary">{new Date(order.expiresAt).toLocaleString()}</dd>
                                            </div>
                                        )}
                                        {paid && order.paidAt && (
                                            <div className="flex items-center gap-2">
                                                <dt className="shrink-0 text-tertiary">支付时间</dt>
                                                <dd className="text-secondary">{new Date(order.paidAt).toLocaleString()}</dd>
                                            </div>
                                        )}
                                        {paid && order.buyerLogonId && (
                                            <div className="flex min-w-0 items-center gap-2">
                                                <dt className="shrink-0 text-tertiary">付款账户</dt>
                                                <dd className="truncate font-medium text-foreground">{order.buyerLogonId}</dd>
                                            </div>
                                        )}
                                    </dl>

                                    {(payable || order.status === "CREATED" || order.status === "CLOSED") && (
                                        <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
                                            {payable && (
                                                <Link
                                                    href={`/membership?order=${encodeURIComponent(order.orderNo)}`}
                                                    className="inline-flex h-8 items-center gap-1 rounded-full bg-[#1f2329] px-3.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90"
                                                >
                                                    继续支付
                                                    <ArrowUpRight className="h-3 w-3" />
                                                </Link>
                                            )}
                                            {order.status === "CREATED" && (
                                                <button
                                                    type="button"
                                                    disabled={cancelling === order.orderNo}
                                                    onClick={() => void cancelOrder(order)}
                                                    className="inline-flex h-8 items-center gap-1 text-[12px] text-secondary transition-colors hover:text-danger disabled:opacity-50"
                                                >
                                                    {cancelling === order.orderNo && <Loader2 className="h-3 w-3 animate-spin" />}
                                                    取消订单
                                                </button>
                                            )}
                                            {(expired || order.status === "CLOSED") && (
                                                <Link href="/membership" className="text-[12px] font-medium text-accent hover:underline">
                                                    重新开通
                                                </Link>
                                            )}
                                        </div>
                                    )}
                                </article>
                            );
                        })}
                    </div>
                )}

                {data && data.total > 0 && (
                    <nav className="mt-6 flex flex-wrap items-center justify-between gap-3" aria-label="订单分页">
                        <p className="text-[11px] text-tertiary">
                            第 {page} / {totalPages} 页，共 {data.total} 笔
                        </p>
                        <div className="flex items-center gap-1">
                            <button
                                type="button"
                                disabled={page <= 1 || loading}
                                onClick={() => goToPage(page - 1)}
                                className="grid h-8 w-8 place-items-center rounded-lg border border-border bg-surface text-secondary transition-colors hover:bg-white disabled:opacity-40"
                                aria-label="上一页"
                            >
                                <ChevronLeft className="h-4 w-4" />
                            </button>
                            {pages.map((p, i) =>
                                p === "…" ? (
                                    <span key={`gap-${i}`} className="px-1 text-[12px] text-tertiary">…</span>
                                ) : (
                                    <button
                                        key={p}
                                        type="button"
                                        onClick={() => goToPage(p)}
                                        aria-current={p === page ? "page" : undefined}
                                        className={cn(
                                            "grid h-8 min-w-8 place-items-center rounded-lg px-2 text-[12px] transition-colors",
                                            p === page
                                                ? "bg-[#1f2329] font-medium text-white"
                                                : "border border-border bg-surface text-secondary hover:bg-white"
                                        )}
                                    >
                                        {p}
                                    </button>
                                )
                            )}
                            <button
                                type="button"
                                disabled={!data.hasMore || loading}
                                onClick={() => goToPage(page + 1)}
                                className="grid h-8 w-8 place-items-center rounded-lg border border-border bg-surface text-secondary transition-colors hover:bg-white disabled:opacity-40"
                                aria-label="下一页"
                            >
                                <ChevronRight className="h-4 w-4" />
                            </button>
                        </div>
                    </nav>
                )}
            </div>
        </div>
    );
}
