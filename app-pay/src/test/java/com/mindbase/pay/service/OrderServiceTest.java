package com.mindbase.pay.service;

import com.baomidou.mybatisplus.core.conditions.Wrapper;
import com.mindbase.pay.common.ApiException;
import com.mindbase.pay.common.PayAuditLogger;
import com.mindbase.pay.common.PayMetrics;
import com.mindbase.pay.config.PayProperties;
import com.mindbase.pay.mapper.PayOrderMapper;
import com.mindbase.pay.model.PayOrder;
import com.mindbase.pay.model.PayProduct;
import com.mindbase.pay.service.channel.ChannelQueryResult;
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
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
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

    /** 升级换购用例基建：SVIP 有效会员 + DELIVERED 基准单（月付 30 天 ¥48）。 */
    private com.mindbase.pay.model.PayMembership lockedSvipMember(String baseOrderNo) {
        var m = new com.mindbase.pay.model.PayMembership();
        m.setUid(10086L);
        m.setTier("SVIP");
        m.setExpireAt(NOW.plusDays(30));
        m.setLastOrderNo(baseOrderNo);
        return m;
    }

    private PayOrder deliveredBaseOrder(String orderNo) {
        PayOrder o = new PayOrder();
        o.setOrderNo(orderNo);
        o.setUid(10086L);
        o.setSkuCode("SVIP_MONTHLY");
        o.setDurationDays(30);
        o.setAmountCents(4800);
        o.setTier("SVIP");
        o.setStatus(PayOrder.OrderStatus.DELIVERED);
        return o;
    }

    private PayProduct yearlyProduct() {
        PayProduct p = new PayProduct();
        p.setCode("SVIP_YEARLY");
        p.setTitle("Super Membership · Yearly");
        p.setDurationDays(365);
        p.setPriceCents(42000);
        p.setTier("SVIP");
        p.setStatus(PayProduct.ProductStatus.ACTIVE);
        return p;
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

    // ── 全局闸门 / 建单冷却 / 查单退避 ──

    @Test
    void globalGateRejectsBeyondLimit() {
        OrderService gated = new OrderService(orderMapper, productService, membershipService, channelRouter,
                paymentService, audit, timerClient, metrics,
                TestPayProperties.builder().risk(new PayProperties.Risk(5, 500_000, 0, 2)).build(),
                Clock.fixed(Instant.parse("2026-09-06T04:00:00Z"), ZoneId.of("Asia/Shanghai")),
                new TransactionTemplate(txManager));
        when(channelRouter.requireAdapter(PayOrder.PayChannel.MOCK)).thenReturn(mockAdapter);
        when(mockAdapter.createPayment(any(PayOrder.class))).thenReturn(Map.of("type", "mock"));
        when(productService.requireActive("VIP_MONTHLY")).thenReturn(product());
        when(productService.expireAtFrom(any(LocalDateTime.class))).thenReturn(NOW.plusMinutes(30));

        assertThatCode(() -> gated.createOrder(900002L, "VIP_MONTHLY", PayOrder.PayChannel.MOCK, null))
                .doesNotThrowAnyException();
        assertThatCode(() -> gated.createOrder(900002L, "VIP_MONTHLY", PayOrder.PayChannel.MOCK, null))
                .doesNotThrowAnyException();
        assertThatThrownBy(() -> gated.createOrder(900002L, "VIP_MONTHLY", PayOrder.PayChannel.MOCK, null))
                .isInstanceOf(ApiException.class)
                .extracting(e -> ((ApiException) e).getStatus())
                .isEqualTo(429);
    }

    @Test
    void orderCooldownBlocksRapidRepeatCreate() {
        // 独立 uid（900001）避免与其他用例共享静态冷却表
        OrderService cooled = new OrderService(orderMapper, productService, membershipService, channelRouter,
                paymentService, audit, timerClient, metrics,
                TestPayProperties.builder().risk(new PayProperties.Risk(5, 500_000, 30, 0)).build(),
                Clock.fixed(Instant.parse("2026-09-06T04:00:00Z"), ZoneId.of("Asia/Shanghai")),
                new TransactionTemplate(txManager));
        stubMockChannel();
        when(productService.requireActive("VIP_MONTHLY")).thenReturn(product());
        when(productService.expireAtFrom(any(LocalDateTime.class))).thenReturn(NOW.plusMinutes(30));

        assertThatCode(() -> cooled.createOrder(900001L, "VIP_MONTHLY", PayOrder.PayChannel.MOCK, null))
                .doesNotThrowAnyException();
        assertThatThrownBy(() -> cooled.createOrder(900001L, "VIP_MONTHLY", PayOrder.PayChannel.MOCK, null))
                .isInstanceOf(ApiException.class)
                .extracting(e -> ((ApiException) e).getStatus())
                .isEqualTo(429);
    }

    @Test
    void orderDetailPollingIsThrottledWithBackoff() {
        // 固定时钟下第二次轮询必须被退避挡住 —— 渠道只被查一次
        PayOrder order = new PayOrder();
        order.setOrderNo("PO1");
        order.setUid(10086L);
        order.setChannel(PayOrder.PayChannel.ALIPAY);
        order.setStatus(PayOrder.OrderStatus.CREATED);
        when(orderMapper.selectOne(any(Wrapper.class))).thenReturn(order);
        when(channelRouter.requireAdapter(PayOrder.PayChannel.ALIPAY)).thenReturn(alipayAdapter);
        when(alipayAdapter.queryOrder(order))
                .thenReturn(ChannelQueryResult.notPaid());

        service.getOwnedOrderLive(10086L, "PO1");
        service.getOwnedOrderLive(10086L, "PO1");

        verify(alipayAdapter, times(1)).queryOrder(any(PayOrder.class));
    }

    // ── 升级换购：同档补差价 ──
    // lockActiveMembershipForUpdate 返回的实体经 isActive 判定活跃（mock 需显式打桩）
    @Test
    void upgradeOrderChargesDifferenceAndRecordsBase() {
        // SVIP 有效期内买 SVIP 年付：不再拦截，按差价计价（42000 − 4800 = 37200），
        // 交付天数 = 365 − 30 = 335（顺延后总时长 = 原购买日起整一年）
        stubMockChannel();
        when(membershipService.isActive(any())).thenReturn(true);
        when(membershipService.lockActiveMembershipForUpdate(10086L))
                .thenReturn(lockedSvipMember("PO-BASE"));
        when(productService.requireActive("SVIP_YEARLY")).thenReturn(yearlyProduct());
        when(productService.expireAtFrom(any(LocalDateTime.class))).thenReturn(NOW.plusMinutes(30));
        when(orderMapper.selectOne(any(Wrapper.class))).thenReturn(deliveredBaseOrder("PO-BASE"));

        OrderService.CreatedOrder outcome =
                service.createOrder(10086L, "SVIP_YEARLY", PayOrder.PayChannel.MOCK, null);
        PayOrder order = outcome.order();

        assertThat(order.getAmountCents()).isEqualTo(37200L);
        assertThat(order.getDurationDays()).isEqualTo(335);
        assertThat(order.getUpgradeFromOrderNo()).isEqualTo("PO-BASE");
        verify(orderMapper).insert(order);
    }

    @Test
    void downgradeRemainsBlocked() {
        // SVIP 有效期内买 VIP：降档仍然拒绝（升级换购只放行同档/升档）
        when(membershipService.lockActiveMembershipForUpdate(10086L))
                .thenReturn(lockedSvipMember("PO-BASE"));
        when(productService.requireActive("VIP_MONTHLY")).thenReturn(product());
        when(membershipService.isActive(any())).thenReturn(true);

        assertThatThrownBy(() -> service.createOrder(10086L, "VIP_MONTHLY",
                PayOrder.PayChannel.MOCK, null))
                .isInstanceOf(ApiException.class)
                .hasMessageContaining("仅支持向上升级更高档位");
        verify(orderMapper, never()).insert(any(PayOrder.class));
    }

    @Test
    void upgradeWithoutDurationDifferenceIsRejected() {
        // 基准单 365 天，目标 90 天 → 无增量，拒绝
        when(membershipService.lockActiveMembershipForUpdate(10086L))
                .thenReturn(lockedSvipMember("PO-BASE"));
        PayProduct quarterly = new PayProduct();
        quarterly.setCode("SVIP_QUARTERLY");
        quarterly.setDurationDays(90);
        quarterly.setPriceCents(12000);
        quarterly.setTier("SVIP");
        quarterly.setStatus(PayProduct.ProductStatus.ACTIVE);
        when(membershipService.isActive(any())).thenReturn(true);
        when(productService.requireActive("SVIP_QUARTERLY")).thenReturn(quarterly);
        when(orderMapper.selectOne(any(Wrapper.class)))
                .thenReturn(deliveredBaseOrder365());

        assertThatThrownBy(() -> service.createOrder(10086L, "SVIP_QUARTERLY",
                PayOrder.PayChannel.MOCK, null))
                .isInstanceOf(ApiException.class)
                .hasMessageContaining("已覆盖目标套餐");
        verify(orderMapper, never()).insert(any(PayOrder.class));
    }

    private PayOrder deliveredBaseOrder365() {
        PayOrder o = deliveredBaseOrder("PO-BASE");
        o.setDurationDays(365);
        o.setAmountCents(42000);
        return o;
    }

    @Test
    void velocityLimitRejectsWith429() {
        // 滚动 24h 支付笔数触顶 → 429，订单不落库
        when(productService.requireActive("VIP_MONTHLY")).thenReturn(product());
        when(orderMapper.sumPaidSince(eq(10086L), any())).thenReturn(summary(5, 1800));

        assertThatThrownBy(() -> service.createOrder(10086L, "VIP_MONTHLY",
                PayOrder.PayChannel.MOCK, null))
                .isInstanceOf(ApiException.class)
                .extracting(e -> ((ApiException) e).getStatus())
                .isEqualTo(429);
        verify(orderMapper, never()).insert(any(PayOrder.class));
    }

    @Test
    void velocityAmountLimitRejectsWith429() {
        when(productService.requireActive("VIP_MONTHLY")).thenReturn(product());
        when(orderMapper.sumPaidSince(eq(10086L), any())).thenReturn(summary(1, 500_000));

        assertThatThrownBy(() -> service.createOrder(10086L, "VIP_MONTHLY",
                PayOrder.PayChannel.MOCK, null))
                .isInstanceOf(ApiException.class)
                .extracting(e -> ((ApiException) e).getStatus())
                .isEqualTo(429);
    }

    private com.mindbase.pay.mapper.PaidOrderSummary summary(long cnt, long total) {
        com.mindbase.pay.mapper.PaidOrderSummary s = new com.mindbase.pay.mapper.PaidOrderSummary();
        s.setCnt(cnt);
        s.setTotal(total);
        return s;
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
