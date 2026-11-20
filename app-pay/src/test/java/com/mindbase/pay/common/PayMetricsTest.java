package com.mindbase.pay.common;

import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** 可观测性契约：job 最后运行时间 gauge、资金差异指标、安全指标必须真实注册（否则告警永不触发）。 */
class PayMetricsTest {

    @Test
    void jobLastRunGaugeIsRegisteredAndUpdated() {
        SimpleMeterRegistry registry = new SimpleMeterRegistry();
        PayMetrics metrics = new PayMetrics(registry);

        for (String job : new String[]{"order-timeout", "delivery-retry", "channel-query", "reconciliation"}) {
            assertThat(registry.find("pay.job.last.run").tag("job", job).gauge())
                    .as("gauge for job %s", job)
                    .isNotNull();
        }

        metrics.jobRan("order-timeout");

        assertThat(registry.find("pay.job.last.run").tag("job", "order-timeout").gauge().value())
                .isGreaterThan(0);
    }

    @Test
    void moneyAndSecurityCountersAreRegisteredOnUsage() {
        SimpleMeterRegistry registry = new SimpleMeterRegistry();
        PayMetrics metrics = new PayMetrics(registry);

        metrics.callbackAmountMismatch();
        metrics.callbackAmountMismatch();
        metrics.callbackUnknownOrder();
        metrics.internalAuthRejected();
        metrics.deliveryTierBlocked();
        metrics.autoRefund();
        metrics.autoRefundFailed();
        metrics.deliveryExhausted();
        metrics.channelThrottled();
        metrics.grantQuotaExceeded();
        metrics.riskBlocked("cooldown");

        assertThat(registry.find("pay.callback.amount_mismatch").counter().count()).isEqualTo(2.0);
        assertThat(registry.find("pay.callback.unknown_order").counter().count()).isEqualTo(1.0);
        assertThat(registry.find("pay.internal.auth_rejected").counter().count()).isEqualTo(1.0);
        assertThat(registry.find("pay.delivery.tier_blocked").counter().count()).isEqualTo(1.0);
        assertThat(registry.find("pay.order.auto_refund").counter().count()).isEqualTo(1.0);
        assertThat(registry.find("pay.order.auto_refund_failed").counter().count()).isEqualTo(1.0);
        assertThat(registry.find("pay.delivery.exhausted").counter().count()).isEqualTo(1.0);
        assertThat(registry.find("pay.channel.throttled").counter().count()).isEqualTo(1.0);
        assertThat(registry.find("pay.grant.quota_exceeded").counter().count()).isEqualTo(1.0);
        assertThat(registry.find("pay.risk.blocked").tag("reason", "cooldown").counter().count())
                .isEqualTo(1.0);
    }
}
