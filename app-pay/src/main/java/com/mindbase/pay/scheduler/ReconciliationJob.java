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
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Reconciliation (M4): proactively re-checks with the channel the locally paid orders (PAID/DELIVERED) within the recent
 * window; when "locally paid but channel unpaid/closed" or an amount mismatch is found, writes an audit record + metric
 * for operations follow-up.
 *
 * <p>Read-only reconciliation, no automatic order changes (to avoid collateral damage); window/batch limit controlled by pay.job.recon-*.
 * Multiple instances are mutually excluded via {@link JobLease}.
 *
 * <p>P1 加固：本任务原先在调度线程里串行处理 200 单 × 5s 渠道超时 ≈ 最长 16 分钟（超过 lease TTL 15 分钟），
 * 会长时间占用调度线程并可能被其他实例抢租约重复执行。现在改为与查单/关单任务共用 payJobQueryExecutor
 * 并行执行，并按 last_checked_at 轮转，避免永远只对账最新 200 单。
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
    private final ExecutorService queryExecutor;
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
                    .orderByAsc(PayOrder::getLastCheckedAt)
                    .orderByAsc(PayOrder::getPaidAt)
                    .last("LIMIT " + BATCH_LIMIT));
            AtomicInteger mismatches = new AtomicInteger();
            List<CompletableFuture<Void>> futures = new ArrayList<>(candidates.size());
            for (PayOrder order : candidates) {
                futures.add(CompletableFuture.runAsync(() -> {
                    try {
                        if (reconcileOne(order)) {
                            mismatches.incrementAndGet();
                        }
                    } finally {
                        orderMapper.touchChecked(order.getOrderNo(), LocalDateTime.now(clock));
                    }
                }, queryExecutor));
            }
            CompletableFuture.allOf(futures.toArray(new CompletableFuture[0])).join();
            lastHadWork = mismatches.get() > 0;
            if (mismatches.get() > 0) {
                log.warn("[PAY] recon_finished checked={} mismatches={}", candidates.size(), mismatches.get());
            }
        } finally {
            metrics.jobRan("reconciliation");
            MDC.clear();
        }
    }

    /** @return true when a mismatch was found (amount mismatch / channel no longer paid) */
    private boolean reconcileOne(PayOrder order) {
        try {
            PayChannelAdapter adapter = channelRouter.requireAdapter(order.getChannel());
            ChannelQueryResult result = adapter.queryOrder(order);
            if (result.status() != ChannelQueryResult.Status.PAID) {
                metrics.reconMismatch();
                audit.audit("RECON_MISMATCH", "order_no", order.getOrderNo(),
                        "uid", order.getUid(), "channel", order.getChannel().name(),
                        "local_status", order.getStatus().name(),
                        "channel_status", result.status().name());
                log.warn("[PAY] recon_mismatch order_no={} local={} channel={}",
                        order.getOrderNo(), order.getStatus(), result.status());
                return true;
            }
            if (result.paidAmountCents() != null
                    && result.paidAmountCents() != order.getAmountCents()) {
                metrics.reconMismatch();
                audit.audit("RECON_AMOUNT_MISMATCH", "order_no", order.getOrderNo(),
                        "expected_cents", order.getAmountCents(),
                        "channel_cents", result.paidAmountCents());
                return true;
            }
            return false;
        } catch (Exception e) {
            log.error("[PAY] recon_query_failed order_no={}", order.getOrderNo(), e);
            return false;
        }
    }

    @Override
    public boolean lastRunHadWork() {
        return lastHadWork;
    }
}
