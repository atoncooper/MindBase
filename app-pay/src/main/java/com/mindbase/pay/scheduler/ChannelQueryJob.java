package com.mindbase.pay.scheduler;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.mindbase.pay.common.PayMetrics;
import com.mindbase.pay.common.TraceIdFilter;
import com.mindbase.pay.config.PayProperties;
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
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Missed-payment compensation (M2 main path): callbacks may be lost due to network issues/restarts, and local deployments
 * often have no public callback address, so CREATED orders still within the payment window (past the 60s order buffer)
 * are periodically polled against the channel.
 * Found paid -> goes through the unified handleChannelPaid entry point (idempotent, including late payment after closing);
 * channel side closed (buyer cancelled) -> close locally. No backoff (missed payments need prompt handling).
 *
 * <p><b>并行化</b>：每轮 scan-limit（默认 200）单在 8 线程出网池里并行查渠道——原"50 单/分钟"
 * 的串行天花板是高并发下的积压源。多实例互斥仍由 JobLease 保证。
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
    private final PayProperties props;
    private final Clock clock;
    private final ExecutorService queryExecutor;
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
            List<PayOrder> pending = orderMapper.selectList(new LambdaQueryWrapper<PayOrder>()
                    .eq(PayOrder::getStatus, PayOrder.OrderStatus.CREATED)
                    .gt(PayOrder::getExpiresAt, now.minusMinutes(10))
                    .lt(PayOrder::getCreatedAt, now.minusSeconds(60))
                    .orderByAsc(PayOrder::getCreatedAt)
                    .last("LIMIT " + Math.max(1, props.job().scanLimit())));
            AtomicInteger workedCount = new AtomicInteger();
            List<CompletableFuture<Void>> futures = new ArrayList<>(pending.size());
            for (PayOrder order : pending) {
                futures.add(CompletableFuture.runAsync(() -> {
                    try {
                        if (processOne(order)) {
                            workedCount.incrementAndGet();
                        }
                    } catch (Exception e) {
                        log.error("[PAY] channel_query_failed order_no={}", order.getOrderNo(), e);
                    }
                }, queryExecutor));
            }
            CompletableFuture.allOf(futures.toArray(new CompletableFuture[0])).join();
            lastHadWork = workedCount.get() > 0;
        } finally {
            MDC.clear();
        }
    }

    /** @return true if this order advanced the local state (paid/closed) */
    private boolean processOne(PayOrder order) {
        if (order.getChannel() == PayOrder.PayChannel.MOCK) {
            return false; // the mock channel has no remote side to query
        }
        PayChannelAdapter adapter = channelRouter.requireAdapter(order.getChannel());
        ChannelQueryResult result = adapter.queryOrder(order);
        switch (result.status()) {
            case PAID -> {
                log.info("[PAY] channel_query_paid channel={}", order.getChannel());
                metrics.channelQueryPaid();
                paymentService.handleChannelPaid(order.getOrderNo(), order.getChannel(),
                        result.tradeNo(), result.paidAmountCents(),
                        "{\"source\":\"channel_query\"}", PayCallbackLog.SignatureResult.VALID,
                        result.buyerLogonId(), result.buyerUserId());
                return true;
            }
            case CLOSED -> {
                int closed = orderMapper.closeOrder(order.getOrderNo(),
                        LocalDateTime.now(clock), "CHANNEL_CLOSED");
                if (closed > 0) {
                    log.info("[PAY] channel_closed_local order_no={}", order.getOrderNo());
                    return true;
                }
                return false;
            }
            case NOT_PAID -> { return false; /* not paid/not found yet, retry next round */ }
        }
        return false;
    }

    @Override
    public boolean lastRunHadWork() {
        return lastHadWork;
    }
}
