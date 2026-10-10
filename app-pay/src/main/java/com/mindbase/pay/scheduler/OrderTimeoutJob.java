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
 * Timed-out order closing fallback (plan/1.0.8): the main path is the precise timed delegation from app-task (executor);
 * this job is the fallback — when registration fails/app-task is down, jitter + adaptive backoff polling takes over,
 * eventually consistent.
 * Multiple instances are mutually excluded via {@link JobLease}, avoiding duplicate scans.
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
    private final Clock clock;
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
            var expired = orderMapper.selectList(new LambdaQueryWrapper<PayOrder>()
                    .eq(PayOrder::getStatus, PayOrder.OrderStatus.CREATED)
                    .le(PayOrder::getExpiresAt, now)
                    .orderByAsc(PayOrder::getExpiresAt)
                    .last("LIMIT 50"));
            boolean worked = false;
            for (PayOrder order : expired) {
                // 关单前向渠道做最后一次确认：有效期最后一刻扫码支付的，钱已收下
                // 是事实 —— 走 markPaidAfterClose 补偿开通，而不是关掉用户的支付。
                if (order.getChannel() != PayOrder.PayChannel.MOCK) {
                    try {
                        PayChannelAdapter adapter = channelRouter.requireAdapter(order.getChannel());
                        ChannelQueryResult result = adapter.queryOrder(order);
                        if (result.status() == ChannelQueryResult.Status.PAID) {
                            paymentService.handleChannelPaid(order.getOrderNo(), order.getChannel(),
                                    result.tradeNo(), result.paidAmountCents(),
                                    "{\"source\":\"timeout_query\"}", PayCallbackLog.SignatureResult.VALID,
                                    result.buyerLogonId(), result.buyerUserId());
                            worked = true;
                            continue;
                        }
                    } catch (Exception e) {
                        // 查单失败不关单：宁可迟关不可错关，下一轮再试
                        log.error("[PAY] timeout_final_query_failed order_no={}", order.getOrderNo(), e);
                        continue;
                    }
                }
                int closed = orderMapper.closeOrder(order.getOrderNo(), now, "PAY_TIMEOUT");
                if (closed > 0) {
                    worked = true;
                    log.info("[PAY] order_closed_timeout order_no={}", order.getOrderNo());
                }
            }
            lastHadWork = worked;
            if (worked) {
                metrics.orderClosed("timeout");
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
