package com.mindbase.pay.scheduler;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.mindbase.pay.common.TraceIdFilter;
import com.mindbase.pay.config.PayProperties;
import com.mindbase.pay.mapper.PayOrderMapper;
import com.mindbase.pay.model.PayOrder;
import com.mindbase.pay.service.DeliveryService;
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
 * Multiple instances are mutually excluded via {@link JobLease} (correctness is still guaranteed by conditional updates).
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class DeliveryRetryJob implements AdaptiveJob {

    private final PayOrderMapper orderMapper;
    private final DeliveryService deliveryService;
    private final JobLease lease;
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
            // ORDER BY paid_at matches the composite index (status, paid_at), avoiding filesort
            var stuck = orderMapper.selectList(new LambdaQueryWrapper<PayOrder>()
                    .eq(PayOrder::getStatus, PayOrder.OrderStatus.PAID)
                    .lt(PayOrder::getPaidAt, now.minusMinutes(1))
                    .orderByAsc(PayOrder::getPaidAt)
                    .last("LIMIT " + Math.max(1, props.job().scanLimit())));
            lastHadWork = !stuck.isEmpty();
            for (PayOrder order : stuck) {
                try {
                    deliveryService.deliverOrder(order);
                } catch (Exception e) {
                    log.error("[PAY] delivery_retry_failed order_no={}", order.getOrderNo(), e);
                }
            }
        } finally {
            MDC.clear();
        }
    }

    @Override
    public boolean lastRunHadWork() {
        return lastHadWork;
    }
}
