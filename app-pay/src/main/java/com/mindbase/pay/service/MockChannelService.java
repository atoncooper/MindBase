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
 * M1 模拟支付渠道：复用 PaymentService.handleChannelPaid 完整链路（落流水/幂等/交付），
 * M2 真实渠道接入后只需关闭 pay.mock.enabled 并新增渠道适配器，业务侧无感。
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
            // 关闭后接口整体隐身，避免暴露内部调试入口
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
                order.getAmountCents(), payload, PayCallbackLog.SignatureResult.SKIPPED);
    }
}
