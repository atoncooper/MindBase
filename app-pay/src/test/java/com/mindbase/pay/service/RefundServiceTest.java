package com.mindbase.pay.service;

import com.baomidou.mybatisplus.core.conditions.Wrapper;
import com.mindbase.pay.common.ApiException;
import com.mindbase.pay.common.PayAuditLogger;
import com.mindbase.pay.common.PayMetrics;
import com.mindbase.pay.config.PayProperties;
import com.mindbase.pay.mapper.PayOrderMapper;
import com.mindbase.pay.model.PayOrder;
import com.mindbase.pay.service.channel.PayChannelAdapter;
import com.mindbase.pay.service.channel.PayChannelRouter;
import com.mindbase.pay.service.channel.RefundResult;
import com.mindbase.pay.testutil.TestPayProperties;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;

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

/** Three-stage refund: accept -> channel -> (in transaction) mark + revoke; rollback on failure; idempotent return; window limit. */
@ExtendWith(MockitoExtension.class)
class RefundServiceTest {

    private static final LocalDateTime NOW = LocalDateTime.of(2026, 9, 6, 12, 0);

    @Mock
    private PayOrderMapper orderMapper;
    @Mock
    private PayChannelRouter channelRouter;
    @Mock
    private MembershipService membershipService;
    @Mock
    private PayAuditLogger audit;
    @Mock
    private PayMetrics metrics;
    @Mock
    private PayChannelAdapter mockAdapter;
    @Mock
    private PlatformTransactionManager txManager;

    private RefundService service;

    @BeforeEach
    void setUp() {
        service = service(TestPayProperties.defaults());
    }

    private RefundService service(PayProperties props) {
        Clock clock = Clock.fixed(Instant.parse("2026-09-06T04:00:00Z"), ZoneId.of("Asia/Shanghai"));
        return new RefundService(orderMapper, channelRouter, membershipService, audit, metrics,
                props, clock, new TransactionTemplate(txManager));
    }

    private PayOrder order(PayOrder.OrderStatus status) {
        PayOrder order = new PayOrder();
        order.setOrderNo("PO1");
        order.setUid(10086L);
        order.setAmountCents(1800L);
        order.setDurationDays(30);
        order.setChannel(PayOrder.PayChannel.MOCK);
        order.setStatus(status);
        order.setPaidAt(NOW.minusDays(1));
        return order;
    }

    @Test
    void deliveredRefundRevokesMembershipAtomically() {
        PayOrder order = order(PayOrder.OrderStatus.DELIVERED);
        when(orderMapper.selectOne(any(Wrapper.class))).thenReturn(order);
        when(orderMapper.markRefunding(eq("PO1"), anyString(), anyString(), any())).thenReturn(1);
        when(channelRouter.requireAdapter(PayOrder.PayChannel.MOCK)).thenReturn(mockAdapter);
        when(mockAdapter.refund(order, "user refund")).thenReturn(RefundResult.success("REF-1"));
        when(orderMapper.markRefunded(eq("PO1"), eq("REF-1"), any())).thenReturn(1);

        PayOrder result = service.refund("PO1", "user refund", true);

        assertThat(result).isSameAs(order);
        verify(membershipService).revoke(10086L, 30, "PO1", "user refund");
        verify(metrics).refundSucceeded();
    }

    @Test
    void channelFailureRevertsForRetry() {
        PayOrder order = order(PayOrder.OrderStatus.DELIVERED);
        when(orderMapper.selectOne(any(Wrapper.class))).thenReturn(order);
        when(orderMapper.markRefunding(eq("PO1"), anyString(), anyString(), any())).thenReturn(1);
        when(channelRouter.requireAdapter(PayOrder.PayChannel.MOCK)).thenReturn(mockAdapter);
        when(mockAdapter.refund(any(PayOrder.class), anyString()))
                .thenReturn(RefundResult.failure("gateway timeout"));
        when(orderMapper.revertRefunding(eq("PO1"), any())).thenReturn(1);

        assertThatThrownBy(() -> service.refund("PO1", "refund", true))
                .isInstanceOf(ApiException.class)
                .extracting(e -> ((ApiException) e).getStatus())
                .isEqualTo(500);
        verify(orderMapper).revertRefunding(eq("PO1"), any());
        verify(metrics).refundFailed();
        verify(membershipService, never()).revoke(anyLong(), anyInt(), anyString(), anyString());
    }

    @Test
    void alreadyRefundedIsIdempotent() {
        when(orderMapper.selectOne(any(Wrapper.class)))
                .thenReturn(order(PayOrder.OrderStatus.REFUNDED));

        PayOrder result = service.refund("PO1", "again", true);

        assertThat(result.getStatus()).isEqualTo(PayOrder.OrderStatus.REFUNDED);
        verify(orderMapper, never()).markRefunding(anyString(), anyString(), anyString(), any());
    }

    @Test
    void stuckRefundingIsResumedWithoutReAccepting() {
        PayOrder order = order(PayOrder.OrderStatus.REFUNDING);
        order.setRefundNo("REF-PO1");
        order.setRefundPrevStatus("DELIVERED");
        when(orderMapper.selectOne(any(Wrapper.class))).thenReturn(order);
        when(channelRouter.requireAdapter(PayOrder.PayChannel.MOCK)).thenReturn(mockAdapter);
        when(mockAdapter.refund(any(PayOrder.class), anyString())).thenReturn(RefundResult.success("REF-1"));
        when(orderMapper.markRefunded(eq("PO1"), eq("REF-1"), any())).thenReturn(1);

        service.refund("PO1", "retry", true);

        verify(orderMapper, never()).markRefunding(anyString(), anyString(), anyString(), any());
        // Resuming must still revoke the membership: the status is already REFUNDING, and refund_prev_status shows it was DELIVERED
        verify(membershipService).revoke(10086L, 30, "PO1", "retry");
    }

    @Test
    void createdOrderIsNotRefundable() {
        when(orderMapper.selectOne(any(Wrapper.class)))
                .thenReturn(order(PayOrder.OrderStatus.CREATED));

        assertThatThrownBy(() -> service.refund("PO1", "x", true))
                .isInstanceOf(ApiException.class)
                .extracting(e -> ((ApiException) e).getStatus())
                .isEqualTo(409);
    }

    @Test
    void outsideRefundWindowIsRejected() {
        PayOrder order = order(PayOrder.OrderStatus.DELIVERED);
        order.setPaidAt(NOW.minusDays(400));
        when(orderMapper.selectOne(any(Wrapper.class))).thenReturn(order);

        assertThatThrownBy(() -> service.refund("PO1", "x", true))
                .isInstanceOf(ApiException.class)
                .hasMessageContaining("refundable window");
    }

    @Test
    void disabledRefundHidesEndpoint() {
        RefundService disabled = service(TestPayProperties.builder()
                .refund(new PayProperties.Refund(false, 365)).build());

        assertThatThrownBy(() -> disabled.refund("PO1", "x", true))
                .isInstanceOf(ApiException.class)
                .extracting(e -> ((ApiException) e).getStatus())
                .isEqualTo(404);
    }
}
