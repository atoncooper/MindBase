"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Check, ChevronRight, Crown, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { emitAppToast } from "@/lib/app-toast";
import {
    formatYuan,
    payApi,
    type PayChannel,
    type PayChannelInfo,
    type PayComparisonRow,
    type PayMembership,
    type PayOrder,
    type PayProduct,
    type PayTierInfo,
    type PayUpgradeQuote,
} from "@/lib/api";

/**
 * 会员中心 — 腾讯开通页风格：黑金 Hero + 套餐选择卡 + 权益对照表 + 订单。
 *
 * 渠道由 GET /pay/channels 决定（MOCK 仅测试环境；ALIPAY 走当面付二维码）。
 * 档位简介与权益对照由 GET /pay/tiers、/pay/comparison 下发（app-pay Java 侧维护）。
 */

const CARD_SHADOW = "shadow-[0_1px_2px_rgba(0,0,0,0.10),0_0_0_0.5px_rgba(0,0,0,0.05)]";

const STATUS_LABEL: Record<string, string> = {
    CREATED: "待支付",
    PAID: "已支付（开通中）",
    DELIVERED: "已开通",
    CLOSED: "已关闭",
    REFUNDING: "退款中",
    REFUNDED: "已退款",
};

const ORDER_POLL_MS = 2500;
const ORDER_POLL_CAP_MS = 10000;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 订单是否已不可支付：非 CREATED，或 CREATED 但收款有效期已过。 */
function isOrderExpired(o: PayOrder): boolean {
    if (o.status !== "CREATED") return true;
    if (!o.expiresAt) return false;
    return new Date(o.expiresAt).getTime() <= Date.now();
}

/** 档位等级：FREE=0 / VIP=1 / SVIP=2 / PROMAX=3。 */
function targetTierOf(code: string): string {
    if (code.startsWith("PROMAX_")) return "PROMAX";
    if (code.startsWith("SVIP_")) return "SVIP";
    return "VIP";
}
function tierRank(t: string): number {
    const u = (t ?? "").toUpperCase();
    return u === "PROMAX" ? 3 : u === "SVIP" ? 2 : u === "VIP" ? 1 : 0;
}

/** 从订单构造 PayDialog 需要的商品信息（重新付款场景：不再依赖 SKU 目录）。 */
function productFromOrder(o: PayOrder): PayProduct {
    return {
        code: o.skuCode,
        title: o.productTitle,
        durationDays: o.durationDays,
        priceCents: o.amountCents,
        status: "ACTIVE",
    };
}

export function MembershipView() {
    const [membership, setMembership] = useState<PayMembership | null>(null);
    const [products, setProducts] = useState<PayProduct[]>([]);
    const [channels, setChannels] = useState<PayChannelInfo[]>([]);
    const [tiers, setTiers] = useState<PayTierInfo[]>([]);
    const [comparison, setComparison] = useState<PayComparisonRow[]>([]);
    // 升级换购报价（同档补差价，服务端计价）：商品卡据此显示差价与可升级态
    const [upgradeQuotes, setUpgradeQuotes] = useState<PayUpgradeQuote[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);

    const [pendingSku, setPendingSku] = useState<PayProduct | null>(null);
    const [activeOrder, setActiveOrder] = useState<PayOrder | null>(null);
    const [qrUrl, setQrUrl] = useState<string | null>(null);
    const [paying, setPaying] = useState(false);
    const [channel, setChannel] = useState<PayChannel>("MOCK");
    const [selectedSku, setSelectedSku] = useState<string | null>(null);
    const qrUrlRef = useRef<string | null>(null);

    const enabledChannels = useMemo(
        () => channels.filter((c) => c.enabled).map((c) => c.code),
        [channels]
    );
    const defaultChannel: PayChannel = useMemo(() => {
        if (enabledChannels.includes("ALIPAY")) return "ALIPAY";
        return enabledChannels[0] ?? "MOCK";
    }, [enabledChannels]);

    useEffect(() => {
        setChannel(defaultChannel);
    }, [defaultChannel]);

    const refresh = useCallback(async () => {
        try {
            const [m, p, c, t, cmp, uq] = await Promise.all([
                payApi.getMembership(),
                payApi.products(),
                payApi.channels(),
                payApi.tiers(),
                payApi.comparison(),
                payApi.upgradeQuotes(),
            ]);
            setMembership(m);
            setProducts(p);
            setChannels(c);
            setTiers(t);
            setComparison(cmp);
            setUpgradeQuotes(uq);
            setLoadError(null);
        } catch (err) {
            setLoadError(err instanceof Error ? err.message : "加载失败");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const revokeQr = useCallback(() => {
        if (qrUrlRef.current) {
            URL.revokeObjectURL(qrUrlRef.current);
            qrUrlRef.current = null;
        }
        setQrUrl(null);
    }, []);

    // Dedicated /orders page can hand a pending order back to this page:
    // /membership?order=PO... re-opens the payment dialog for that order.
    useEffect(() => {
        if (typeof window === "undefined") return;
        const orderNo = new URLSearchParams(window.location.search).get("order");
        if (!orderNo) return;
        let cancelled = false;
        void (async () => {
            try {
                const order = await payApi.getOrder(orderNo);
                if (cancelled) return;
                setPendingSku(productFromOrder(order));
                setActiveOrder(order);
                setChannel(order.channel);
                setPaying(true);
                if (order.channel !== "MOCK") {
                    const url = await payApi.orderQrBlobUrl(order.orderNo);
                    if (cancelled) return;
                    revokeQr();
                    qrUrlRef.current = url;
                    setQrUrl(url);
                }
                window.history.replaceState({}, "", "/membership");
            } catch (err) {
                if (!cancelled) {
                    emitAppToast("error", err instanceof Error ? err.message : "订单加载失败");
                }
            } finally {
                if (!cancelled) setPaying(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [revokeQr]);

    useEffect(() => () => {
        if (qrUrlRef.current) URL.revokeObjectURL(qrUrlRef.current);
    }, []);

    // 待支付订单轮询（退避版）：ALIPAY 扫码后由回调/查单推进，前端按 2.5s→5s→7.5s→10s 退避刷新
    useEffect(() => {
        if (!activeOrder || activeOrder.status !== "CREATED") return;
        let cancelled = false;
        let timer = 0;
        let attempt = 0;
        const tick = async () => {
            try {
                const fresh = await payApi.getOrder(activeOrder.orderNo);
                if (cancelled) return;
                setActiveOrder(fresh);
                if (fresh.status === "DELIVERED") {
                    emitAppToast("success", "开通成功，欢迎加入会员");
                    revokeQr();
                    setPendingSku(null);
                    setActiveOrder(null);
                    void refresh();
                    return;
                }
                if (fresh.status === "CLOSED" || isOrderExpired(fresh)) {
                    emitAppToast("warning", "账单已过期，请重新下单");
                    revokeQr();
                    setPendingSku(null);
                    setActiveOrder(null);
                    void refresh();
                    return;
                }
            } catch {
                // 瞬时错误：继续轮询
            }
            if (cancelled) return;
            attempt += 1;
            timer = window.setTimeout(tick, Math.min(ORDER_POLL_MS * attempt, ORDER_POLL_CAP_MS));
        };
        timer = window.setTimeout(tick, ORDER_POLL_MS);
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [activeOrder, refresh, revokeQr]);

    const startPurchase = useCallback((product: PayProduct) => {
        setActiveOrder(null);
        setChannel(defaultChannel);
        setPendingSku(product);
    }, [defaultChannel]);

    const closeDialog = useCallback(() => {
        if (paying) return;
        revokeQr();
        setPendingSku(null);
        setActiveOrder(null);
    }, [paying, revokeQr]);

    const confirmPurchase = useCallback(async () => {
        if (!pendingSku) return;
        setPaying(true);
        try {
            let orderNo = activeOrder?.orderNo;
            if (!orderNo) {
                const created = await payApi.createOrder({
                    skuCode: pendingSku.code,
                    channel,
                    idempotencyKey: crypto.randomUUID(),
                });
                orderNo = created.orderNo;
                // 升级换购单：弹窗显示实付差价（订单金额），而非 SKU 原价
                setPendingSku(productFromOrder({
                        orderNo: created.orderNo,
                        skuCode: pendingSku.code,
                        productTitle: pendingSku.title,
                        durationDays: pendingSku.durationDays,
                        amountCents: created.amountCents,
                        channel,
                        paidAt: null,
                        createdAt: new Date().toISOString(),
                        status: created.status,
                        expiresAt: created.expiresAt,
                    }));
                setActiveOrder(await payApi.getOrder(orderNo));
            }
            if (channel === "MOCK") {
                // 幂等：重复点击/已支付时 mockConfirm 可能 409，忽略即可
                try {
                    await payApi.mockConfirm(orderNo);
                } catch {
                    /* fall through to status check */
                }
            } else {
                const url = await payApi.orderQrBlobUrl(orderNo);
                revokeQr();
                qrUrlRef.current = url;
                setQrUrl(url);
            }
            // MOCK 同步交付；给交付补偿留一拍
            let final = await payApi.getOrder(orderNo);
            for (let i = 0; i < 4 && final.status === "CREATED"; i += 1) {
                await sleep(700);
                final = await payApi.getOrder(orderNo);
            }
            setActiveOrder(final);
            if (final.status === "DELIVERED") {
                emitAppToast("success", "开通成功，欢迎加入会员");
                revokeQr();
                setPendingSku(null);
                setActiveOrder(null);
                await refresh();
            }
        } catch (err) {
            emitAppToast("error", err instanceof Error ? err.message : "支付失败，请稍后重试");
        } finally {
            setPaying(false);
        }
    }, [pendingSku, activeOrder, channel, revokeQr, refresh]);

    const cancelActiveOrder = useCallback(async () => {
        if (!activeOrder) return;
        try {
            await payApi.cancelOrder(activeOrder.orderNo);
            emitAppToast("success", "订单已取消");
            revokeQr();
            setPendingSku(null);
            setActiveOrder(null);
            await refresh();
        } catch (err) {
            emitAppToast("error", err instanceof Error ? err.message : "取消失败");
        }
    }, [activeOrder, revokeQr, refresh]);

    const currentTier = membership?.active ? (membership.tier ?? "").toUpperCase() : "";
    const currentRank = tierRank(currentTier);
    const hasQuote = (code: string) => upgradeQuotes.some((q) => q.skuCode === code);
    const isBlockedProduct = (p: PayProduct) => {
        const rank = tierRank(targetTierOf(p.code));
        if (currentRank === 0) return rank === 0; // 免费用户可直接购买任意付费档
        return !hasQuote(p.code);
    };
    const selectable = products.filter((p) => !isBlockedProduct(p));
    const selectedProduct =
        products.find((p) => p.code === selectedSku && !isBlockedProduct(p)) ?? selectable[0] ?? null;
    const mockOnly = enabledChannels.length === 1 && enabledChannels[0] === "MOCK";

    return (
        <div className="mx-auto max-w-[1100px] px-6 py-8 sm:px-10">
            {loading ? (
                <p className="mt-8 text-[13px] text-secondary">加载中…</p>
            ) : loadError ? (
                <p className="mt-8 text-[13px] text-danger">{loadError}</p>
            ) : (
                <div className="space-y-8">
                    <MembershipHero membership={membership} />

                    {/* 套餐选择（腾讯开通卡样式） */}
                    <PlanCards
                        products={products}
                        selectedCode={selectedProduct?.code ?? null}
                        currentTier={currentTier}
                        upgradeQuotes={upgradeQuotes}
                        onSelect={setSelectedSku}
                        disabled={paying}
                    />
                    {selectedProduct && (
                        <button
                            type="button"
                            disabled={paying}
                            onClick={() => startPurchase(selectedProduct)}
                            className="btn-pill h-11 w-full bg-gradient-to-r from-amber-300 via-yellow-400 to-amber-300 text-[14px] font-semibold text-zinc-900 shadow-[0_4px_16px_rgba(245,158,11,0.35)] transition-all hover:brightness-105 disabled:opacity-60"
                        >
                            {paying
                                ? "处理中…"
                                : `开通 ${selectedProduct.title}（${targetTierOf(selectedProduct.code)}）`}
                        </button>
                    )}
                    {selectedProduct === null && currentRank > 0 && (
                        <p className="text-center text-[12px] text-tertiary">
                            当前会员有效期内不可重复购买，仅支持向上升级更高档位
                        </p>
                    )}

                    <TierComparison rows={comparison} currentTier={currentTier} tiers={tiers} />

                    <Link
                        href="/orders"
                        className="flex items-center justify-between rounded-2xl border border-border bg-surface px-5 py-4 transition-colors hover:bg-[#fbfbfd]"
                    >
                        <div className="min-w-0">
                            <h2 className="text-[15px] font-semibold text-foreground">订单记录</h2>
                            <p className="mt-1 text-[12px] text-tertiary">
                                查看历史订单、支付状态与分页记录
                            </p>
                        </div>
                        <span className="inline-flex items-center gap-1 text-[12px] font-medium text-accent">
                            查看全部
                            <ChevronRight className="h-3.5 w-3.5" />
                        </span>
                    </Link>

                    {mockOnly && (
                        <p className="flex items-center gap-1.5 text-[11px] text-tertiary">
                            <ShieldCheck className="h-3.5 w-3.5" />
                            当前为测试环境：支付走模拟确认通道，不产生真实扣款。
                        </p>
                    )}
                </div>
            )}

            {pendingSku && (
                <PayDialog
                    product={pendingSku}
                    channel={channel}
                    enabledChannels={enabledChannels}
                    onChannelChange={setChannel}
                    paying={paying}
                    qrUrl={qrUrl}
                    order={activeOrder}
                    onCancel={closeDialog}
                    onConfirm={confirmPurchase}
                    onCancelOrder={cancelActiveOrder}
                />
            )}
        </div>
    );
}

/** 黑金 Hero —— 当前会员状态。 */
function MembershipHero({ membership }: { membership: PayMembership | null }) {
    const tier = membership?.active ? (membership.tier ?? "").toUpperCase() : "";
    const isPaid = tier === "VIP" || tier === "SVIP" || tier === "PROMAX";
    const tierLabel = tier === "PROMAX" ? "ProMax" : tier;
    return (
        <section className="relative overflow-hidden rounded-[20px] bg-gradient-to-br from-zinc-900 via-zinc-900 to-zinc-800 p-7 sm:p-8">
            <div className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-amber-400/10 blur-3xl" />
            <div className="pointer-events-none absolute -bottom-20 right-24 h-40 w-40 rounded-full bg-amber-500/5 blur-2xl" />
            <div className="relative flex items-center justify-between">
                <div>
                    <div className="flex items-center gap-2.5">
                        <Crown className={cn("h-5 w-5", isPaid ? "text-amber-400" : "text-zinc-600")} />
                        <p className="text-[13px] font-medium tracking-wide text-zinc-400">MindBase 会员</p>
                    </div>
                    {isPaid ? (
                        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                            <span className="bg-gradient-to-r from-amber-200 via-yellow-400 to-amber-200 bg-clip-text text-[26px] font-semibold tracking-tight text-transparent">
                                {tierLabel} 会员
                            </span>
                            {membership?.expireAt && (
                                <span className="text-[12px] text-zinc-400">
                                    {new Date(membership.expireAt).toLocaleDateString()} 到期
                                </span>
                            )}
                        </div>
                    ) : (
                        <p className="mt-2.5 text-[22px] font-semibold tracking-tight text-zinc-100">
                            未开通会员
                        </p>
                    )}
                    {!isPaid && (
                        <p className="mt-1 text-[12px] text-zinc-500">选择下方套餐，开通后配额与权益立即生效</p>
                    )}
                </div>
                {membership?.active && membership.autoRenew && (
                    <span className="rounded-full border border-amber-400/30 px-2.5 py-1 text-[11px] text-amber-300">
                        自动续费中
                    </span>
                )}
            </div>
        </section>
    );
}

/** 套餐选择卡 —— 横排可选卡，金色选中环；月均价最低的档位标「最划算」。 */
function PlanCards({
    products,
    selectedCode,
    currentTier,
    upgradeQuotes,
    onSelect,
    disabled,
}: {
    products: PayProduct[];
    selectedCode: string | null;
    currentTier: string;
    upgradeQuotes: PayUpgradeQuote[];
    onSelect: (code: string) => void;
    disabled: boolean;
}) {
    if (products.length === 0) return null;
    const monthly = (p: PayProduct) => p.priceCents / Math.max(1, p.durationDays) * 30;
    const bestCode = products.reduce(
        (best, p) => (monthly(p) < monthly(best) ? p : best),
        products[0]
    ).code;
    const targetTier = (code: string) => targetTierOf(code);
    // 会员页的 Credits 权益提示按当前 SKU 价格推导（默认 VIP_MONTHLY = ¥48 → ¥480 等值）
    const vipProduct = products.find((p) => p.code === "VIP_MONTHLY");
    const vipYuanLabelNum = vipProduct ? vipProduct.priceCents / 100 : 48;
    const vipYuanLabel = Number.isInteger(vipYuanLabelNum)
        ? String(vipYuanLabelNum)
        : vipYuanLabelNum.toFixed(2);
    const vipValueYuan = vipYuanLabelNum * 10;
    const vipValueLabel = Number.isInteger(vipValueYuan) ? String(vipValueYuan) : vipValueYuan.toFixed(2);
    const currentRank = tierRank(currentTier);
    // 升级换购报价（同档补差价）：skuCode → quote；有报价的同档 SKU 可选（补差价升级）
    const quoteFor = (code: string) => upgradeQuotes.find((q) => q.skuCode === code);
    const isBlocked = (p: PayProduct) => {
        if (currentRank === 0) return false; // 免费用户可直接购买任意付费档
        const rank = tierRank(targetTier(p.code));
        // 会员有效期内：同档/跨档都必须有服务端报价才可买；跨档没有报价
        // 说明剩余时长超过该 SKU 周期，不能按短周期全价叠加。
        if (rank >= currentRank) return !quoteFor(p.code);
        return true; // 降档
    };
    return (
        <section>
            <div className="flex flex-wrap items-baseline gap-2">
                <h2 className="text-[16px] font-semibold text-foreground">选择套餐</h2>
                <span className="text-[12px] text-tertiary">
                    AI 额度按 Credits 计量 · VIP ¥{vipYuanLabel} 档约 ¥{vipValueLabel} 等值（10×）· 不同模型按单价抵扣
                </span>
            </div>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                {products.map((p) => {
                    const quote = quoteFor(p.code);
                    const on = p.code === (selectedCode ?? products[0]?.code) && !isBlocked(p);
                    const best = p.code === bestCode && !isBlocked(p);
                    const blocked = isBlocked(p);
                    const rank = tierRank(targetTier(p.code));
                    const sameTier = rank === currentRank;
                    const higherTier = rank > currentRank;
                    const payableCents = quote ? quote.amountCents : p.priceCents;
                    return (
                        <button
                            key={p.code}
                            type="button"
                            disabled={disabled || blocked}
                            onClick={() => onSelect(p.code)}
                            className={cn(
                                "relative rounded-2xl bg-surface p-5 text-left transition-all",
                                "disabled:opacity-55 disabled:pointer-events-none",
                                blocked
                                    ? "ring-1 ring-border-subtle"
                                    : on
                                      ? "ring-2 ring-amber-400 shadow-[0_4px_16px_rgba(245,158,11,0.25)]"
                                      : "ring-1 ring-border hover:ring-border/70",
                                CARD_SHADOW
                            )}
                        >
                            {best && (
                                <span className="absolute -top-2.5 left-4 rounded-full bg-zinc-900 px-2 py-0.5 text-[10px] font-medium text-amber-300">
                                    最划算
                                </span>
                            )}
                            <div className="flex items-center justify-between">
                                <p className={cn("text-[13px]", blocked ? "text-tertiary" : "text-secondary")}>{p.title}</p>
                                {blocked || quote ? (
                                    <span className={cn("rounded-full px-1.5 py-0.5 text-[10px]",
                                        quote
                                            ? "bg-amber-400/15 text-amber-600"
                                            : "bg-border-subtle text-tertiary")}>
                                        {quote
                                            ? `补差价升级 ¥${formatYuan(quote.amountCents)}`
                                            : sameTier
                                                ? "当前档位"
                                                : higherTier
                                                    ? "剩余时长超过该套餐"
                                                    : "档位不高于现有"}
                                    </span>
                                ) : null}
                            </div>
                            <p className="mt-1.5 text-[24px] font-semibold tracking-tight text-foreground">
                                <span className="text-[14px] font-normal text-secondary">¥</span>
                                {formatYuan(payableCents)}
                            </p>
                            <p className="mt-1 text-[11px] text-tertiary">
                                {quote
                                    ? quote.durationDays > 0
                                        ? `补差价升级 · 延长 ${quote.durationDays} 天至 ${quote.newExpireAt}（原价 ¥${formatYuan(p.priceCents)}）`
                                        : `补差价升级 · 剩余时长直接升档（原价 ¥${formatYuan(p.priceCents)}）`
                                    : `${p.durationDays} 天 · 折合 ¥${formatYuan(monthly(p))}/月`}
                            </p>
                            {on && (
                                <span className="absolute bottom-4 right-4 grid h-5 w-5 place-items-center rounded-full bg-amber-400 text-zinc-900">
                                    <Check className="h-3 w-3" strokeWidth={3} />
                                </span>
                            )}
                        </button>
                    );
                })}
            </div>
        </section>
    );
}

/** 权益对照表（数据来自 /pay/comparison，Java 侧维护）。 */
function TierComparison({
    rows,
    currentTier,
    tiers,
}: {
    rows: PayComparisonRow[];
    currentTier: string;
    tiers: PayTierInfo[];
}) {
    if (rows.length === 0) return null;
    const cols: { key: "free" | "vip" | "svip" | "promax"; tier: string }[] = [
        { key: "free", tier: "FREE" },
        { key: "vip", tier: "VIP" },
        { key: "svip", tier: "SVIP" },
        { key: "promax", tier: "PROMAX" },
    ];
    const nameOf = (tier: string) => tiers.find((t) => t.tier === tier)?.name ?? tier;
    return (
        <section>
            <h2 className="text-[16px] font-semibold text-foreground">权益对照</h2>
            {/* 手机端 4 列表格可横向滑动，避免列挤压 */}
            <div className={cn("mt-3 overflow-x-auto rounded-2xl border border-border bg-surface", CARD_SHADOW)}>
                <table className="w-full text-[12px]">
                    <thead>
                        <tr className="border-b border-border text-left text-tertiary">
                            <th className="px-4 py-2.5 font-medium">权益</th>
                            {cols.map((c) => (
                                <th
                                    key={c.key}
                                    className={cn(
                                        "px-4 py-2.5 text-center font-medium",
                                        c.tier === currentTier && "bg-amber-400/5 text-amber-700"
                                    )}
                                >
                                    {nameOf(c.tier)}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((r) => (
                            <tr key={r.feature} className="border-b border-border-subtle last:border-0">
                                <td className="px-4 py-2.5 text-foreground">{r.feature}</td>
                                {cols.map((c) => {
                                    const v = r[c.key];
                                    const check = v === "✓";
                                    const dash = v === "—";
                                    return (
                                        <td
                                            key={c.key}
                                            className={cn(
                                                "px-4 py-2.5 text-center",
                                                c.tier === currentTier && "bg-amber-400/5",
                                                check && "text-success",
                                                dash && "text-tertiary",
                                                !check && !dash && "text-foreground"
                                            )}
                                        >
                                            {v}
                                        </td>
                                    );
                                })}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </section>
    );
}

function PayDialog({
    product,
    channel,
    enabledChannels,
    onChannelChange,
    paying,
    qrUrl,
    order,
    onCancel,
    onConfirm,
    onCancelOrder,
}: {
    product: PayProduct;
    channel: PayChannel;
    enabledChannels: PayChannel[];
    onChannelChange: (c: PayChannel) => void;
    paying: boolean;
    qrUrl: string | null;
    order: PayOrder | null;
    onCancel: () => void;
    onConfirm: () => void;
    onCancelOrder: () => void;
}) {
    const waiting = order?.status === "CREATED";
    const isMock = channel === "MOCK";
    return (
        <div className="fixed inset-0 z-[60] grid place-items-center bg-black/40 px-4" role="dialog" aria-modal="true">
            <div className={cn("w-full max-w-sm rounded-2xl border border-border bg-surface p-6", CARD_SHADOW)}>
                <h3 className="text-[16px] font-semibold text-foreground">
                    {waiting && !isMock ? "扫码支付" : "确认购买"}
                </h3>
                <div className="mt-4 rounded-xl bg-border-subtle/50 p-4 text-[13px]">
                    <div className="flex items-center justify-between">
                        <span className="text-secondary">商品</span>
                        <span className="font-medium text-foreground">{product.title}</span>
                    </div>
                    <div className="mt-2 flex items-center justify-between">
                        <span className="text-secondary">金额</span>
                        <span className="text-[18px] font-semibold text-foreground">
                            ¥{formatYuan(product.priceCents)}
                        </span>
                    </div>
                </div>

                {enabledChannels.length > 1 && !waiting && (
                    <div className="mt-4">
                        <p className="text-[12px] text-secondary">支付方式</p>
                        <div className="mt-2 flex gap-2">
                            {enabledChannels.map((c) => (
                                <button
                                    key={c}
                                    type="button"
                                    onClick={() => onChannelChange(c)}
                                    className={cn(
                                        "rounded-lg px-3 py-1.5 text-[12px] ring-1 transition-colors",
                                        c === channel
                                            ? "bg-foreground text-surface ring-foreground"
                                            : "text-foreground ring-border hover:bg-border-subtle"
                                    )}
                                >
                                    {c === "ALIPAY" ? "支付宝" : c === "MOCK" ? "模拟支付" : c}
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                {waiting && !isMock && qrUrl && (
                    <div className="mt-4 flex flex-col items-center gap-2">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={qrUrl} alt="支付宝收款二维码" className="h-48 w-48 rounded-lg bg-white p-1" />
                        <p className="text-[11px] text-tertiary">请用支付宝扫码支付，支付后自动开通</p>
                    </div>
                )}

                {isMock && (
                    <p className="mt-3 flex items-start gap-1.5 rounded-lg bg-amber-50 p-2.5 text-[11px] leading-relaxed text-amber-800">
                        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        测试环境：点击下方按钮即完成模拟支付，不产生真实扣款。
                    </p>
                )}

                {order && (
                    <p className="mt-3 text-[11px] text-tertiary">
                        订单号 {order.orderNo} · {STATUS_LABEL[order.status] ?? order.status}
                    </p>
                )}

                <div className="mt-5 flex justify-end gap-2">
                    <button
                        type="button"
                        onClick={onCancel}
                        disabled={paying}
                        className="btn-pill h-8 px-4 text-[12px] text-foreground ring-1 ring-border hover:bg-border-subtle disabled:opacity-60"
                    >
                        {waiting ? "收起" : "取消"}
                    </button>
                    {waiting && order && (
                        <button
                            type="button"
                            onClick={onCancelOrder}
                            disabled={paying}
                            className="btn-pill h-8 px-4 text-[12px] text-foreground ring-1 ring-border hover:bg-border-subtle disabled:opacity-60"
                        >
                            取消订单
                        </button>
                    )}
                    {(!waiting || isMock) && (
                        <button
                            type="button"
                            onClick={onConfirm}
                            disabled={paying}
                            className="btn-pill h-8 bg-gradient-to-r from-amber-300 to-yellow-400 px-4 text-[12px] font-semibold text-zinc-900 transition-all hover:brightness-105 disabled:opacity-60"
                        >
                            {paying ? "处理中…" : isMock ? "模拟支付" : "生成收款码"}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
