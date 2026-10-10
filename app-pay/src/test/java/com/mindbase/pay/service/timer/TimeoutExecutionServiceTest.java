package com.mindbase.pay.service.timer;

import com.baomidou.mybatisplus.core.conditions.Wrapper;
import com.mindbase.pay.common.PayAuditLogger;
import com.mindbase.pay.mapper.PayOrderMapper;
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
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** Timeout delegation executor four branches: match closes the order / version discarded / status skipped / ghost task. */
@ExtendWith(MockitoExtension.class)
class TimeoutExecutionServiceTest {

    @Mock
    private PayOrderMapper orderMapper;
    @Mock
    private PayAuditLogger audit;

    private TimeoutExecutionService service;

    @BeforeEach
    void setUp() {
        Clock clock = Clock.fixed(Instant.parse("2026-09-06T04:00:00Z"), ZoneId.of("Asia/Shanghai"));
        service = new TimeoutExecutionService(orderMapper, audit, clock);
    }

    private PayOrder order(PayOrder.OrderStatus status, int version) {
        PayOrder order = new PayOrder();
        order.setOrderNo("PO1");
        order.setUid(10086L);
        order.setStatus(status);
        order.setVersion(version);
        return order;
    }

    @Test
    void versionMatchClosesOrderAndAudits() {
        when(orderMapper.closeOrderAtVersion(eq("PO1"), eq(1), any())).thenReturn(1);

        ExecuteResult result = service.execute(new TimeoutCommand("PO1", 1));

        assertThat(result.executed()).isTrue();
        verify(audit).audit(eq("ORDER_CLOSED_TIMEOUT"), eq("order_no"), eq("PO1"),
                eq("version"), eq(1), any(), any());
    }

    @Test
    void versionMismatchMeansAlreadyPaidDelegateDiscarded() {
        when(orderMapper.closeOrderAtVersion(eq("PO1"), eq(1), any())).thenReturn(0);
        when(orderMapper.selectOne(any(Wrapper.class)))
                .thenReturn(order(PayOrder.OrderStatus.CREATED, 2));

        ExecuteResult result = service.execute(new TimeoutCommand("PO1", 1));

        // Core of the design: the registered delegation is v1, the order advanced to v2 (paid), so the delegation is void
        assertThat(result.executed()).isFalse();
        assertThat(result.reason()).isEqualTo("SKIP_VERSION_MISMATCH");
    }

    @Test
    void nonCreatedStatusIsSkipped() {
        when(orderMapper.closeOrderAtVersion(eq("PO1"), eq(1), any())).thenReturn(0);
        when(orderMapper.selectOne(any(Wrapper.class)))
                .thenReturn(order(PayOrder.OrderStatus.DELIVERED, 3));

        ExecuteResult result = service.execute(new TimeoutCommand("PO1", 1));

        assertThat(result.executed()).isFalse();
        assertThat(result.reason()).isEqualTo("SKIP_STATUS:DELIVERED");
    }

    @Test
    void unknownOrderIsGracefulSkip() {
        when(orderMapper.closeOrderAtVersion(eq("PO1"), eq(1), any())).thenReturn(0);
        when(orderMapper.selectOne(any(Wrapper.class))).thenReturn(null);

        ExecuteResult result = service.execute(new TimeoutCommand("PO1", 1));

        assertThat(result.executed()).isFalse();
        assertThat(result.reason()).isEqualTo("ORDER_NOT_FOUND");
        org.mockito.Mockito.verifyNoInteractions(audit);
    }
}
