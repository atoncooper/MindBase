package com.mindbase.pay.scheduler;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.mindbase.pay.common.PayAuditLogger;
import com.mindbase.pay.common.PayMetrics;
import com.mindbase.pay.common.TraceIdFilter;
import com.mindbase.pay.config.PayProperties;
import com.mindbase.pay.mapper.PayOrderMapper;
import com.mindbase.pay.model.PayOrder;
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
 * Reconciliation (M4): proactively re-checks with the channel the locally paid orders (PAID/DELIVERED) within the recent
 * window; when "locally paid but channel unpaid/closed" or an amount mismatch is found, writes an audit record + metric
 * for operations follow-up.
 *
 * <p>Read-only reconciliation, no automatic order changes (to avoid collateral damage); window/batch limit controlled by pay.job.recon-*.
 * Multiple instances are mutually excluded via {@link JobLease}.
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class ReconciliationJob implements AdaptiveJob {

    private static final int BATCH_LIMIT = 200;

    private final PayOrderMapper orderMapper;
    private final PayChannelRouter channelRouter;
    private final JobLease lease;
    private final PayAuditLogger audit;
    private final PayMetrics metrics;
    private final PayProperties props;
    private final Clock clock;
    private volatile boolean lastHadWork;

    @Override
    public void run() {
        MDC.put(TraceIdFilter.TRACE_ID, "job-recon-" + UUID.randomUUID().toString().substring(0, 8));
        try {
            if (!lease.tryAcquire("reconciliation")) {
                lastHadWork = false;
                return;
            }
            LocalDateTime now = LocalDateTime.now(clock);
            int windowHours = Math.max(1, props.job().reconWindowHours());
            var candidates = orderMapper.selectList(new LambdaQueryWrapper<PayOrder>()
                    .in(PayOrder::getStatus, PayOrder.OrderStatus.PAID, PayOrder.OrderStatus.DELIVERED)
                    .ne(PayOrder::getChannel, PayOrder.PayChannel.MOCK)
                    .ge(PayOrder::getPaidAt, now.minusHours(windowHours))
                    .orderByDesc(PayOrder::getPaidAt)
                    .last("LIMIT " + BATCH_LIMIT));
            int mismatches = 0;
            for (PayOrder order : candidates) {
                try {
                    PayChannelAdapter adapter = channelRouter.requireAdapter(order.getChannel());
                    ChannelQueryResult result = adapter.queryOrder(order);
                    if (result.status() != ChannelQueryResult.Status.PAID) {
                        mismatches++;
                        metrics.reconMismatch();
                        audit.audit("RECON_MISMATCH", "order_no", order.getOrderNo(),
                                "uid", order.getUid(), "channel", order.getChannel().name(),
                                "local_status", order.getStatus().name(),
                                "channel_status", result.status().name());
                        log.warn("[PAY] recon_mismatch order_no={} local={} channel={}",
                                order.getOrderNo(), order.getStatus(), result.status());
                    } else if (result.paidAmountCents() != null
                            && result.paidAmountCents() != order.getAmountCents()) {
                        mismatches++;
                        metrics.reconMismatch();
                        audit.audit("RECON_AMOUNT_MISMATCH", "order_no", order.getOrderNo(),
                                "expected_cents", order.getAmountCents(),
                                "channel_cents", result.paidAmountCents());
                    }
                } catch (Exception e) {
                    log.error("[PAY] recon_query_failed order_no={}", order.getOrderNo(), e);
                }
            }
            lastHadWork = mismatches > 0;
            if (mismatches > 0) {
                log.warn("[PAY] recon_finished checked={} mismatches={}", candidates.size(), mismatches);
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
