package com.mindbase.pay.model;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Getter;
import lombok.Setter;

import java.time.LocalDateTime;

/**
 * Order state machine (plan/1.0.7-Pay §4):
 * CREATED -> PAID -> DELIVERED; CREATED -> CLOSED; M4 reserves REFUNDING/REFUNDED;
 * REFUND_HOLD = tier-violation freeze (duplicate-purchase auto-refund failed; delivery compensation jobs
 * skip this state so the freeze is real, ops replay the refund endpoint to resume).
 * All state transitions go through conditional updates in PayOrderMapper (WHERE status=...); read-modify-write is forbidden.
 */
@Getter
@Setter
@TableName("pay_order")
public class PayOrder {

    public enum OrderStatus {CREATED, PAID, DELIVERED, CLOSED, REFUNDING, REFUNDED, REFUND_HOLD}

    public enum PayChannel {MOCK, WECHAT_PAY, ALIPAY}

    @TableId(type = IdType.AUTO)
    private Long id;

    private String orderNo;

    private long uid;

    // Snapshot field: later SKU price/duration changes do not affect historical orders
    private String skuCode;

    private String productTitle;

    private int durationDays;

    private long amountCents;

    private PayChannel channel;

    private OrderStatus status = OrderStatus.CREATED;

    /**
     * Optimistic-lock version: 1 on creation, atomically incremented by the conditional-update SQL on each state transition.
     * The app-task timeout delegation carries the version from registration time; if the version no longer matches when the executor runs, the order was updated (e.g. paid) and the delegation is void.
     */
    private int version = 1;

    private String channelTradeNo;

    /** 付款账户（买家支付宝登录号，查单/异步通知下发后落库，订单详情展示）。 */
    private String buyerLogonId;

    /** 买家支付宝 userId，与登录号一并展示用于核对。 */
    private String buyerUserId;

    private String idempotencyKey;

    private String failReason;

    /** Tier snapshot (copied from the SKU at order time): delivery grants based on this, and later SKU tier changes do not affect historical orders. */
    private String tier;

    /** Status before refund (PAID|DELIVERED): rollback target when the channel refund fails, preventing accidental delivery compensation. */
    private String refundPrevStatus;

    /** Channel refund number/request number (for idempotency and reconciliation). */
    private String refundNo;

    /** 升级换购基准订单（同档/升档补差价升级时的会员 last_order_no）；null = 普通新购。
     *  升级单金额 = 新 SKU 价 − 基准单价，交付天数 = 新 SKU 天数 − 基准单天数（顺延交付）。
     *  档位墙（第二道）对升级单豁免。
     */
    private String upgradeFromOrderNo;

    private String refundReason;

    private LocalDateTime refundedAt;

    private LocalDateTime expiresAt;

    private LocalDateTime paidAt;

    private LocalDateTime closedAt;

    private LocalDateTime createdAt = com.mindbase.pay.common.PayTime.now();

    private LocalDateTime updatedAt = com.mindbase.pay.common.PayTime.now();
}
