// 支付运营域的展示元数据（状态/渠道/事件类型的中文标签与颜色）。
// 只做展示映射，不参与请求；未知值一律原样兜底。

export const ORDER_STATUS_META: Record<string, { label: string; color: string }> = {
  CREATED: { label: "待支付", color: "gold" },
  PAID: { label: "已支付", color: "blue" },
  DELIVERED: { label: "已交付", color: "green" },
  CLOSED: { label: "已关闭", color: "default" },
  REFUNDING: { label: "退款中", color: "orange" },
  REFUNDED: { label: "已退款", color: "red" },
};

export const ORDER_STATUS_OPTIONS = Object.entries(ORDER_STATUS_META).map(([value, meta]) => ({
  value,
  label: meta.label,
}));

export const CHANNEL_LABEL: Record<string, string> = {
  ALIPAY: "支付宝",
  WECHAT: "微信",
  MOCK: "模拟",
};

export const CHANNEL_OPTIONS = Object.entries(CHANNEL_LABEL).map(([value, label]) => ({
  value,
  label,
}));

export const EVENT_TYPE_META: Record<string, { label: string; color: string }> = {
  ACTIVATE: { label: "开通", color: "green" },
  RENEW: { label: "续费", color: "blue" },
  ADMIN_GRANT: { label: "运营补偿", color: "volcano" },
  REFUND_REVOKE: { label: "退款回收", color: "red" },
  TIER_DOWNGRADE_BLOCKED: { label: "档位降级拦截", color: "orange" },
};

export const EVENT_TYPE_OPTIONS = Object.entries(EVENT_TYPE_META).map(([value, meta]) => ({
  value,
  label: meta.label,
}));

export const TIER_META: Record<string, { label: string; color: string }> = {
  VIP: { label: "VIP", color: "gold" },
  SVIP: { label: "SVIP", color: "purple" },
};

export const REFUND_STATUS_META: Record<string, { label: string; color: string }> = {
  PENDING: { label: "待复核", color: "gold" },
  APPROVED: { label: "已通过", color: "green" },
  REJECTED: { label: "已驳回", color: "red" },
};

export const REFUND_STATUS_OPTIONS = [
  { value: "ALL", label: "全部状态" },
  ...Object.entries(REFUND_STATUS_META).map(([value, meta]) => ({ value, label: meta.label })),
];
