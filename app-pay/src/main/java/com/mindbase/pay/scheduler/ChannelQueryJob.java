package com.mindbase.pay.scheduler;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
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
 * 掉单补偿（M2 主路径）：回调可能因网络/重启丢失，且本地部署常无公网回调地址，
 * 因此对仍在支付窗口内的 CREATED 订单（已过 60s 下单缓冲）定时向渠道主动查单。
 * 查得已支付 → 走 handleChannelPaid 统一入口（幂等，含关单后补单）；
 * 渠道侧已关闭（买家取消）→ 本地关单。不退避（掉单要及时）。
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class ChannelQueryJob implements AdaptiveJob {

    private final PayOrderMapper orderMapper;
    private final PayChannelRouter channelRouter;
    private final PaymentService paymentService;
    private final Clock clock;
    private volatile boolean lastHadWork;

    @Override
    public void run() {
        // job 运行自赋 traceId：本轮所有日志（含触发的补单）可整段关联
        MDC.put(TraceIdFilter.TRACE_ID, "job-query-" + UUID.randomUUID().toString().substring(0, 8));
        try {
            LocalDateTime now = LocalDateTime.now(clock);
            // 仍在支付窗口内（expires_at > now）→ 命中复合索引 (status, expires_at)
            var pending = orderMapper.selectList(new LambdaQueryWrapper<PayOrder>()
                    .eq(PayOrder::getStatus, PayOrder.OrderStatus.CREATED)
                    .gt(PayOrder::getExpiresAt, now)
                    .lt(PayOrder::getCreatedAt, now.minusSeconds(60))
                    .orderByAsc(PayOrder::getCreatedAt)
                    .last("LIMIT 50"));
            boolean worked = false;
            for (PayOrder order : pending) {
                if (order.getChannel() == PayOrder.PayChannel.MOCK) {
                    continue; // mock 渠道无远端可查
                }
                try {
                    PayChannelAdapter adapter = channelRouter.requireAdapter(order.getChannel());
                    ChannelQueryResult result = adapter.queryOrder(order);
                    switch (result.status()) {
                        case PAID -> {
                            log.info("[PAY] channel_query_paid channel={}", order.getChannel());
                            worked = true;
                            paymentService.handleChannelPaid(order.getOrderNo(), order.getChannel(),
                                    result.tradeNo(), result.paidAmountCents(),
                                    "{\"source\":\"channel_query\"}", PayCallbackLog.SignatureResult.VALID);
                        }
                        case CLOSED -> {
                            int closed = orderMapper.closeOrder(order.getOrderNo(),
                                    LocalDateTime.now(clock), "CHANNEL_CLOSED");
                            if (closed > 0) {
                                worked = true;
                                log.info("[PAY] channel_closed_local");
                            }
                        }
                        case NOT_PAID -> { /* 未支付/未查到，下轮再查 */ }
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
