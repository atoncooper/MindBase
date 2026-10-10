package com.mindbase.pay;

import com.mindbase.pay.model.PayOrder;
import com.mindbase.pay.service.MembershipService;
import com.mindbase.pay.service.MockChannelService;
import com.mindbase.pay.service.OrderService;
import com.mindbase.pay.service.RefundService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.MySQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Real MySQL integration test (conditional-update SQL / transaction boundaries / Flyway migrations).
 * The whole class is skipped automatically when Docker is unavailable locally (disabledWithoutDocker=true); it runs in CI / on Docker-enabled environments.
 */
@SpringBootTest(properties = {
        "server.ssl.enabled=false",
        "pay.apptask.register-enabled=false",
        "pay.mock.enabled=true",
        "pay.test.enabled=true",
        "pay.test.token=test-token",
        "pay.test.require-token=false",
        "pay.refund.enabled=true",
        "management.endpoints.web.exposure.include=health"
})
@Testcontainers(disabledWithoutDocker = true)
class PayIntegrationTest {

    @Container
    @SuppressWarnings("resource")
    static final MySQLContainer<?> MYSQL = new MySQLContainer<>("mysql:8.0")
            .withDatabaseName("app_pay")
            .withUsername("app_pay")
            .withPassword("app-pay");

    @DynamicPropertySource
    static void datasource(DynamicPropertyRegistry registry) {
        registry.add("pay.rdbms.url", MYSQL::getJdbcUrl);
        registry.add("pay.rdbms.username", MYSQL::getUsername);
        registry.add("pay.rdbms.password", MYSQL::getPassword);
    }

    @Autowired
    private OrderService orderService;
    @Autowired
    private MockChannelService mockChannelService;
    @Autowired
    private MembershipService membershipService;
    @Autowired
    private RefundService refundService;

    @Test
    void mockPurchaseDeliversThenRefundRevokes() {
        long uid = 987654321L;
        OrderService.CreatedOrder created = orderService.createOrder(
                uid, "VIP_MONTHLY", PayOrder.PayChannel.MOCK, "it-key-1");
        String orderNo = created.order().getOrderNo();

        PayOrder paid = mockChannelService.confirmPaid(uid, orderNo);
        assertThat(paid.getStatus()).isEqualTo(PayOrder.OrderStatus.DELIVERED);

        var membership = membershipService.findByUid(uid).orElseThrow();
        assertThat(membershipService.isActive(membership)).isTrue();
        assertThat(membership.getTier()).isEqualTo("VIP");

        PayOrder refunded = refundService.refund(orderNo, "integration refund", true);
        assertThat(refunded.getStatus()).isEqualTo(PayOrder.OrderStatus.REFUNDED);
        // the 30-day membership is revoked (its period is exactly 30 days -> it returns to near now and is no longer active)
        var afterRefund = membershipService.findByUid(uid).orElseThrow();
        assertThat(afterRefund.getExpireAt()).isBeforeOrEqualTo(membership.getExpireAt());
    }

    @Test
    void idempotencyKeyReturnsSameOrder() {
        long uid = 987654322L;
        var first = orderService.createOrder(uid, "VIP_MONTHLY", PayOrder.PayChannel.MOCK, "it-key-2");
        var second = orderService.createOrder(uid, "VIP_MONTHLY", PayOrder.PayChannel.MOCK, "it-key-2");
        assertThat(second.order().getOrderNo()).isEqualTo(first.order().getOrderNo());
    }

    @Test
    void svipPurchaseIsNotDowngradedByLaterVipPurchase() {
        long uid = 987654323L;
        var svip = orderService.createOrder(uid, "SVIP_YEARLY", PayOrder.PayChannel.MOCK, null);
        mockChannelService.confirmPaid(uid, svip.order().getOrderNo());
        assertThat(membershipService.findByUid(uid).orElseThrow().getTier()).isEqualTo("SVIP");

        // 防重复购买（下单即拒）：SVIP 有效期内创建 VIP 订单直接 409，仅允许向上升级
        assertThatThrownBy(() -> orderService.createOrder(uid, "VIP_MONTHLY", PayOrder.PayChannel.MOCK, null))
                .isInstanceOf(com.mindbase.pay.common.ApiException.class)
                .hasMessageContaining("仅支持向上升级更高档位");

        assertThat(membershipService.findByUid(uid).orElseThrow().getTier()).isEqualTo("SVIP");
    }
}
