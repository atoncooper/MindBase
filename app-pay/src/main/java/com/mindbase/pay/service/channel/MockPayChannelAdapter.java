package com.mindbase.pay.service.channel;

import com.mindbase.pay.config.PayProperties;
import com.mindbase.pay.model.PayOrder;
import org.springframework.stereotype.Component;

import java.util.Map;

/**
 * M1 mock channel adapter: makes MOCK go through the **same entry point** as real channels
 * (PayChannelRouter.requireAdapter).
 *
 * <p>Previously OrderService special-cased MOCK and skipped the adapter, so production
 * (pay.mock.enabled=false) could still create MOCK orders that could never be paid. With MOCK in the router,
 * "is the channel enabled" has a single decision point, and the disabled state hides both the order and the
 * confirm endpoint.
 */
@Component
public class MockPayChannelAdapter implements PayChannelAdapter {

    private final PayProperties payProperties;

    public MockPayChannelAdapter(PayProperties payProperties) {
        this.payProperties = payProperties;
    }

    @Override
    public PayOrder.PayChannel channel() {
        return PayOrder.PayChannel.MOCK;
    }

    @Override
    public boolean enabled() {
        return payProperties.mock() != null && payProperties.mock().enabled();
    }

    @Override
    public Map<String, Object> createPayment(PayOrder order) {
        return Map.of("type", "mock",
                "orderNo", order.getOrderNo(),
                "confirmEndpoint", "/pay/mock/confirm");
    }

    @Override
    public ChannelQueryResult queryOrder(PayOrder order) {
        // mock has no remote to query: always not paid, waiting for the confirm endpoint
        return ChannelQueryResult.notPaid();
    }

    @Override
    public RefundResult refund(PayOrder order, String reason) {
        return RefundResult.success("MOCK-REFUND-" + order.getOrderNo());
    }
}
