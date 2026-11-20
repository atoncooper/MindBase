package com.mindbase.pay.scheduler;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.mindbase.pay.common.PayAuditLogger;
import com.mindbase.pay.common.PayMetrics;
import com.mindbase.pay.common.TraceIdFilter;
import com.mindbase.pay.config.PayProperties;
import com.mindbase.pay.mapper.PayOrderMapper;
import com.mindbase.pay.model.PayOrder;
import com.mindbase.pay.service.DeliveryService;
import com.mindbase.pay.service.PaymentService;
import com.mindbase.pay.service.RefundService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.slf4j.MDC;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.LocalDateTime;
import java.util.UUID;

/**
 * Delivery compensation: PAID stuck for more than 1 minute (the normal callback path would have delivered long ago) -> retry delivery.
 * Races with concurrent delivery are handled by the markDelivered conditional update, so a double run will not extend membership twice.
 *
 * <p>P1 加固：
 * <ul>
 *   <li>按 last_checked_at 轮转（V7），毒丸订单不再永久占据队头、饿死后续 PAID 订单；</li>
 *   <li>delivery_attempts 上限：连续失败达到上限后停止自动重试并审计/告警，避免无意义重试风暴；</li>
 *   <li>交付结果 TIER_BLOCKED（重复购买/降档）统一走原路退款，不再依赖回调是否到达。</li>
 * </ul>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class DeliveryRetryJob implements AdaptiveJob {

    /** 交付补偿最大尝试次数（超过后不再自动重试，转审计/人工）。 */
    private static final int MAX_DELIVERY_ATTEMPTS = 10;

    private final PayOrderMapper orderMapper;
    private final DeliveryService deliveryService;
    private final RefundService refundService;
    private final JobLease lease;
    private final PayAuditLogger audit;
    private final PayMetrics metrics;
    private final PayProperties props;
    private final Clock clock;
    private volatile boolean lastHadWork;

    @Override
    public void run() {
        MDC.put(TraceIdFilter.TRACE_ID, "job-retry-" + UUID.randomUUID().toString().substring(0, 8));
        try {
            if (!lease.tryAcquire("delivery-retry")) {
                lastHadWork = false;
                return;
            }
            LocalDateTime now = LocalDateTime.now(clock);
            // 公平调度：last_checked_at 升序（NULL 优先），失败也推进，避免毒丸订单占住窗口
            var stuck = orderMapper.selectList(new LambdaQueryWrapper<PayOrder>()
                    .eq(PayOrder::getStatus, PayOrder.OrderStatus.PAID)
                    .lt(PayOrder::getPaidAt, now.minusMinutes(1))
                    .lt(PayOrder::getDeliveryAttempts, MAX_DELIVERY_ATTEMPTS)
                    .orderByAsc(PayOrder::getLastCheckedAt)
                    .orderByAsc(PayOrder::getPaidAt)
                    .last("LIMIT " + Math.max(1, props.job().scanLimit())));
            lastHadWork = !stuck.isEmpty();
            for (PayOrder order : stuck) {
                retryOne(order, now);
            }
        } finally {
            metrics.jobRan("delivery-retry");
            MDC.clear();
        }
    }

    private void retryOne(PayOrder order, LocalDateTime now) {
        try {
            DeliveryService.DeliveryResult result = deliveryService.deliverOrder(order);
            orderMapper.touchChecked(order.getOrderNo(), now);
            if (result == DeliveryService.DeliveryResult.TIER_BLOCKED) {
                // 第二道墙命中：订单已冻结为 REFUND_HOLD，补偿路径同样触发自动退款
                log.warn("[PAY] delivery_retry_tier_blocked order_no={}", order.getOrderNo());
                try {
                    refundService.refund(order.getOrderNo(),
                            PaymentService.DUPLICATE_PURCHASE_REASON, false);
                    metrics.autoRefund();
                    audit.audit("DUPLICATE_ORDER_AUTO_REFUND", "order_no", order.getOrderNo(),
                            "uid", order.getUid(), "via", "delivery_retry");
                } catch (Exception e) {
                    metrics.autoRefundFailed();
                    audit.audit("DUPLICATE_ORDER_REFUND_FAILED", "order_no", order.getOrderNo(),
                            "uid", order.getUid(), "via", "delivery_retry");
                    log.error("[PAY] delivery_retry_auto_refund_failed order_no={} -- REFUND_HOLD, manual",
                            order.getOrderNo(), e);
                }
            }
        } catch (Exception e) {
            int attempts = order.getDeliveryAttempts() + 1;
            orderMapper.incrementDeliveryAttempts(order.getOrderNo(), now);
            audit.audit("DELIVERY_RETRY_FAILED", "order_no", order.getOrderNo(),
                    "uid", order.getUid(), "attempt", attempts, "err", e.toString());
            if (attempts >= MAX_DELIVERY_ATTEMPTS) {
                metrics.deliveryExhausted();
                audit.audit("DELIVERY_RETRY_EXHAUSTED", "order_no", order.getOrderNo(),
                        "uid", order.getUid(), "attempts", attempts);
                log.error("[PAY] delivery_retry_exhausted order_no={} attempts={} -- manual action required",
                        order.getOrderNo(), attempts);
            } else {
                log.error("[PAY] delivery_retry_failed order_no={} attempt={}", order.getOrderNo(), attempts, e);
            }
        }
    }

    @Override
    public boolean lastRunHadWork() {
        return lastHadWork;
    }
}
