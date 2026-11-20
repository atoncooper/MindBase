package com.mindbase.pay.service;

import com.baomidou.mybatisplus.core.conditions.Wrapper;
import com.mindbase.pay.common.ApiException;
import com.mindbase.pay.common.PayAuditLogger;
import com.mindbase.pay.mapper.PayGrantIdempotencyMapper;
import com.mindbase.pay.mapper.PayMembershipEventMapper;
import com.mindbase.pay.model.PayGrantIdempotency;
import com.mindbase.pay.model.PayMembership;
import com.mindbase.pay.model.PayMembershipEvent;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.dao.DuplicateKeyException;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * ADMIN_GRANT 幂等：同一 requestId 的事件已存在 / 幂等占位冲突 => 返回当前会员态且不再加天数；
 * 正常路径先占位、再原子占用额度、再扩展会员。
 */
@ExtendWith(MockitoExtension.class)
class GrantServiceTest {

    @Mock
    private PayGrantIdempotencyMapper idempotencyMapper;
    @Mock
    private PayMembershipEventMapper eventMapper;
    @Mock
    private GrantQuotaService quotaService;
    @Mock
    private MembershipService membershipService;
    @Mock
    private PayAuditLogger audit;

    private GrantService service;

    @BeforeEach
    void setUp() {
        Clock clock = Clock.fixed(Instant.parse("2026-09-06T04:00:00Z"), ZoneId.of("Asia/Shanghai"));
        service = new GrantService(idempotencyMapper, eventMapper, quotaService, membershipService, audit, clock);
    }

    private PayMembership membership() {
        PayMembership m = new PayMembership();
        m.setUid(10086L);
        m.setTier("VIP");
        return m;
    }

    @Test
    void eventAlreadyExistsIsIdempotentHit() {
        PayMembershipEvent processed = new PayMembershipEvent();
        processed.setRequestId("req-1");
        when(eventMapper.selectOne(any(Wrapper.class))).thenReturn(processed);
        when(membershipService.findByUid(10086L)).thenReturn(Optional.of(membership()));

        PayMembership result = service.grant(10086L, 30, "compensation", "VIP", "req-1");

        assertThat(result.getTier()).isEqualTo("VIP");
        verify(quotaService, never()).reserve(anyInt());
        verify(membershipService, never()).extend(anyLong(), anyInt(), any(), any(), any(), any(), anyString());
    }

    @Test
    void concurrentMarkerConflictIsIdempotentHit() {
        when(eventMapper.selectOne(any(Wrapper.class))).thenReturn(null);
        when(idempotencyMapper.insert(any(PayGrantIdempotency.class)))
                .thenThrow(new DuplicateKeyException("uk_pay_grant_idempotency"));
        when(membershipService.findByUid(10086L)).thenReturn(Optional.of(membership()));

        PayMembership result = service.grant(10086L, 30, "compensation", "VIP", "req-1");

        assertThat(result).isNotNull();
        verify(quotaService, never()).reserve(anyInt());
    }

    @Test
    void normalGrantReservesQuotaThenExtends() {
        when(eventMapper.selectOne(any(Wrapper.class))).thenReturn(null);
        when(idempotencyMapper.insert(any(PayGrantIdempotency.class))).thenReturn(1);
        when(membershipService.extend(eq(10086L), eq(30), isNull(), eq(PayMembershipEvent.EventType.ADMIN_GRANT),
                anyString(), eq("VIP"), eq("req-1"))).thenReturn(membership());

        PayMembership result = service.grant(10086L, 30, "compensation", "VIP", "req-1");

        assertThat(result.getTier()).isEqualTo("VIP");
        verify(quotaService).reserve(30);
        verify(membershipService).extend(eq(10086L), eq(30), isNull(),
                eq(PayMembershipEvent.EventType.ADMIN_GRANT), anyString(), eq("VIP"), eq("req-1"));
    }

    @Test
    void grantWithoutRequestIdSkipsMarkerAndReservesQuota() {
        when(membershipService.extend(eq(10086L), eq(30), isNull(),
                eq(PayMembershipEvent.EventType.ADMIN_GRANT), anyString(), eq("VIP"), isNull()))
                .thenReturn(membership());

        PayMembership result = service.grant(10086L, 30, "compensation", "VIP", "  ");

        assertThat(result.getTier()).isEqualTo("VIP");
        verify(idempotencyMapper, never()).insert(any(PayGrantIdempotency.class));
        verify(quotaService).reserve(30);
        verify(membershipService).extend(eq(10086L), eq(30), isNull(),
                eq(PayMembershipEvent.EventType.ADMIN_GRANT), anyString(), eq("VIP"), isNull());
    }

    @Test
    void quotaRejectionAbortsBeforeMembershipExtension() {
        when(idempotencyMapper.insert(any(PayGrantIdempotency.class))).thenReturn(1);
        doThrow(ApiException.tooManyRequests("GRANT_DAILY_COUNT_EXCEEDED", "limit"))
                .when(quotaService).reserve(30);

        org.assertj.core.api.Assertions.assertThatThrownBy(
                        () -> service.grant(10086L, 30, "compensation", "VIP", "req-1"))
                .isInstanceOf(ApiException.class)
                .extracting(e -> ((ApiException) e).getStatus())
                .isEqualTo(429);

        verify(membershipService, never()).extend(anyLong(), anyInt(), any(), any(), any(), any(), anyString());
    }

    @Test
    void idempotentHitWithoutMembershipThrowsConflict() {
        PayMembershipEvent processed = new PayMembershipEvent();
        processed.setRequestId("req-1");
        when(eventMapper.selectOne(any(Wrapper.class))).thenReturn(processed);
        when(membershipService.findByUid(10086L)).thenReturn(Optional.empty());

        org.assertj.core.api.Assertions.assertThatThrownBy(
                        () -> service.grant(10086L, 30, "compensation", "VIP", "req-1"))
                .isInstanceOf(ApiException.class);
    }
}
