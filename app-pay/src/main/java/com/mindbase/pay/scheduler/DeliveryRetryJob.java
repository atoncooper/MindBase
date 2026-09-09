package com.mindbase.pay.scheduler;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.mindbase.pay.common.TraceIdFilter;
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
 * 交付补偿：PAID 停留超过 1 分钟（正常回调链路早已完成交付）→ 重试交付。
 * 与并发交付的竞争由 markDelivered 条件更新兜底，双跑不会重复顺延会员。
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class DeliveryRetryJob implements AdaptiveJob {

    private final PayOrderMapper orderMapper;
    private final DeliveryService deliveryService;
    private final Clock clock;
    private volatile boolean lastHadWork;

    @Override
    public void run() {
        MDC.put(TraceIdFilter.TRACE_ID, "job-retry-" + UUID.randomUUID().toString().substring(0, 8));
        try {
            LocalDateTime now = LocalDateTime.now(clock);
            // ORDER BY paid_at 与复合索引 (status, paid_at) 同序，免 filesort
            var stuck = orderMapper.selectList(new LambdaQueryWrapper<PayOrder>()
                    .eq(PayOrder::getStatus, PayOrder.OrderStatus.PAID)
                    .lt(PayOrder::getPaidAt, now.minusMinutes(1))
                    .orderByAsc(PayOrder::getPaidAt)
                    .last("LIMIT 50"));
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
