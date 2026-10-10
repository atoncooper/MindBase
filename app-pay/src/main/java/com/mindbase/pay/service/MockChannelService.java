package com.mindbase.pay.service;

import com.mindbase.pay.common.ApiException;
import com.mindbase.pay.config.PayProperties;
import com.mindbase.pay.model.PayCallbackLog;
import com.mindbase.pay.model.PayOrder;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.UUID;

/**
 * M1 mock payment channel: reuses the full PaymentService.handleChannelPaid path (callback log / idempotency /
 * delivery). Once real M2 channels are wired in, it only takes pay.mock.enabled=false plus a new channel adapter;
 * nothing else changes.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class MockChannelService {

    private final PaymentService paymentService;
    private final OrderService orderService;
    private final PayProperties payProperties;

    public PayOrder confirmPaid(long uid, String orderNo) {
        if (!payProperties.mock().enabled()) {
            // When disabled the endpoint disappears entirely, avoiding exposure of an internal debug entry point
            throw ApiException.notFound("NOT_FOUND", "Endpoint not found");
        }
        PayOrder order = orderService.getOwnedOrder(uid, orderNo);
        if (order.getStatus() != PayOrder.OrderStatus.CREATED) {
            throw ApiException.conflict("ORDER_NOT_PAYABLE", "Order is not payable in current state: " + order.getStatus());
        }
        String tradeNo = "MOCK-" + UUID.randomUUID();
        String payload = "{\"mock\":true,\"orderNo\":\"" + orderNo + "\",\"tradeNo\":\"" + tradeNo + "\"}";
        log.info("[PAY] mock_confirm uid={} order_no={}", uid, orderNo);
        return paymentService.handleChannelPaid(orderNo, PayOrder.PayChannel.MOCK, tradeNo,
                order.getAmountCents(), payload, PayCallbackLog.SignatureResult.SKIPPED, null, null);
    }
}
