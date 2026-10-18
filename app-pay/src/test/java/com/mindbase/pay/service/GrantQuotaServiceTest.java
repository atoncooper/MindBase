package com.mindbase.pay.service;

import com.baomidou.mybatisplus.core.conditions.Wrapper;
import com.mindbase.pay.common.ApiException;
import com.mindbase.pay.common.PayAuditLogger;
import com.mindbase.pay.config.PayProperties;
import com.mindbase.pay.mapper.PayMembershipEventMapper;
import com.mindbase.pay.model.PayMembershipEvent;
import com.mindbase.pay.testutil.TestPayProperties;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;

/** ADMIN_GRANT 日额度熔断：次数触顶 / 总天数触顶 / 额度内放行 / 开关关闭直接放行。 */
@ExtendWith(MockitoExtension.class)
class GrantQuotaServiceTest {

    private PayMembershipEvent event(int days) {
        PayMembershipEvent e = new PayMembershipEvent();
        e.setDays(days);
        e.setType(PayMembershipEvent.EventType.ADMIN_GRANT);
        return e;
    }

    private GrantQuotaService service(PayMembershipEventMapper mapper, PayProperties props) {
        Clock clock = Clock.fixed(Instant.parse("2026-09-06T04:00:00Z"), ZoneId.of("Asia/Shanghai"));
        return new GrantQuotaService(mapper, new PayAuditLogger(), props, clock);
    }

    @Test
    void dailyCountExceededRejectsWith429() {
        List<PayMembershipEvent> events = new ArrayList<>();
        for (int i = 0; i < 50; i++) events.add(event(1));
        PayMembershipEventMapper mapper = org.mockito.Mockito.mock(PayMembershipEventMapper.class);
        when(mapper.selectList(any(Wrapper.class))).thenReturn(events);
        PayProperties props = TestPayProperties.builder()
                .grant(new PayProperties.Grant(true, 50, 1000)).build();

        assertThatThrownBy(() -> service(mapper, props).checkDailyQuota(30))
                .isInstanceOf(ApiException.class)
                .extracting(e -> ((ApiException) e).getStatus())
                .isEqualTo(429);
    }

    @Test
    void dailyDaysExceededRejectsWith429() {
        List<PayMembershipEvent> events = new ArrayList<>();
        for (int i = 0; i < 20; i++) events.add(event(60)); // 20 x 60 = 1200 > 1000
        PayMembershipEventMapper mapper = org.mockito.Mockito.mock(PayMembershipEventMapper.class);
        when(mapper.selectList(any(Wrapper.class))).thenReturn(events);
        PayProperties props = TestPayProperties.builder()
                .grant(new PayProperties.Grant(true, 50, 1000)).build();

        assertThatThrownBy(() -> service(mapper, props).checkDailyQuota(30))
                .isInstanceOf(ApiException.class)
                .extracting(e -> ((ApiException) e).getStatus())
                .isEqualTo(429);
    }

    @Test
    void withinQuotaPasses() {
        List<PayMembershipEvent> events = new ArrayList<>();
        events.add(event(30));
        PayMembershipEventMapper mapper = org.mockito.Mockito.mock(PayMembershipEventMapper.class);
        when(mapper.selectList(any(Wrapper.class))).thenReturn(events);
        PayProperties props = TestPayProperties.builder()
                .grant(new PayProperties.Grant(true, 50, 1000)).build();

        assertThatCode(() -> service(mapper, props).checkDailyQuota(30)).doesNotThrowAnyException();
    }

    @Test
    void disabledGrantSkipsChecks() {
        PayMembershipEventMapper mapper = org.mockito.Mockito.mock(PayMembershipEventMapper.class);
        PayProperties props = TestPayProperties.builder()
                .grant(new PayProperties.Grant(false, 0, 0)).build();

        assertThatCode(() -> service(mapper, props).checkDailyQuota(3650)).doesNotThrowAnyException();
    }
}
