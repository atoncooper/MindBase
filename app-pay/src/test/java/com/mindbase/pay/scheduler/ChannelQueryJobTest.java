package com.mindbase.pay.scheduler;

import com.baomidou.mybatisplus.core.conditions.Wrapper;
import com.mindbase.pay.common.PayMetrics;
import com.mindbase.pay.mapper.PayOrderMapper;
import com.mindbase.pay.model.PayCallbackLog;
import com.mindbase.pay.model.PayOrder;
import com.mindbase.pay.service.PaymentService;
import com.mindbase.pay.service.channel.ChannelQueryResult;
import com.mindbase.pay.service.channel.PayChannelAdapter;
import com.mindbase.pay.service.channel.PayChannelRouter;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.List;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/** Lost-order compensation: query reports paid -> compensate via the unified entry; channel closed -> close locally; mock channel skipped. */
@ExtendWith(MockitoExtension.class)
class ChannelQueryJobTest {

    private static final LocalDateTime NOW = LocalDateTime.of(2026, 9, 6, 12, 0);

    @Mock
    private PayOrderMapper orderMapper;
    @Mock
    private PayChannelRouter channelRouter;
    @Mock
    private PayChannelAdapter alipayAdapter;
    @Mock
    private PaymentService paymentService;
    @Mock
    private JobLease lease;
    @Mock
    private PayMetrics metrics;

    private ChannelQueryJob job;

    @BeforeEach
    void setUp() {
        Clock clock = Clock.fixed(Instant.parse("2026-09-06T04:00:00Z"), ZoneId.of("Asia/Shanghai"));
        job = new ChannelQueryJob(orderMapper, channelRouter, paymentService, lease, metrics, clock);
        when(lease.tryAcquire(anyString())).thenReturn(true);
    }

    @Test
    void leaseHeldElsewhereSkipsEntireround() {
        when(lease.tryAcquire(anyString())).thenReturn(false);
        job.run();
        verifyNoInteractions(orderMapper, paymentService);
    }

    private PayOrder createdOrder(PayOrder.PayChannel channel) {
        PayOrder order = new PayOrder();
        order.setOrderNo("PO1");
        order.setUid(10086L);
        order.setAmountCents(1800L);
        order.setChannel(channel);
        order.setStatus(PayOrder.OrderStatus.CREATED);
        order.setCreatedAt(NOW.minusMinutes(10));
        order.setExpiresAt(NOW.plusMinutes(20));
        return order;
    }

    @Test
    void paidQueryCompensatesViaUnifiedEntry() {
        when(orderMapper.selectList(any(Wrapper.class)))
                .thenReturn(List.of(createdOrder(PayOrder.PayChannel.ALIPAY)));
        when(channelRouter.requireAdapter(PayOrder.PayChannel.ALIPAY)).thenReturn(alipayAdapter);
        when(alipayAdapter.queryOrder(any(PayOrder.class)))
                .thenReturn(ChannelQueryResult.paid("ALI1", 1800L, "buyer@example.com", "2088001"));

        job.run();

        verify(paymentService).handleChannelPaid(eq("PO1"), eq(PayOrder.PayChannel.ALIPAY),
                eq("ALI1"), eq(1800L), anyString(), eq(PayCallbackLog.SignatureResult.VALID),
                eq("buyer@example.com"), eq("2088001"));
    }

    @Test
    void channelClosedCancelsLocally() {
        when(orderMapper.selectList(any(Wrapper.class)))
                .thenReturn(List.of(createdOrder(PayOrder.PayChannel.ALIPAY)));
        when(channelRouter.requireAdapter(PayOrder.PayChannel.ALIPAY)).thenReturn(alipayAdapter);
        when(alipayAdapter.queryOrder(any(PayOrder.class))).thenReturn(ChannelQueryResult.closed("ALI1"));

        job.run();

        verify(orderMapper).closeOrder(eq("PO1"), any(LocalDateTime.class), eq("CHANNEL_CLOSED"));
        verify(paymentService, never()).handleChannelPaid(anyString(), any(), any(), any(),
                anyString(), any(), any(), any());
    }

    @Test
    void mockChannelOrdersSkipped() {
        when(orderMapper.selectList(any(Wrapper.class)))
                .thenReturn(List.of(createdOrder(PayOrder.PayChannel.MOCK)));

        job.run();

        verifyNoInteractions(channelRouter, paymentService);
    }
}
