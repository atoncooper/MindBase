package com.mindbase.pay.service;

import com.baomidou.mybatisplus.core.conditions.Wrapper;
import com.mindbase.pay.common.ApiException;
import com.mindbase.pay.common.PayAuditLogger;
import com.mindbase.pay.common.PayMetrics;
import com.mindbase.pay.config.PayProperties;
import com.mindbase.pay.mapper.PayOrderMapper;
import com.mindbase.pay.model.PayOrder;
import com.mindbase.pay.model.PayProduct;
import com.mindbase.pay.service.channel.PayChannelAdapter;
import com.mindbase.pay.service.channel.PayChannelRouter;
import com.mindbase.pay.service.timer.AppTaskTimerClient;
import com.mindbase.pay.testutil.TestPayProperties;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** Order creation validation: unified admission across all channels, tier snapshot, open-order limit, idempotency-key hit, unique-key fallback, cancellation, order ownership. */
@ExtendWith(MockitoExtension.class)
class OrderServiceTest {

    private static final LocalDateTime NOW = LocalDateTime.of(2026, 9, 6, 12, 0);

    @Mock
    private PayOrderMapper orderMapper;
    @Mock
    private ProductService productService;
    @Mock
    private PayChannelRouter channelRouter;
    @Mock
    private PayChannelAdapter alipayAdapter;
    @Mock
    private PayChannelAdapter mockAdapter;
    @Mock
    private PaymentService paymentService;
    @Mock
    private MembershipService membershipService;
    @Mock
    private PayAuditLogger audit;
    @Mock
    private PayMetrics metrics;
    @Mock
    private AppTaskTimerClient timerClient;
    @Mock
    private PlatformTransactionManager txManager;

    private OrderService service;

    @BeforeEach
    void setUp() {
        Clock clock = Clock.fixed(Instant.parse("2026-09-06T04:00:00Z"), ZoneId.of("Asia/Shanghai"));
        // mock transaction manager: execute only invokes the callback, commit/rollback are no-ops, no transaction synchronization activated
        service = new OrderService(orderMapper, productService, membershipService, channelRouter,
                paymentService, audit, timerClient, metrics, TestPayProperties.defaults(), clock,
                new TransactionTemplate(txManager));
    }

    private PayProduct product() {
        PayProduct product = new PayProduct();
        product.setCode("VIP_MONTHLY");
        product.setTitle("Membership - Monthly");
        product.setDurationDays(30);
        product.setPriceCents(1800);
        product.setTier("VIP");
        product.setStatus(PayProduct.ProductStatus.ACTIVE);
        return product;
    }

    /** MOCK is now a first-class channel in the router; stubbing both call sites is required for completeness. */
    private void stubMockChannel() {
        when(channelRouter.requireAdapter(PayOrder.PayChannel.MOCK)).thenReturn(mockAdapter);
        when(mockAdapter.createPayment(any(PayOrder.class)))
                .thenReturn(Map.of("type", "mock", "confirmEndpoint", "/pay/mock/confirm"));
    }

    @Test
    void createOrderSnapshotsProductFields() {
        stubMockChannel();
        when(productService.requireActive("VIP_MONTHLY")).thenReturn(product());
        when(productService.expireAtFrom(NOW)).thenReturn(NOW.plusMinutes(30));

        OrderService.CreatedOrder outcome =
                service.createOrder(10086L, "VIP_MONTHLY", PayOrder.PayChannel.MOCK, null);
        PayOrder order = outcome.order();

        assertThat(order.getOrderNo()).startsWith("PO");
        assertThat(order.getUid()).isEqualTo(10086L);
        // Snapshot: later price/duration/tier changes do not affect this order
        assertThat(order.getAmountCents()).isEqualTo(1800L);
        assertThat(order.getDurationDays()).isEqualTo(30);
        assertThat(order.getTier()).isEqualTo("VIP");
        assertThat(order.getStatus()).isEqualTo(PayOrder.OrderStatus.CREATED);
        assertThat(order.getExpiresAt()).isEqualTo(NOW.plusMinutes(30));
        assertThat(outcome.payParams()).containsEntry("type", "mock");
        verify(orderMapper).insert(order);
        verify(timerClient).registerOrderTimeoutAfterCommit(
                eq(10086L), eq(order.getOrderNo()), eq(1), eq(NOW.plusMinutes(30)));
    }

    @Test
    void alipayOrderDelegatesToAdapter() {
        when(channelRouter.requireAdapter(PayOrder.PayChannel.ALIPAY)).thenReturn(alipayAdapter);
        when(productService.requireActive("VIP_MONTHLY")).thenReturn(product());
        when(productService.expireAtFrom(NOW)).thenReturn(NOW.plusMinutes(30));
        when(alipayAdapter.createPayment(any(PayOrder.class)))
                .thenReturn(Map.of("type", "alipay_qr", "qrCode", "https://qr.alipay.com/x"));

        OrderService.CreatedOrder outcome =
                service.createOrder(10086L, "VIP_MONTHLY", PayOrder.PayChannel.ALIPAY, null);

        assertThat(outcome.payParams()).containsEntry("type", "alipay_qr");
        verify(alipayAdapter).createPayment(any(PayOrder.class));
        verify(orderMapper).insert(outcome.order());
    }

    @Test
    void paymentParamsDelegatesToChannelAdapter() {
        PayOrder order = new PayOrder();
        order.setOrderNo("PO1");
        order.setChannel(PayOrder.PayChannel.ALIPAY);
        when(channelRouter.requireAdapter(PayOrder.PayChannel.ALIPAY)).thenReturn(alipayAdapter);
        when(alipayAdapter.createPayment(order))
                .thenReturn(Map.of("type", "alipay_qr", "qrCode", "https://qr.alipay.com/x"));

        assertThat(service.paymentParams(order)).containsEntry("qrCode", "https://qr.alipay.com/x");
    }

    @Test
    void disabledChannelRejectedBeforeInsert() {
        when(channelRouter.requireAdapter(PayOrder.PayChannel.WECHAT_PAY))
                .thenThrow(ApiException.badRequest("CHANNEL_NOT_SUPPORTED", "Payment channel not supported yet"));

        assertThatThrownBy(() -> service.createOrder(10086L, "VIP_MONTHLY",
                PayOrder.PayChannel.WECHAT_PAY, null))
                .isInstanceOf(ApiException.class)
                .hasMessageContaining("not supported");
        verify(orderMapper, never()).insert(any(PayOrder.class));
    }

    @Test
    void mockChannelDisabledInProductionIsRejected() {
        // Production profile mock.enabled=false: MOCK must also be rejected by the router, so an order that can never be paid is never created
        when(channelRouter.requireAdapter(PayOrder.PayChannel.MOCK))
                .thenThrow(ApiException.badRequest("CHANNEL_NOT_SUPPORTED", "Payment channel not supported yet"));

        assertThatThrownBy(() -> service.createOrder(10086L, "VIP_MONTHLY",
                PayOrder.PayChannel.MOCK, null))
                .isInstanceOf(ApiException.class)
                .extracting(e -> ((ApiException) e).getStatus())
                .isEqualTo(400);
        verify(orderMapper, never()).insert(any(PayOrder.class));
    }

    @Test
    void openOrderLimitRejectsWith429() {
        when(channelRouter.requireAdapter(PayOrder.PayChannel.MOCK)).thenReturn(mockAdapter);
        when(productService.requireActive("VIP_MONTHLY")).thenReturn(product());
        when(orderMapper.selectCount(any(Wrapper.class))).thenReturn(10L);

        assertThatThrownBy(() -> service.createOrder(10086L, "VIP_MONTHLY",
                PayOrder.PayChannel.MOCK, null))
                .isInstanceOf(ApiException.class)
                .extracting(e -> ((ApiException) e).getStatus())
                .isEqualTo(429);
        verify(orderMapper, never()).insert(any(PayOrder.class));
    }

    @Test
    void idempotencyKeyReturnsExistingOrder() {
        stubMockChannel();
        PayOrder existing = new PayOrder();
        existing.setOrderNo("PO-EXIST");
        existing.setUid(10086L);
        when(orderMapper.selectOne(any(Wrapper.class))).thenReturn(existing);

        OrderService.CreatedOrder outcome =
                service.createOrder(10086L, "VIP_MONTHLY", PayOrder.PayChannel.MOCK, "key-1");

        assertThat(outcome.order().getOrderNo()).isEqualTo("PO-EXIST");
        verify(orderMapper, never()).insert(any(PayOrder.class));
        verify(timerClient, never()).registerOrderTimeoutAfterCommit(
                anyLong(), anyString(), anyInt(), any());
    }

    @Test
    void idempotencyKeyOfAnotherUserConflicts() {
        when(channelRouter.requireAdapter(PayOrder.PayChannel.MOCK)).thenReturn(mockAdapter);
        PayOrder existing = new PayOrder();
        existing.setOrderNo("PO-EXIST");
        existing.setUid(999L);
        when(orderMapper.selectOne(any(Wrapper.class))).thenReturn(existing);

        assertThatThrownBy(() -> service.createOrder(10086L, "VIP_MONTHLY",
                PayOrder.PayChannel.MOCK, "key-1"))
                .isInstanceOf(ApiException.class)
                .hasMessageContaining("Idempotency key");
    }

    @Test
    void duplicateOrderNoTranslatesToConflict() {
        when(channelRouter.requireAdapter(PayOrder.PayChannel.MOCK)).thenReturn(mockAdapter);
        when(productService.requireActive("VIP_MONTHLY")).thenReturn(product());
        when(orderMapper.insert(any(PayOrder.class)))
                .thenThrow(new DuplicateKeyException("uk_pay_order_no"));

        assertThatThrownBy(() -> service.createOrder(10086L, "VIP_MONTHLY",
                PayOrder.PayChannel.MOCK, null))
                .isInstanceOf(ApiException.class)
                .extracting(e -> ((ApiException) e).getStatus())
                .isEqualTo(409);
    }

    @Test
    void concurrentIdempotencyKeyRecoversExistingOrder() {
        stubMockChannel();
        PayOrder existing = new PayOrder();
        existing.setOrderNo("PO-RACE");
        existing.setUid(10086L);
        // First read (idempotency check) misses -> insert hits the unique key (concurrent winner already committed) -> fallback re-read hits and reuses
        when(orderMapper.selectOne(any(Wrapper.class))).thenReturn(null, existing);
        when(productService.requireActive("VIP_MONTHLY")).thenReturn(product());
        when(orderMapper.insert(any(PayOrder.class)))
                .thenThrow(new DuplicateKeyException("uk_pay_order_idempotency_key"));

        OrderService.CreatedOrder outcome =
                service.createOrder(10086L, "VIP_MONTHLY", PayOrder.PayChannel.MOCK, "key-1");

        assertThat(outcome.order().getOrderNo()).isEqualTo("PO-RACE");
        assertThat(outcome.payParams()).containsEntry("type", "mock");
        verify(timerClient, never()).registerOrderTimeoutAfterCommit(
                anyLong(), anyString(), anyInt(), any());
    }

    @Test
    void cancelOrderClosesCreatedOrder() {
        PayOrder order = new PayOrder();
        order.setOrderNo("PO1");
        order.setUid(10086L);
        order.setStatus(PayOrder.OrderStatus.CREATED);
        when(orderMapper.selectOne(any(Wrapper.class))).thenReturn(order);
        when(orderMapper.closeOrder(eq("PO1"), any(), eq("USER_CANCELLED"))).thenReturn(1);

        PayOrder cancelled = service.cancelOrder(10086L, "PO1");

        assertThat(cancelled.getOrderNo()).isEqualTo("PO1");
        verify(orderMapper).closeOrder(eq("PO1"), any(), eq("USER_CANCELLED"));
        verify(audit).audit(eq("ORDER_CANCELLED"), any(), any(), any(), any());
    }

    @Test
    void cancelRejectsNonCreatedOrder() {
        PayOrder order = new PayOrder();
        order.setOrderNo("PO1");
        order.setUid(10086L);
        order.setStatus(PayOrder.OrderStatus.DELIVERED);
        when(orderMapper.selectOne(any(Wrapper.class))).thenReturn(order);

        assertThatThrownBy(() -> service.cancelOrder(10086L, "PO1"))
                .isInstanceOf(ApiException.class)
                .extracting(e -> ((ApiException) e).getStatus())
                .isEqualTo(409);
        verify(orderMapper, never()).closeOrder(anyString(), any(), anyString());
    }

    @Test
    void otherUsersOrderIs404() {
        PayOrder order = new PayOrder();
        order.setOrderNo("PO1");
        order.setUid(999L);
        when(orderMapper.selectOne(any(Wrapper.class))).thenReturn(order);

        assertThatThrownBy(() -> service.getOwnedOrder(10086L, "PO1"))
                .isInstanceOf(ApiException.class)
                .extracting(e -> ((ApiException) e).getStatus())
                .isEqualTo(404);
    }
}
