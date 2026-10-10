package com.mindbase.pay.scheduler;

import com.mindbase.pay.mapper.PayJobLockMapper;
import com.mindbase.pay.testutil.TestPayProperties;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** Cross-instance lease: take over expired / insert first / already held by another / fail open when the table errors (correctness does not depend on the lease). */
@ExtendWith(MockitoExtension.class)
class JobLeaseTest {

    @Mock
    private PayJobLockMapper lockMapper;

    private JobLease lease;

    @BeforeEach
    void setUp() {
        Clock clock = Clock.fixed(Instant.parse("2026-09-06T04:00:00Z"), ZoneId.of("Asia/Shanghai"));
        lease = new JobLease(lockMapper, TestPayProperties.defaults(), clock);
    }

    @Test
    void acquiresByTakingOverExpiredLease() {
        when(lockMapper.tryTakeOver(anyString(), anyString(), any(), any())).thenReturn(1);
        assertThat(lease.tryAcquire("order-timeout")).isTrue();
        verify(lockMapper, never()).tryInsert(anyString(), anyString(), any(), any());
    }

    @Test
    void acquiresByInsertingFirstLease() {
        when(lockMapper.tryTakeOver(anyString(), anyString(), any(), any())).thenReturn(0);
        when(lockMapper.tryInsert(anyString(), anyString(), any(), any())).thenReturn(1);
        assertThat(lease.tryAcquire("order-timeout")).isTrue();
    }

    @Test
    void deniesWhenAnotherInstanceHoldsLease() {
        when(lockMapper.tryTakeOver(anyString(), anyString(), any(), any())).thenReturn(0);
        when(lockMapper.tryInsert(anyString(), anyString(), any(), any())).thenReturn(0);
        assertThat(lease.tryAcquire("order-timeout")).isFalse();
    }

    @Test
    void failsOpenWhenLeaseTableUnavailable() {
        // A lease-table error must not stall the fallback job: let this instance through, correctness is still guaranteed by conditional updates
        when(lockMapper.tryTakeOver(anyString(), anyString(), any(), any()))
                .thenThrow(new RuntimeException("db down"));
        assertThat(lease.tryAcquire("order-timeout")).isTrue();
    }

    @Test
    void leaseUntilIsInTheFuture() {
        when(lockMapper.tryTakeOver(anyString(), anyString(), any(), any())).thenReturn(1);
        lease.tryAcquire("x");
        LocalDateTime expectedUntil = LocalDateTime.of(2026, 9, 6, 12, 0).plusSeconds(900);
        verify(lockMapper).tryTakeOver(anyString(), anyString(),
                org.mockito.ArgumentMatchers.eq(expectedUntil), any());
    }
}
