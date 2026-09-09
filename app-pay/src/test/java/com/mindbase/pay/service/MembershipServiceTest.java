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
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** 会员顺延规则：首开/未到期续费叠加/过期后重新起算/运营补偿类型。 */
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

        // 未到期续费：从当前到期时间顺延叠加，而非从 now
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

        service.extend(10086L, 7, null, PayMembershipEvent.EventType.ADMIN_GRANT, "活动补偿");

        PayMembershipEvent event = capturedEvent();
        assertThat(event.getType()).isEqualTo(PayMembershipEvent.EventType.ADMIN_GRANT);
        assertThat(event.getReason()).isEqualTo("活动补偿");
        assertThat(event.getOrderNo()).isNull();
    }

    private PayMembershipEvent capturedEvent() {
        ArgumentCaptor<PayMembershipEvent> captor = ArgumentCaptor.forClass(PayMembershipEvent.class);
        verify(eventMapper).insert(captor.capture());
        return captor.getValue();
    }
}
