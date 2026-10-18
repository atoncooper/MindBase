package com.mindbase.pay.common;

import io.micrometer.core.instrument.MeterRegistry;
import org.springframework.stereotype.Component;

/**
 * Lightweight metrics for the fund path (Micrometer -> /actuator/metrics, /actuator/prometheus).
 * Counters only: orders/payment/close/delivery/callback/refund/query, for Grafana alerts and operations dashboards.
 */
@Component
public class PayMetrics {

    private final MeterRegistry registry;

    public PayMetrics(MeterRegistry registry) {
        this.registry = registry;
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

    public void callbackRejected() {
        count("pay.callback.rejected");
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

    /** 风控拦截计数（velocity/cooldown/global），配 Grafana 告警。 */
    public void riskBlocked(String reason) {
        registry.counter("pay.risk.blocked", "reason", reason).increment();
    }

    public void reconMismatch() {
        count("pay.recon.mismatch");
    }
}
