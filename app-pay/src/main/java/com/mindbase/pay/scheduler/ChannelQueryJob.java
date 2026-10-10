package com.mindbase.pay.scheduler;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.mindbase.pay.common.PayMetrics;
import com.mindbase.pay.common.TraceIdFilter;
import com.mindbase.pay.mapper.PayOrderMapper;
import com.mindbase.pay.model.PayCallbackLog;
import com.mindbase.pay.model.PayOrder;
import com.mindbase.pay.service.PaymentService;
import com.mindbase.pay.service.channel.ChannelQueryResult;
import com.mindbase.pay.service.channel.PayChannelAdapter;
import com.mindbase.pay.service.channel.PayChannelRouter;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.slf4j.MDC;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.LocalDateTime;
import java.util.UUID;

/**
 * Missed-payment compensation (M2 main path): callbacks may be lost due to network issues/restarts, and local deployments
 * often have no public callback address, so CREATED orders still within the payment window (past the 60s order buffer)
 * are periodically polled against the channel.
 * Found paid -> goes through the unified handleChannelPaid entry point (idempotent, including late payment after closing);
 * channel side closed (buyer cancelled) -> close locally. No backoff (missed payments need prompt handling).
 *
 * <p>Multiple instances are mutually excluded via {@link JobLease}, preventing the same batch of orders from being
 * queried outbound repeatedly by multiple instances.
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class ChannelQueryJob implements AdaptiveJob {

    private final PayOrderMapper orderMapper;
    private final PayChannelRouter channelRouter;
    private final PaymentService paymentService;
    private final JobLease lease;
    private final PayMetrics metrics;
    private final Clock clock;
    private volatile boolean lastHadWork;

    @Override
    public void run() {
        // The job assigns its own traceId so all logs of this round (including triggered late payments) can be correlated
        MDC.put(TraceIdFilter.TRACE_ID, "job-query-" + UUID.randomUUID().toString().substring(0, 8));
        try {
            if (!lease.tryAcquire("channel-query")) {
                lastHadWork = false;
                return;
            }
            LocalDateTime now = LocalDateTime.now(clock);
            // Still within the payment window (expires_at > now) -> hits the composite index (status, expires_at)
            var pending = orderMapper.selectList(new LambdaQueryWrapper<PayOrder>()
                    .eq(PayOrder::getStatus, PayOrder.OrderStatus.CREATED)
                    .gt(PayOrder::getExpiresAt, now.minusMinutes(10))
                    .lt(PayOrder::getCreatedAt, now.minusSeconds(60))
                    .orderByAsc(PayOrder::getCreatedAt)
                    .last("LIMIT 50"));
            boolean worked = false;
            for (PayOrder order : pending) {
                if (order.getChannel() == PayOrder.PayChannel.MOCK) {
                    continue; // the mock channel has no remote side to query
                }
                try {
                    PayChannelAdapter adapter = channelRouter.requireAdapter(order.getChannel());
                    ChannelQueryResult result = adapter.queryOrder(order);
                    switch (result.status()) {
                        case PAID -> {
                            log.info("[PAY] channel_query_paid channel={}", order.getChannel());
                            metrics.channelQueryPaid();
                            worked = true;
                            paymentService.handleChannelPaid(order.getOrderNo(), order.getChannel(),
                                    result.tradeNo(), result.paidAmountCents(),
                                    "{\"source\":\"channel_query\"}", PayCallbackLog.SignatureResult.VALID,
                                    result.buyerLogonId(), result.buyerUserId());
                        }
                        case CLOSED -> {
                            int closed = orderMapper.closeOrder(order.getOrderNo(),
                                    LocalDateTime.now(clock), "CHANNEL_CLOSED");
                            if (closed > 0) {
                                worked = true;
                                log.info("[PAY] channel_closed_local");
                            }
                        }
                        case NOT_PAID -> { /* not paid/not found yet, retry next round */ }
                    }
                } catch (Exception e) {
                    log.error("[PAY] channel_query_failed", e);
                }
            }
            lastHadWork = worked;
        } finally {
            MDC.clear();
        }
    }

    @Override
    public boolean lastRunHadWork() {
        return lastHadWork;
    }
}
