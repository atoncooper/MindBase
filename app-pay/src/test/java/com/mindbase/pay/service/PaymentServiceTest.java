package com.mindbase.pay.service;

import com.baomidou.mybatisplus.core.conditions.Wrapper;
import com.mindbase.pay.common.PayAuditLogger;
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
import java.time.Instant;
import java.time.ZoneId;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** 支付回调幂等：条件更新胜负、金额比对、关单后通知、重复通知。 */
@ExtendWith(MockitoExtension.class)
class PaymentServiceTest {

    @Mock
    private PayOrderMapper orderMapper;
    @Mock
    private PayCallbackLogMapper callbackLogMapper;
    @Mock
    private DeliveryService deliveryService;
    @Mock
    private PayAuditLogger audit;

    private PaymentService service;

    @BeforeEach
    void setUp() {
        Clock clock = Clock.fixed(Instant.parse("2026-09-06T04:00:00Z"), ZoneId.of("Asia/Shanghai"));
        service = new PaymentService(orderMapper, callbackLogMapper, deliveryService, audit, clock);
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
                1800L, "{}", PayCallbackLog.SignatureResult.SKIPPED);

        // 交付成功后内存回填 DELIVERED，无需回查
        assertThat(result.getStatus()).isEqualTo(PayOrder.OrderStatus.DELIVERED);
        verify(deliveryService).deliverOrder(any(PayOrder.class));
        verify(callbackLogMapper, times(1)).insert(any(PayCallbackLog.class));
    }

    @Test
    void duplicateWhilePaidTriggersHealingDelivery() {
        // 回调重发 = 自愈触发器：交付中断（卡 PAID）时借重发立即补交付
        when(orderMapper.selectOne(any(Wrapper.class)))
                .thenReturn(order(PayOrder.OrderStatus.PAID))
                .thenReturn(order(PayOrder.OrderStatus.PAID))
                .thenReturn(order(PayOrder.OrderStatus.DELIVERED));
        when(orderMapper.markPaid(eq("PO1"), anyString(), any())).thenReturn(0);

        PayOrder result = service.handleChannelPaid("PO1", PayOrder.PayChannel.MOCK, "MOCK-1",
                1800L, "{}", PayCallbackLog.SignatureResult.SKIPPED);

        assertThat(result.getStatus()).isEqualTo(PayOrder.OrderStatus.DELIVERED);
        verify(deliveryService).deliverOrder(any(PayOrder.class));
    }

    @Test
    void duplicateWhileDeliveredIsPureNoop() {
        when(orderMapper.selectOne(any(Wrapper.class)))
                .thenReturn(order(PayOrder.OrderStatus.DELIVERED));
        when(orderMapper.markPaid(eq("PO1"), anyString(), any())).thenReturn(0);

        PayOrder result = service.handleChannelPaid("PO1", PayOrder.PayChannel.MOCK, "MOCK-1",
                1800L, "{}", PayCallbackLog.SignatureResult.SKIPPED);

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
                1800L, "{}", PayCallbackLog.SignatureResult.SKIPPED);

        // 钱已收是事实：关单后到账自动补单 reopen 并交付，M4 退款路径负责逆向
        assertThat(result.getStatus()).isEqualTo(PayOrder.OrderStatus.DELIVERED);
        verify(deliveryService).deliverOrder(any(PayOrder.class));
        verify(callbackLogMapper, times(1)).insert(any(PayCallbackLog.class));
    }

    @Test
    void amountMismatchIsRejectedBeforeMarkPaid() {
        when(orderMapper.selectOne(any(Wrapper.class)))
                .thenReturn(order(PayOrder.OrderStatus.CREATED));

        assertThatThrownBy(() -> service.handleChannelPaid("PO1", PayOrder.PayChannel.WECHAT_PAY,
                "WX-1", 999L, "{}", PayCallbackLog.SignatureResult.VALID))
                .isInstanceOf(com.mindbase.pay.common.ApiException.class)
                .hasMessageContaining("amount does not match");
        verify(orderMapper, never()).markPaid(anyString(), anyString(), any());
        verify(deliveryService, never()).deliverOrder(any(com.mindbase.pay.model.PayOrder.class));
    }

    @Test
    void unknownOrderIsNotFound() {
        when(orderMapper.selectOne(any(Wrapper.class))).thenReturn(null);

        assertThatThrownBy(() -> service.handleChannelPaid("PO404", PayOrder.PayChannel.MOCK,
                "MOCK-1", null, "{}", PayCallbackLog.SignatureResult.SKIPPED))
                .isInstanceOf(com.mindbase.pay.common.ApiException.class)
                .hasMessageContaining("not found");
        verify(orderMapper, never()).markPaid(anyString(), anyString(), any());
        verify(callbackLogMapper).insert(any(PayCallbackLog.class));
    }
}
