package com.mindbase.pay.model;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Getter;
import lombok.Setter;

import java.time.LocalDateTime;

/**
 * 订单状态机（plan/1.0.7-Pay §4）：
 * CREATED -> PAID -> DELIVERED；CREATED -> CLOSED；M4 预留 REFUNDING/REFUNDED。
 * 状态流转一律走 PayOrderMapper 的条件更新（WHERE status=...），禁止读改写。
 */
@Getter
@Setter
@TableName("pay_order")
public class PayOrder {

    public enum OrderStatus {CREATED, PAID, DELIVERED, CLOSED, REFUNDING, REFUNDED}

    public enum PayChannel {MOCK, WECHAT_PAY, ALIPAY}

    @TableId(type = IdType.AUTO)
    private Long id;

    private String orderNo;

    private long uid;

    // 快照字段：SKU 后续改价改期不影响历史订单
    private String skuCode;

    private String productTitle;

    private int durationDays;

    private long amountCents;

    private PayChannel channel;

    private OrderStatus status = OrderStatus.CREATED;

    /**
     * 乐观锁版本：创建=1，每次状态迁移由条件更新 SQL 原子自增。
     * app-task 超时委托携带注册时的版本，executor 执行时版本不匹配 = 订单已被支付等更新，委托作废。
     */
    private int version = 1;

    private String channelTradeNo;

    private String idempotencyKey;

    private String failReason;

    private LocalDateTime expiresAt;

    private LocalDateTime paidAt;

    private LocalDateTime closedAt;

    private LocalDateTime createdAt = com.mindbase.pay.common.PayTime.now();

    private LocalDateTime updatedAt = com.mindbase.pay.common.PayTime.now();
}
