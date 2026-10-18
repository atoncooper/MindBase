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
 * Timed-out order closing fallback (plan/1.0.8): the main path is the precise timed delegation from app-task (executor);
 * this job is the fallback — when registration fails/app-task is down, jitter + adaptive backoff polling takes over,
 * eventually consistent.
 * Multiple instances are mutually excluded via {@link JobLease}, avoiding duplicate scans.
 * 每单处理（最后一次渠道确认 + 关单/补交付）并行执行，单轮 scan-limit 单。
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class OrderTimeoutJob implements AdaptiveJob {

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
        MDC.put(TraceIdFilter.TRACE_ID, "job-timeout-" + UUID.randomUUID().toString().substring(0, 8));
        try {
            if (!lease.tryAcquire("order-timeout")) {
                lastHadWork = false;
                return;
            }
            LocalDateTime now = LocalDateTime.now(clock);
            List<PayOrder> expired = orderMapper.selectList(new LambdaQueryWrapper<PayOrder>()
                    .eq(PayOrder::getStatus, PayOrder.OrderStatus.CREATED)
                    .le(PayOrder::getExpiresAt, now)
                    .orderByAsc(PayOrder::getExpiresAt)
                    .last("LIMIT " + Math.max(1, props.job().scanLimit())));
            AtomicInteger workedCount = new AtomicInteger();
            List<CompletableFuture<Void>> futures = new ArrayList<>(expired.size());
            for (PayOrder order : expired) {
                futures.add(CompletableFuture.runAsync(() -> {
                    try {
                        if (processOne(order, now)) {
                            workedCount.incrementAndGet();
                        }
                    } catch (Exception e) {
                        // 查单失败不关单：宁可迟关不可错关，下一轮再试
                        log.error("[PAY] timeout_final_query_failed order_no={}", order.getOrderNo(), e);
                    }
                }, queryExecutor));
            }
            CompletableFuture.allOf(futures.toArray(new CompletableFuture[0])).join();
            int worked = workedCount.get();
            lastHadWork = worked > 0;
            if (worked > 0) {
                metrics.orderClosed("timeout");
            }
        } finally {
            MDC.clear();
        }
    }

    private boolean processOne(PayOrder order, LocalDateTime now) {
        // 关单前向渠道做最后一次确认：有效期最后一刻扫码支付的，钱已收下是事实
        if (order.getChannel() != PayOrder.PayChannel.MOCK) {
            PayChannelAdapter adapter = channelRouter.requireAdapter(order.getChannel());
            ChannelQueryResult result = adapter.queryOrder(order);
            if (result.status() == ChannelQueryResult.Status.PAID) {
                paymentService.handleChannelPaid(order.getOrderNo(), order.getChannel(),
                        result.tradeNo(), result.paidAmountCents(),
                        "{\"source\":\"timeout_query\"}", PayCallbackLog.SignatureResult.VALID,
                        result.buyerLogonId(), result.buyerUserId());
                return true;
            }
        }
        int closed = orderMapper.closeOrder(order.getOrderNo(), now, "PAY_TIMEOUT");
        if (closed > 0) {
            log.info("[PAY] order_closed_timeout order_no={}", order.getOrderNo());
            return true;
        }
        return false;
    }

    @Override
    public boolean lastRunHadWork() {
        return lastHadWork;
    }
}
