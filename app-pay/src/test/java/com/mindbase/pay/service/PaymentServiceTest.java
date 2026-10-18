package com.mindbase.pay.service;

import com.baomidou.mybatisplus.core.conditions.Wrapper;
import com.mindbase.pay.common.PayAuditLogger;
import com.mindbase.pay.common.PayMetrics;
import com.mindbase.pay.mapper.PayCallbackLogMapper;
import com.mindbase.pay.mapper.PayOrderMapper;
import com.mindbase.pay.model.PayCallbackLog;
import com.mindbase.pay.model.PayOrder;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Clock;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import java.time.Instant;
import java.time.ZoneId;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.Mockito.mock;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** Payment callback idempotency: conditional-update outcome, amount comparison, notification after close, duplicate notification. */
@ExtendWith(MockitoExtension.class)
class PaymentServiceTest {

    @Mock
    private PayOrderMapper orderMapper;
    @Mock
    private PayCallbackLogMapper callbackLogMapper;
    @Mock
    private DeliveryService deliveryService;
    @Mock
    private RefundService refundService;
    @Mock
    private MembershipService membershipService;
    @Mock
    private PayAuditLogger audit;
    @Mock
    private PayMetrics metrics;

    private PaymentService service;

    @BeforeEach
    void setUp() {
        Clock clock = Clock.fixed(Instant.parse("2026-09-06T04:00:00Z"), ZoneId.of("Asia/Shanghai"));
        service = new PaymentService(orderMapper, callbackLogMapper, deliveryService, refundService,
                membershipService, audit, metrics, clock, new TransactionTemplate(mock(PlatformTransactionManager.class)));
    }

    @Test
    void missingAmountIsRejectedNotSilentlyAccepted() {
        when(orderMapper.selectOne(any(Wrapper.class)))
                .thenReturn(order(PayOrder.OrderStatus.CREATED));

        assertThatThrownBy(() -> service.handleChannelPaid("PO1", PayOrder.PayChannel.ALIPAY,
                "ALI-1", null, "{}", PayCallbackLog.SignatureResult.VALID, null, null))
                .isInstanceOf(com.mindbase.pay.common.ApiException.class)
                .hasMessageContaining("amount");
        verify(orderMapper, never()).markPaid(anyString(), anyString(), any());
    }

    private PayOrder order(PayOrder.OrderStatus status) {
        PayOrder order = new PayOrder();
        order.setOrderNo("PO1");
        order.setUid(10086L);
        order.setAmountCents(1800L);
        order.setDurationDays(30);
        order.setStatus(status);
        return order;
    }

    @Test
    void markPaidWinsThenDelivers() {
        when(orderMapper.selectOne(any(Wrapper.class)))
                .thenReturn(order(PayOrder.OrderStatus.CREATED));
        when(orderMapper.markPaid(eq("PO1"), anyString(), any())).thenReturn(1);

        PayOrder result = service.handleChannelPaid("PO1", PayOrder.PayChannel.MOCK, "MOCK-1",
                1800L, "{}", PayCallbackLog.SignatureResult.SKIPPED, null, null);

        // After successful delivery the in-memory object is filled with DELIVERED, no re-query needed
        assertThat(result.getStatus()).isEqualTo(PayOrder.OrderStatus.DELIVERED);
        verify(deliveryService).deliverOrder(any(PayOrder.class));
        verify(callbackLogMapper, times(1)).insert(any(PayCallbackLog.class));
    }

    @Test
    void duplicateWhilePaidTriggersHealingDelivery() {
        // Duplicate callback = self-healing trigger: when delivery was interrupted (stuck in PAID), the resend immediately retries delivery
        when(orderMapper.selectOne(any(Wrapper.class)))
                .thenReturn(order(PayOrder.OrderStatus.PAID))
                .thenReturn(order(PayOrder.OrderStatus.PAID))
                .thenReturn(order(PayOrder.OrderStatus.DELIVERED));
        when(orderMapper.markPaid(eq("PO1"), anyString(), any())).thenReturn(0);

        PayOrder result = service.handleChannelPaid("PO1", PayOrder.PayChannel.MOCK, "MOCK-1",
                1800L, "{}", PayCallbackLog.SignatureResult.SKIPPED, null, null);

        assertThat(result.getStatus()).isEqualTo(PayOrder.OrderStatus.DELIVERED);
        verify(deliveryService).deliverOrder(any(PayOrder.class));
    }

    @Test
    void duplicateWhileDeliveredIsPureNoop() {
        when(orderMapper.selectOne(any(Wrapper.class)))
                .thenReturn(order(PayOrder.OrderStatus.DELIVERED));
        when(orderMapper.markPaid(eq("PO1"), anyString(), any())).thenReturn(0);

        PayOrder result = service.handleChannelPaid("PO1", PayOrder.PayChannel.MOCK, "MOCK-1",
                1800L, "{}", PayCallbackLog.SignatureResult.SKIPPED, null, null);

        assertThat(result.getStatus()).isEqualTo(PayOrder.OrderStatus.DELIVERED);
        verify(deliveryService, never()).deliverOrder(any(com.mindbase.pay.model.PayOrder.class));
    }

    @Test
    void paidAfterCloseReopensAndDelivers() {
        when(orderMapper.selectOne(any(Wrapper.class)))
                .thenReturn(order(PayOrder.OrderStatus.CLOSED))
                .thenReturn(order(PayOrder.OrderStatus.CLOSED))
                .thenReturn(order(PayOrder.OrderStatus.DELIVERED));
        when(orderMapper.markPaid(eq("PO1"), anyString(), any())).thenReturn(0);
        when(orderMapper.markPaidAfterClose(eq("PO1"), anyString(), any())).thenReturn(1);

        PayOrder result = service.handleChannelPaid("PO1", PayOrder.PayChannel.MOCK, "MOCK-1",
                1800L, "{}", PayCallbackLog.SignatureResult.SKIPPED, null, null);

        // The money was received: payment after close automatically reopens and delivers the order; the M4 refund path handles the reverse
        assertThat(result.getStatus()).isEqualTo(PayOrder.OrderStatus.DELIVERED);
        verify(deliveryService).deliverOrder(any(PayOrder.class));
        verify(callbackLogMapper, times(1)).insert(any(PayCallbackLog.class));
    }

    @Test
    void amountMismatchIsRejectedBeforeMarkPaid() {
        when(orderMapper.selectOne(any(Wrapper.class)))
                .thenReturn(order(PayOrder.OrderStatus.CREATED));

        assertThatThrownBy(() -> service.handleChannelPaid("PO1", PayOrder.PayChannel.WECHAT_PAY,
                "WX-1", 999L, "{}", PayCallbackLog.SignatureResult.VALID, null, null))
                .isInstanceOf(com.mindbase.pay.common.ApiException.class)
                .hasMessageContaining("amount does not match");
        verify(orderMapper, never()).markPaid(anyString(), anyString(), any());
        verify(deliveryService, never()).deliverOrder(any(com.mindbase.pay.model.PayOrder.class));
    }

    @Test
    void duplicateWhileRefundingIsAckedWithoutDelivery() {
        // REFUNDING is owned by the refund flow: a duplicate paid notification is acked as a duplicate
        // (no delivery, no exception -> the channel stops retrying)
        PayOrder refunding = order(PayOrder.OrderStatus.REFUNDING);
        when(orderMapper.selectOne(any(Wrapper.class)))
                .thenReturn(refunding)
                .thenReturn(refunding);
        when(orderMapper.markPaid(eq("PO1"), anyString(), any())).thenReturn(0);

        PayOrder result = service.handleChannelPaid("PO1", PayOrder.PayChannel.MOCK, "MOCK-1",
                1800L, "{}", PayCallbackLog.SignatureResult.SKIPPED, null, null);

        assertThat(result.getStatus()).isEqualTo(PayOrder.OrderStatus.REFUNDING);
        verify(deliveryService, never()).deliverOrder(any(PayOrder.class));
        verify(callbackLogMapper).insert(any(PayCallbackLog.class));
    }

    @Test
    void duplicatePurchaseAutoRefundFailureFreezesOrderNotDelivered() {
        // "Second wall": when auto-refund fails for a duplicate-purchase order, the order is frozen as
        // REFUND_HOLD -- the delivery compensation path (retry job / self-heal) only picks PAID orders,
        // so the freeze must be real, and the exception prevents acking success
        PayOrder vipOrder = order(PayOrder.OrderStatus.CREATED);
        vipOrder.setTier("VIP");
        when(orderMapper.selectOne(any(Wrapper.class))).thenReturn(vipOrder);
        when(orderMapper.markPaid(eq("PO1"), anyString(), any())).thenReturn(1);
        when(membershipService.activeTierRank(10086L)).thenReturn(2); // SVIP 现役
        when(refundService.refund(eq("PO1"), anyString(), eq(false)))
                .thenThrow(new RuntimeException("channel down"));
        when(orderMapper.markRefundHold(eq("PO1"), any())).thenReturn(1);

        assertThatThrownBy(() -> service.handleChannelPaid("PO1", PayOrder.PayChannel.MOCK, "MOCK-1",
                1800L, "{}", PayCallbackLog.SignatureResult.SKIPPED, null, null))
                .isInstanceOf(com.mindbase.pay.common.ApiException.class)
                .hasMessageContaining("frozen");

        verify(deliveryService, never()).deliverOrder(any(PayOrder.class));
        verify(orderMapper).markRefundHold(eq("PO1"), any());
    }

    @Test
    void upgradeOrderDeliversWithoutSecondWall() {
        // 升级换购单：同档按设计交付（差价已折算），第二道墙豁免
        PayOrder order = order(PayOrder.OrderStatus.CREATED);
        order.setTier("SVIP");
        order.setUpgradeFromOrderNo("PO-BASE");
        when(orderMapper.selectOne(any(Wrapper.class))).thenReturn(order);
        when(orderMapper.markPaid(eq("PO1"), anyString(), any())).thenReturn(1);

        PayOrder result = service.handleChannelPaid("PO1", PayOrder.PayChannel.MOCK, "MOCK-1",
                1800L, "{}", PayCallbackLog.SignatureResult.SKIPPED, null, null);

        assertThat(result.getStatus()).isEqualTo(PayOrder.OrderStatus.DELIVERED);
        verify(deliveryService).deliverOrder(any(PayOrder.class));
        verify(refundService, never()).refund(anyString(), anyString(), anyBoolean());
    }

    @Test
    void unknownOrderIsNotFound() {
        when(orderMapper.selectOne(any(Wrapper.class))).thenReturn(null);

        assertThatThrownBy(() -> service.handleChannelPaid("PO404", PayOrder.PayChannel.MOCK,
                "MOCK-1", null, "{}", PayCallbackLog.SignatureResult.SKIPPED, null, null))
                .isInstanceOf(com.mindbase.pay.common.ApiException.class)
                .hasMessageContaining("not found");
        verify(orderMapper, never()).markPaid(anyString(), anyString(), any());
        verify(callbackLogMapper).insert(any(PayCallbackLog.class));
    }
}
