// 支付运营域 API：类型 + 端点封装。
// 约定：uid 一律以 string 表示（bigint 精度安全，勿做数值运算）；金额一律整数分；
// 时间输出 RFC3339（展示统一走 components/format.ts 的 formatTime）。
import { post, qs, request } from "./client";
import type { Paged } from "./types";

/** GET /api/pay/orders 的列表项（订单快照，金额整数分）。 */
export interface PayOrderItem {
  orderNo: string;
  uid: string;
  skuCode: string;
  productTitle: string;
  durationDays: number;
  amountCents: number;
  channel: string;
  status: string;
  version: number;
  channelTradeNo: string | null;
  idempotencyKey: string | null;
  failReason: string | null;
  expiresAt: string;
  paidAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 订单渠道回调流水（脱敏报文）。 */
export interface PayCallbackItem {
  orderNo: string;
  channel: string;
  payloadMasked: string | null;
  signatureResult: string;
  handleResult: string;
  message: string | null;
  createdAt: string;
}

/** 会员态（active = expireAt > now，由后端判定）。 */
export interface PayMembershipItem {
  uid: string;
  tier: string;
  active: boolean;
  expireAt: string;
  autoRenew: boolean;
  lastOrderNo: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 权益变更事件（pay_membership_event）。 */
export interface PayMembershipEventItem {
  id: number;
  uid: string;
  type: string;
  orderNo: string | null;
  days: number;
  expireBefore: string;
  expireAfter: string;
  reason: string | null;
  createdAt: string;
}

/** SKU 目录（只读）。 */
export interface PayProductItem {
  code: string;
  title: string;
  durationDays: number;
  priceCents: number;
  status: string;
  sort: number;
  createdAt: string;
  updatedAt: string;
}

/** 补偿开通请求（uid 允许 number|string，后端按 bigint 解析）。 */
export interface PayGrantRequest {
  uid: number | string;
  durationDays: number;
  reason: string;
  tier?: "VIP" | "SVIP";
}

/** 补偿开通结果（expireBefore/After 为变更前后到期时间）。 */
export interface PayGrantResult {
  uid: string;
  tier: string;
  days: number;
  expireBefore: string;
  expireAfter: string;
  created: boolean;
  active: boolean;
}

export type RefundApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "ALL";

/** 退款双人复核审批单（pay_refund_approval，只读）。 */
export interface PayRefundApprovalItem {
  orderNo: string;
  maker: string;
  makerReason: string;
  status: string;
  createdAt: string;
  decidedAt: string | null;
  checker: string | null;
  checkReason: string | null;
}

/** 退款复核执行结果（资金写经 app-pay internal 端点，成功后回显复核人）。 */
export interface PayRefundActionResult {
  ok: boolean;
  orderNo: string;
  confirmed?: boolean;
  checker?: string;
}

export type PayOrderQuery = {
  uid?: string;
  status?: string;
  channel?: string;
  sku?: string;
  orderNo?: string;
  tradeNo?: string;
  /** YYYY-MM-DD（后端按 Asia/Shanghai 解析）或 RFC3339 */
  createdFrom?: string;
  createdTo?: string;
  page?: number;
  pageSize?: number;
};

export type PayEventQuery = {
  uid?: string;
  type?: string;
  page?: number;
  pageSize?: number;
};

export type PayRefundQuery = {
  status?: RefundApprovalStatus;
  page?: number;
  pageSize?: number;
};

const enc = encodeURIComponent;

/** 支付运营端点封装：组件禁止直接 fetch。 */
export const payApi = {
  /** 订单列表（ORDER BY id DESC；支持订单号/UID/交易号/状态/渠道/创建时间范围） */
  orders: (params: PayOrderQuery) => request<Paged<PayOrderItem>>(`/api/pay/orders${qs({ ...params })}`),

  /** 订单详情：orderNo 查不到时后端用 tradeNo 兜底 */
  order: (orderNo: string, tradeNo?: string) =>
    request<{ order: PayOrderItem }>(`/api/pay/orders/${enc(orderNo)}${qs({ tradeNo })}`),

  /** 订单渠道回调流水 */
  orderCallbacks: (orderNo: string, params: { page?: number; pageSize?: number }) =>
    request<Paged<PayCallbackItem>>(`/api/pay/orders/${enc(orderNo)}/callbacks${qs({ ...params })}`),

  /** 单个会员态：无记录返回 { membership: null }（不是 404） */
  membership: (uid: string) =>
    request<{ membership: PayMembershipItem | null }>(`/api/pay/memberships${qs({ uid })}`),

  /** 会员全量分页列表 */
  memberships: (params: { page?: number; pageSize?: number }) =>
    request<Paged<PayMembershipItem>>(`/api/pay/memberships${qs({ ...params })}`),

  /** 单人权益事件流 */
  memberEvents: (uid: string, params: { page?: number; pageSize?: number }) =>
    request<Paged<PayMembershipEventItem>>(
      `/api/pay/memberships/${enc(uid)}/events${qs({ ...params })}`,
    ),

  /** 全局权益事件流（uid/type 筛选） */
  events: (params: PayEventQuery) =>
    request<Paged<PayMembershipEventItem>>(`/api/pay/events${qs({ ...params })}`),

  /** SKU 目录（sort ASC, id ASC；只读） */
  products: () => request<{ items: PayProductItem[] }>("/api/pay/products"),

  /** 运营补偿开通（admin；日额度超限 429） */
  grant: (body: PayGrantRequest) => post<PayGrantResult>("/api/pay/grants", body),

  /** 退款复核列表（未配置退款复核时后端整组 404） */
  refunds: (params: PayRefundQuery) =>
    request<Paged<PayRefundApprovalItem>>(`/api/pay/refunds${qs({ ...params })}`),

  /** 退款复核通过（经 app-pay internal 端点执行，非本控制台直写） */
  approveRefund: (orderNo: string, reason?: string) =>
    post<PayRefundActionResult>(`/api/pay/refunds/${enc(orderNo)}/approve`, {
      reason: reason?.trim() || undefined,
    }),

  /** 退款复核驳回 */
  rejectRefund: (orderNo: string, reason?: string) =>
    post<PayRefundActionResult>(`/api/pay/refunds/${enc(orderNo)}/reject`, {
      reason: reason?.trim() || undefined,
    }),
};

// —— 跨任务约定（Lead 冻结）：pay-ui-ops 的 Grants.tsx / Refunds.tsx 直接 import 这些命名导出 ——

/** 补偿开通结果（同 PayGrantResult）。 */
export type GrantResult = PayGrantResult;

/** 退款复核审批单（同 PayRefundApprovalItem）。 */
export type RefundItem = PayRefundApprovalItem;

/** POST /api/pay/grants —— 运营补偿开通（admin，资金写）。 */
export function grantMembership(body: PayGrantRequest): Promise<GrantResult> {
  return payApi.grant(body);
}

/** GET /api/pay/events —— 全局权益事件流（Grants 页「最近 ADMIN_GRANT」也用这个）。 */
export function listEvents(params: PayEventQuery): Promise<Paged<PayMembershipEventItem>> {
  return payApi.events(params);
}

/** GET /api/pay/refunds —— 退款复核审批单分页列表（未配置时后端 404）。 */
export function listRefunds(params: PayRefundQuery): Promise<Paged<RefundItem>> {
  return payApi.refunds(params);
}

/** POST /api/pay/refunds/:orderNo/approve —— 复核通过（body 非空 reason 时才带 reason）。 */
export function approveRefund(orderNo: string, reason?: string): Promise<PayRefundActionResult> {
  return payApi.approveRefund(orderNo, reason);
}

/** POST /api/pay/refunds/:orderNo/reject —— 复核驳回（body {}）。 */
export function rejectRefund(orderNo: string): Promise<PayRefundActionResult> {
  return payApi.rejectRefund(orderNo);
}
