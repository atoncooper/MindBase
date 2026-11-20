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
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Payment callback idempotency + 唯一交付入口语义：条件更新结果、金额比较、关单后补付、
 * 重复通知自愈，以及 TIER_BLOCKED（重复购买/降档）统一自动退款。
 */
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
    private PayAuditLogger audit;
    @Mock
    private PayMetrics metrics;

    private PaymentService service;

    @BeforeEach
    void setUp() {
        Clock clock = Clock.fixed(Instant.parse("2026-09-06T04:00:00Z"), ZoneId.of("Asia/Shanghai"));
        service = new PaymentService(orderMapper, callbackLogMapper, deliveryService, refundService,
                audit, metrics, clock, new TransactionTemplate(mock(PlatformTransactionManager.class)));
        // 默认交付成功；个别用例覆盖为 TIER_BLOCKED / 异常
        lenient().when(deliveryService.deliverOrder(any(PayOrder.class)))
                .thenReturn(DeliveryService.DeliveryResult.DELIVERED);
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
    void missingAmountIsRejectedNotSilentlyAccepted() {
        when(orderMapper.selectOne(any(Wrapper.class)))
                .thenReturn(order(PayOrder.OrderStatus.CREATED));

        assertThatThrownBy(() -> service.handleChannelPaid("PO1", PayOrder.PayChannel.ALIPAY,
                "ALI-1", null, "{}", PayCallbackLog.SignatureResult.VALID, null, null))
                .isInstanceOf(com.mindbase.pay.common.ApiException.class)
                .hasMessageContaining("amount");
        verify(orderMapper, never()).markPaid(anyString(), anyString(), any());
        // 金额缺失也是资金差异事件，必须进同一指标
        verify(metrics).callbackAmountMismatch();
    }

    @Test
    void markPaidWinsThenDelivers() {
        when(orderMapper.selectOne(any(Wrapper.class)))
                .thenReturn(order(PayOrder.OrderStatus.CREATED));
        when(orderMapper.markPaid(eq("PO1"), anyString(), any())).thenReturn(1);

        PayOrder result = service.handleChannelPaid("PO1", PayOrder.PayChannel.MOCK, "MOCK-1",
                1800L, "{}", PayCallbackLog.SignatureResult.SKIPPED, null, null);

        assertThat(result.getStatus()).isEqualTo(PayOrder.OrderStatus.DELIVERED);
        verify(deliveryService).deliverOrder(any(PayOrder.class));
        verify(callbackLogMapper, times(1)).insert(any(PayCallbackLog.class));
    }

    @Test
    void duplicateWhilePaidTriggersHealingDelivery() {
        // 重复回调 = 自愈触发器：上次交付中断（停在 PAID）时，重复通知立即补交付
        when(orderMapper.selectOne(any(Wrapper.class)))
                .thenReturn(order(PayOrder.OrderStatus.PAID))
                .thenReturn(order(PayOrder.OrderStatus.PAID));
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
        verify(deliveryService, never()).deliverOrder(any(PayOrder.class));
    }

    @Test
    void paidAfterCloseReopensAndDelivers() {
        when(orderMapper.selectOne(any(Wrapper.class)))
                .thenReturn(order(PayOrder.OrderStatus.CLOSED))
                .thenReturn(order(PayOrder.OrderStatus.CLOSED))
                .thenReturn(order(PayOrder.OrderStatus.CLOSED));
        when(orderMapper.markPaid(eq("PO1"), anyString(), any())).thenReturn(0);
        when(orderMapper.markPaidAfterClose(eq("PO1"), anyString(), any())).thenReturn(1);

        PayOrder result = service.handleChannelPaid("PO1", PayOrder.PayChannel.MOCK, "MOCK-1",
                1800L, "{}", PayCallbackLog.SignatureResult.SKIPPED, null, null);

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
        verify(deliveryService, never()).deliverOrder(any(PayOrder.class));
        verify(metrics).callbackAmountMismatch();
    }

    @Test
    void duplicateWhileRefundingIsAckedWithoutDelivery() {
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
    void tierBlockedOrderIsAutoRefundedByDeliveryEntry() {
        // 唯一交付入口判定重复购买 → 冻结 + 本类统一自动退款；不再依赖“首次回调路径才做墙”
        PayOrder vipOrder = order(PayOrder.OrderStatus.CREATED);
        vipOrder.setTier("VIP");
        when(orderMapper.selectOne(any(Wrapper.class))).thenReturn(vipOrder);
        when(orderMapper.markPaid(eq("PO1"), anyString(), any())).thenReturn(1);
        when(deliveryService.deliverOrder(any(PayOrder.class)))
                .thenReturn(DeliveryService.DeliveryResult.TIER_BLOCKED);
        when(refundService.refund(eq("PO1"), anyString(), eq(false)))
                .thenReturn(order(PayOrder.OrderStatus.REFUNDED));

        service.handleChannelPaid("PO1", PayOrder.PayChannel.MOCK, "MOCK-1",
                1800L, "{}", PayCallbackLog.SignatureResult.SKIPPED, null, null);

        verify(refundService).refund(eq("PO1"), anyString(), eq(false));
        verify(metrics).autoRefund();
    }

    @Test
    void autoRefundFailureFreezesOrderNotDelivered() {
        PayOrder vipOrder = order(PayOrder.OrderStatus.CREATED);
        vipOrder.setTier("VIP");
        when(orderMapper.selectOne(any(Wrapper.class))).thenReturn(vipOrder);
        when(orderMapper.markPaid(eq("PO1"), anyString(), any())).thenReturn(1);
        when(deliveryService.deliverOrder(any(PayOrder.class)))
                .thenReturn(DeliveryService.DeliveryResult.TIER_BLOCKED);
        when(refundService.refund(eq("PO1"), anyString(), eq(false)))
                .thenThrow(new RuntimeException("channel down"));

        assertThatThrownBy(() -> service.handleChannelPaid("PO1", PayOrder.PayChannel.MOCK, "MOCK-1",
                1800L, "{}", PayCallbackLog.SignatureResult.SKIPPED, null, null))
                .isInstanceOf(com.mindbase.pay.common.ApiException.class)
                .hasMessageContaining("frozen");

        verify(metrics).autoRefundFailed();
    }

    @Test
    void upgradeOrderDeliversWithoutTierWall() {
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
    void skippedDeliveryReloadsFreshStatus() {
        // 并发方已经交付/退款（markDelivered 未命中）：返回数据库最新状态，而不是乐观地把内存对象标成 DELIVERED
        when(orderMapper.selectOne(any(Wrapper.class)))
                .thenReturn(order(PayOrder.OrderStatus.CREATED))
                .thenReturn(order(PayOrder.OrderStatus.DELIVERED));
        when(orderMapper.markPaid(eq("PO1"), anyString(), any())).thenReturn(1);
        when(deliveryService.deliverOrder(any(PayOrder.class)))
                .thenReturn(DeliveryService.DeliveryResult.SKIPPED);

        PayOrder result = service.handleChannelPaid("PO1", PayOrder.PayChannel.MOCK, "MOCK-1",
                1800L, "{}", PayCallbackLog.SignatureResult.SKIPPED, null, null);

        assertThat(result.getStatus()).isEqualTo(PayOrder.OrderStatus.DELIVERED);
    }

    @Test
    void selfHealDuplicatePaidTierBlockedAlsoAutoRefunds() {
        // 重复回调自愈路径（已 PAID）同样走唯一交付入口：违规单必须冻结并自动退款，不能借自愈路径交付
        PayOrder paid = order(PayOrder.OrderStatus.PAID);
        paid.setTier("VIP");
        PayOrder refunded = order(PayOrder.OrderStatus.REFUNDED);
        when(orderMapper.selectOne(any(Wrapper.class)))
                .thenReturn(paid)
                .thenReturn(paid)
                .thenReturn(refunded);
        when(orderMapper.markPaid(eq("PO1"), anyString(), any())).thenReturn(0);
        when(deliveryService.deliverOrder(any(PayOrder.class)))
                .thenReturn(DeliveryService.DeliveryResult.TIER_BLOCKED);
        when(refundService.refund(eq("PO1"), anyString(), eq(false))).thenReturn(refunded);

        PayOrder result = service.handleChannelPaid("PO1", PayOrder.PayChannel.MOCK, "MOCK-1",
                1800L, "{}", PayCallbackLog.SignatureResult.SKIPPED, null, null);

        assertThat(result.getStatus()).isEqualTo(PayOrder.OrderStatus.REFUNDED);
        verify(refundService).refund(eq("PO1"), anyString(), eq(false));
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
