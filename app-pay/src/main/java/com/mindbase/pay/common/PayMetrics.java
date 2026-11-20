package com.mindbase.pay.common;

import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Lightweight metrics for the fund path (Micrometer -> /actuator/metrics, /actuator/prometheus).
 * Counters only for business events; one gauge per fallback job (last-run epoch seconds) so a
 * stalled job is observable/alertable (the previous alert referenced a metric that never existed).
 */
@Component
public class PayMetrics {

    /** 由 JitteredBackoffTrigger 驱动的四个兜底 job（与 JobSchedulingConfig 保持一致）。 */
    private static final String[] JOB_NAMES = {
            "order-timeout", "delivery-retry", "channel-query", "reconciliation"
    };

    private final MeterRegistry registry;
    private final Map<String, AtomicLong> jobLastRun = new ConcurrentHashMap<>();

    public PayMetrics(MeterRegistry registry) {
        this.registry = registry;
        // 预先注册：指标不存在时 Prometheus 规则无法告警（原 AppPayJobStalled 即因指标缺失而永不触发）
        for (String job : JOB_NAMES) {
            AtomicLong last = new AtomicLong(0);
            jobLastRun.put(job, last);
            Gauge.builder("pay.job.last.run", last, AtomicLong::get)
                    .tag("job", job)
                    .description("Epoch seconds of the last completed run of a fallback job")
                    .register(registry);
        }
    }

    private void count(String name) {
        registry.counter(name).increment();
    }

    public void orderCreated() {
        count("pay.orders.created");
    }

    public void orderPaid() {
        count("pay.orders.paid");
    }

    public void orderClosed(String reason) {
        registry.counter("pay.orders.closed", "reason", reason).increment();
    }

    public void deliveryFailed() {
        count("pay.delivery.failed");
    }

    /** 第二道墙在交付唯一入口命中（重复/降档订单被冻结）。 */
    public void deliveryTierBlocked() {
        count("pay.delivery.tier_blocked");
    }

    /** 交付补偿达到尝试上限（毒丸订单，需人工）。 */
    public void deliveryExhausted() {
        count("pay.delivery.exhausted");
    }

    public void autoRefund() {
        count("pay.order.auto_refund");
    }

    public void autoRefundFailed() {
        count("pay.order.auto_refund_failed");
    }

    public void callbackRejected() {
        count("pay.callback.rejected");
    }

    /** 金额不符/缺失是资金差异事件：必须独立计数并告警（此前只有日志/审计，没有指标）。 */
    public void callbackAmountMismatch() {
        count("pay.callback.amount_mismatch");
    }

    public void callbackUnknownOrder() {
        count("pay.callback.unknown_order");
    }

    public void refundSucceeded() {
        count("pay.refund.succeeded");
    }

    public void refundFailed() {
        count("pay.refund.failed");
    }

    public void channelQueryPaid() {
        count("pay.channel.query.paid");
    }

    /** 渠道出网调用计数（配额告警的数据源）：query/create 各一个。 */
    public void channelQueryTotal() {
        count("pay.channel.query.total");
    }

    public void channelCreateTotal() {
        count("pay.channel.create.total");
    }

    /** 用户面渠道出网并发闸门拒绝（渠道变慢/被刷时保护 Tomcat 线程与渠道配额）。 */
    public void channelThrottled() {
        count("pay.channel.throttled");
    }

    /** 风控拦截计数（velocity/cooldown/global），配 Grafana 告警。 */
    public void riskBlocked(String reason) {
        registry.counter("pay.risk.blocked", "reason", reason).increment();
    }

    public void reconMismatch() {
        count("pay.recon.mismatch");
    }

    /** 内部端点鉴权失败（缺少/错误 X-Internal-Key）：安全事件，突增需告警。 */
    public void internalAuthRejected() {
        count("pay.internal.auth_rejected");
    }

    public void grantQuotaExceeded() {
        count("pay.grant.quota_exceeded");
    }

    /** 兜底 job 完成一次运行（含空跑/租约未获取），供 AppPayJobStalled 告警使用。 */
    public void jobRan(String job) {
        AtomicLong last = jobLastRun.get(job);
        if (last != null) {
            last.set(Instant.now().getEpochSecond());
        }
    }
}
