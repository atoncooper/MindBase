/**
 * Pay API - 会员/支付：商品目录 / 下单 / 订单查询 / 会员态 / M1 模拟支付.
 *
 * Backend: app-pay (Java, §2.8). All user endpoints live under /pay/* and are
 * routed through APISIX with bili_session Bearer auth; the caller does NOT
 * pass uid - identity comes from the gateway-injected X-Uid.
 *
 * Java records serialize with camelCase field names natively (priceCents,
 * durationDays, expireAt) - no snake_case conversion needed. All money values
 * are long 分 (cents); formatting to 元 happens only in the view layer.
 */

import { API_BASE_URL, getAuthHeaders, request } from "./client";

export type PayChannel = "MOCK" | "WECHAT_PAY" | "ALIPAY";

/** Backend-reported channel availability — the UI must not hardcode MOCK. */
export interface PayChannelInfo {
    code: PayChannel;
    enabled: boolean;
}

export type OrderStatus =
    | "CREATED"
    | "PAID"
    | "DELIVERED"
    | "CLOSED"
    | "REFUNDING" // M4-reserved
    | "REFUNDED"; // M4-reserved

export interface PayProduct {
    code: string;            // e.g. VIP_MONTHLY / SVIP_YEARLY
    title: string;           // e.g. 会员·月度
    durationDays: number;
    priceCents: number;      // long 分 - never a float
    status: string;
}

export interface PayParams {
    type: string;            // "mock" | "alipay_qr" | (M2.5) "wechat_native"
    orderNo?: string;
    confirmEndpoint?: string; // MOCK only
    qrCode?: string;          // ALIPAY only — raw alipay QR payload
    [key: string]: unknown;  // other channels carry their own pay params
}

export interface CreateOrderRequest {
    skuCode: string;
    channel: PayChannel;
    /** optional client idempotency key (max 64) — a uuid per purchase intent */
    idempotencyKey?: string;
}

export interface CreateOrderResponse {
    orderNo: string;
    status: OrderStatus;
    amountCents: number;
    expiresAt: string | null;
    payParams: PayParams | null;
}

export interface PayOrder {
    orderNo: string;
    skuCode: string;
    productTitle: string;
    durationDays: number;
    amountCents: number;
    channel: PayChannel;
    status: OrderStatus;
    paidAt: string | null;
    expiresAt: string | null;
    createdAt: string;
    /** 渠道交易号（支付确认后存在） */
    channelTradeNo?: string | null;
    /** 付款账户（买家支付宝登录号，支付确认后存在） */
    buyerLogonId?: string | null;
    /** 买家支付宝 userId */
    buyerUserId?: string | null;
}

export interface PayMembership {
    /** "VIP" | "SVIP" | null (null = no membership row) */
    tier: string | null;
    /** lazy expiry: expireAt > now */
    active: boolean;
    expireAt: string | null;
    autoRenew: boolean;
}

/** 会员档位简介（权益文案由 app-pay Java 侧 TierCatalog 维护，markdown 为完整介绍）。 */
export interface PayTierInfo {
    tier: string;
    name: string;
    tagline: string;
    benefits: string[];
    markdown: string;
}

/** 权益对照表行（feature = 能力名，三列 = 各档位权益）。 */
export interface PayComparisonRow {
    feature: string;
    free: string;
    vip: string;
    svip: string;
}

/** Auth-required QR image path (fetched as a blob; <img src> cannot carry the Bearer header). */
function orderQrPath(orderNo: string): string {
    return `/pay/orders/${encodeURIComponent(orderNo)}/qr`;
}

export const payApi = {
    /** 在售 SKU 目录 */
    products(): Promise<PayProduct[]> {
        return request<PayProduct[]>("/pay/products");
    },

    /** 当前可用的支付渠道（MOCK 仅测试环境；ALIPAY 生产） */
    channels(): Promise<PayChannelInfo[]> {
        return request<PayChannelInfo[]>("/pay/channels");
    },

    /** 我的订单（新→旧） */
    listOrders(limit = 20): Promise<PayOrder[]> {
        return request<PayOrder[]>(`/pay/orders?limit=${limit}`);
    },

    /** 取消未支付订单 */
    cancelOrder(orderNo: string): Promise<PayOrder> {
        return request<PayOrder>(`/pay/orders/${encodeURIComponent(orderNo)}/cancel`, {
            method: "POST",
        });
    },

    /**
     * 待支付订单的收款二维码：网关鉴权需要 Authorization 头，<img src> 无法携带，
     * 因此用 fetch 取 blob 再生成 object URL（调用方负责 revokeObjectURL）。
     * 沙箱网关（openapi-sandbox.dl.alipaydev.com）间歇性 404，固定重试 3 次缓解。
     */
    async orderQrBlobUrl(orderNo: string): Promise<string> {
        let lastErr: unknown = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                const res = await fetch(`${API_BASE_URL}${orderQrPath(orderNo)}`, {
                    headers: { ...getAuthHeaders() },
                });
                if (!res.ok) {
                    throw new Error(`二维码获取失败（${res.status}）`);
                }
                return URL.createObjectURL(await res.blob());
            } catch (err) {
                lastErr = err;
                if (attempt < 2) {
                    await new Promise((r) => setTimeout(r, 900));
                }
            }
        }
        throw lastErr instanceof Error ? lastErr : new Error("二维码获取失败");
    },

    /** 创建订单（M1 仅 channel="MOCK"；支持幂等键，重复提交返回同一订单） */
    createOrder(body: CreateOrderRequest): Promise<CreateOrderResponse> {
        return request<CreateOrderResponse>("/pay/orders", {
            method: "POST",
            body: JSON.stringify(body),
        });
    },

    /** 订单详情（归属校验，非本人 404） */
    getOrder(orderNo: string): Promise<PayOrder> {
        return request<PayOrder>(`/pay/orders/${encodeURIComponent(orderNo)}`);
    },

    /** 当前登录用户的会员态（无会员行 = active:false，不报错） */
    getMembership(): Promise<PayMembership> {
        return request<PayMembership>("/pay/membership");
    },

    /** 会员档位简介目录（FREE/VIP/SVIP 权益文案，Java 侧维护）。 */
    tiers(): Promise<PayTierInfo[]> {
        return request<PayTierInfo[]>("/pay/tiers");
    },

    /** 权益对照表（行 = 能力，列 = 免费/VIP/SVIP）。 */
    comparison(): Promise<PayComparisonRow[]> {
        return request<PayComparisonRow[]>("/pay/comparison");
    },

    /** M1 限定：模拟支付成功（走完整的 PAID → DELIVERED 交付链路） */
    mockConfirm(orderNo: string): Promise<PayOrder> {
        return request<PayOrder>("/pay/mock/confirm", {
            method: "POST",
            body: JSON.stringify({ orderNo }),
        });
    },
};

/** 分 → 元展示字符串（仅展示层格式化；金额计算永远用分）。 */
export function formatYuan(cents: number): string {
    return (cents / 100).toFixed(2).replace(/\.00$/, "");
}
