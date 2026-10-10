package com.mindbase.pay.service;

import com.mindbase.pay.common.PayAuditLogger;
import com.mindbase.pay.mapper.PayMembershipEventMapper;
import com.mindbase.pay.mapper.PayMembershipMapper;
import com.mindbase.pay.model.PayMembership;
import com.mindbase.pay.model.PayMembershipEvent;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** Membership extension rules: first activation / renewal stacking while active / restart from now after expiry / admin grant event types. */
@ExtendWith(MockitoExtension.class)
class MembershipServiceTest {

    private static final LocalDateTime NOW = LocalDateTime.of(2026, 9, 6, 12, 0);

    @Mock
    private PayMembershipMapper membershipMapper;
    @Mock
    private PayMembershipEventMapper eventMapper;
    @Mock
    private PayAuditLogger audit;

    private MembershipService service;

    @BeforeEach
    void setUp() {
        Clock clock = Clock.fixed(Instant.parse("2026-09-06T04:00:00Z"), ZoneId.of("Asia/Shanghai"));
        service = new MembershipService(membershipMapper, eventMapper, audit, clock);
    }

    @Test
    void firstTimeActivateStartsFromNow() {
        when(membershipMapper.selectByUidForUpdate(10086L)).thenReturn(null);

        PayMembership result = service.extend(10086L, 30, "PO1", null, null);

        assertThat(result.getExpireAt()).isEqualTo(NOW.plusDays(30));
        assertThat(result.getTier()).isEqualTo("VIP");
        verify(membershipMapper).insert(result);
        PayMembershipEvent event = capturedEvent();
        assertThat(event.getType()).isEqualTo(PayMembershipEvent.EventType.ACTIVATE);
        assertThat(event.getExpireBefore()).isEqualTo(NOW);
        assertThat(event.getExpireAfter()).isEqualTo(NOW.plusDays(30));
    }

    @Test
    void renewWhileActiveExtendsFromExpireAt() {
        PayMembership existing = new PayMembership();
        existing.setId(1L);
        existing.setUid(10086L);
        existing.setExpireAt(NOW.plusDays(10));
        when(membershipMapper.selectByUidForUpdate(10086L)).thenReturn(existing);

        PayMembership result = service.extend(10086L, 30, "PO2", null, null);

        // Renewal before expiry: stack onto the current expire time rather than starting from now
        assertThat(result.getExpireAt()).isEqualTo(NOW.plusDays(40));
        verify(membershipMapper).updateById(result);
        assertThat(capturedEvent().getType()).isEqualTo(PayMembershipEvent.EventType.RENEW);
    }

    @Test
    void renewAfterExpiryStartsFromNow() {
        PayMembership expired = new PayMembership();
        expired.setId(1L);
        expired.setUid(10086L);
        expired.setExpireAt(NOW.minusDays(20));
        when(membershipMapper.selectByUidForUpdate(10086L)).thenReturn(expired);

        PayMembership result = service.extend(10086L, 30, "PO3", null, null);

        assertThat(result.getExpireAt()).isEqualTo(NOW.plusDays(30));
        assertThat(capturedEvent().getType()).isEqualTo(PayMembershipEvent.EventType.ACTIVATE);
    }

    @Test
    void adminGrantKeepsExplicitTypeAndReason() {
        when(membershipMapper.selectByUidForUpdate(10086L)).thenReturn(null);

        service.extend(10086L, 7, null, PayMembershipEvent.EventType.ADMIN_GRANT, "campaign compensation");

        PayMembershipEvent event = capturedEvent();
        assertThat(event.getType()).isEqualTo(PayMembershipEvent.EventType.ADMIN_GRANT);
        assertThat(event.getReason()).isEqualTo("campaign compensation");
        assertThat(event.getOrderNo()).isNull();
    }

    @Test
    void downgradeBlockedWhileHigherTierStillActive() {
        PayMembership existing = new PayMembership();
        existing.setId(1L);
        existing.setUid(10086L);
        existing.setTier("SVIP");
        existing.setExpireAt(NOW.plusDays(100));
        when(membershipMapper.selectByUidForUpdate(10086L)).thenReturn(existing);

        // Buying a VIP monthly plan while SVIP is active: extend the expiry, but the tier must not be downgraded
        PayMembership result = service.extend(10086L, 30, "PO-VIP", null, null, "VIP");

        assertThat(result.getTier()).isEqualTo("SVIP");
        assertThat(result.getExpireAt()).isEqualTo(NOW.plusDays(130));
        verify(audit).audit(org.mockito.ArgumentMatchers.eq("TIER_DOWNGRADE_BLOCKED"),
                any(), any(), any(), any(), any(), any(), any(), any());
    }

    @Test
    void upgradeAppliesWhileActive() {
        PayMembership existing = new PayMembership();
        existing.setId(1L);
        existing.setUid(10086L);
        existing.setTier("VIP");
        existing.setExpireAt(NOW.plusDays(10));
        when(membershipMapper.selectByUidForUpdate(10086L)).thenReturn(existing);

        PayMembership result = service.extend(10086L, 30, "PO-SVIP", null, null, "SVIP");

        assertThat(result.getTier()).isEqualTo("SVIP");
        assertThat(result.getExpireAt()).isEqualTo(NOW.plusDays(40));
    }

    @Test
    void expiredMembershipTakesRequestedLowerTier() {
        PayMembership expired = new PayMembership();
        expired.setId(1L);
        expired.setUid(10086L);
        expired.setTier("SVIP");
        expired.setExpireAt(NOW.minusDays(1));
        when(membershipMapper.selectByUidForUpdate(10086L)).thenReturn(expired);

        // Already expired = no active entitlement to protect, start from the newly purchased tier
        PayMembership result = service.extend(10086L, 30, "PO-VIP", null, null, "VIP");

        assertThat(result.getTier()).isEqualTo("VIP");
        assertThat(result.getExpireAt()).isEqualTo(NOW.plusDays(30));
    }

    @Test
    void invalidTierIsIgnoredNotWritten() {
        when(membershipMapper.selectByUidForUpdate(10086L)).thenReturn(null);

        PayMembership result = service.extend(10086L, 30, "PO1", null, null, "GOLD");

        assertThat(result.getTier()).isEqualTo("VIP");
    }

    @Test
    void revokeSubtractsDaysAndRecordsEvent() {
        PayMembership existing = new PayMembership();
        existing.setId(1L);
        existing.setUid(10086L);
        existing.setTier("VIP");
        existing.setExpireAt(NOW.plusDays(40));
        when(membershipMapper.selectByUidForUpdate(10086L)).thenReturn(existing);

        PayMembership result = service.revoke(10086L, 30, "PO1", "user refund").orElseThrow();

        assertThat(result.getExpireAt()).isEqualTo(NOW.plusDays(10));
        PayMembershipEvent event = capturedEvent();
        assertThat(event.getType()).isEqualTo(PayMembershipEvent.EventType.REFUND_REVOKE);
        assertThat(event.getDays()).isEqualTo(-30);
        assertThat(event.getExpireBefore()).isEqualTo(NOW.plusDays(40));
        assertThat(event.getExpireAfter()).isEqualTo(NOW.plusDays(10));
    }

    @Test
    void revokeFloorsAtNowWhenAlreadyConsumed() {
        PayMembership existing = new PayMembership();
        existing.setId(1L);
        existing.setUid(10086L);
        existing.setExpireAt(NOW.plusDays(5));
        when(membershipMapper.selectByUidForUpdate(10086L)).thenReturn(existing);

        PayMembership result = service.revoke(10086L, 30, "PO1", "refund").orElseThrow();

        assertThat(result.getExpireAt()).isEqualTo(NOW);
    }

    @Test
    void revokeWithoutRowIsNoop() {
        when(membershipMapper.selectByUidForUpdate(10086L)).thenReturn(null);

        assertThat(service.revoke(10086L, 30, "PO1", "refund")).isEmpty();
        verify(eventMapper, org.mockito.Mockito.never()).insert(any(PayMembershipEvent.class));
    }

    private PayMembershipEvent capturedEvent() {
        ArgumentCaptor<PayMembershipEvent> captor = ArgumentCaptor.forClass(PayMembershipEvent.class);
        verify(eventMapper).insert(captor.capture());
        return captor.getValue();
    }
}
