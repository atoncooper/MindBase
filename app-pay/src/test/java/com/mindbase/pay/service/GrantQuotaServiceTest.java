package com.mindbase.pay.service;

import com.mindbase.pay.common.ApiException;
import com.mindbase.pay.common.PayAuditLogger;
import com.mindbase.pay.common.PayMetrics;
import com.mindbase.pay.config.PayProperties;
import com.mindbase.pay.mapper.PayGrantQuotaMapper;
import com.mindbase.pay.model.PayGrantQuota;
import com.mindbase.pay.testutil.TestPayProperties;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/** ADMIN_GRANT 日额度熔断（原子版）：次数触顶 / 总天数触顶 / 额度内放行并累加 / 开关关闭直接放行。 */
@ExtendWith(MockitoExtension.class)
class GrantQuotaServiceTest {

    private static final LocalDate DAY = LocalDate.of(2026, 9, 6);

    @Mock
    private PayGrantQuotaMapper quotaMapper;
    @Mock
    private PayAuditLogger audit;
    @Mock
    private PayMetrics metrics;

    private GrantQuotaService service(PayProperties props) {
        Clock clock = Clock.fixed(Instant.parse("2026-09-06T04:00:00Z"), ZoneId.of("Asia/Shanghai"));
        return new GrantQuotaService(quotaMapper, audit, metrics, props, clock);
    }

    private PayGrantQuota quota(int cnt, int days) {
        PayGrantQuota q = new PayGrantQuota();
        q.setDay(DAY);
        q.setCnt(cnt);
        q.setDays(days);
        return q;
    }

    private PayProperties.Grant enabled() {
        return TestPayProperties.defaults().grant();
    }

    @Test
    void dailyCountExceededRejectsWith429() {
        when(quotaMapper.lockDay(DAY)).thenReturn(quota(50, 500));

        assertThatThrownBy(() -> service(TestPayProperties.defaults()).reserve(30))
                .isInstanceOf(ApiException.class)
                .extracting(e -> ((ApiException) e).getStatus())
                .isEqualTo(429);
        verify(quotaMapper, never()).consume(any(), anyInt(), any());
    }

    @Test
    void dailyDaysExceededRejectsWith429() {
        when(quotaMapper.lockDay(DAY)).thenReturn(quota(1, 990));

        assertThatThrownBy(() -> service(TestPayProperties.defaults()).reserve(30))
                .isInstanceOf(ApiException.class)
                .extracting(e -> ((ApiException) e).getStatus())
                .isEqualTo(429);
        verify(quotaMapper, never()).consume(any(), anyInt(), any());
    }

    @Test
    void withinQuotaReservesAtomically() {
        when(quotaMapper.lockDay(DAY)).thenReturn(quota(1, 30));

        assertThatCode(() -> service(TestPayProperties.defaults()).reserve(30)).doesNotThrowAnyException();

        verify(quotaMapper).ensureDay(eq(DAY), any());
        verify(quotaMapper).consume(eq(DAY), eq(30), any());
    }

    @Test
    void exactBoundaryIsAllowedAndConsumed() {
        // count = max-1、days + requested = max：恰好到位，应放行并原子累加
        when(quotaMapper.lockDay(DAY)).thenReturn(quota(49, 970));

        assertThatCode(() -> service(TestPayProperties.defaults()).reserve(30)).doesNotThrowAnyException();

        verify(quotaMapper).consume(eq(DAY), eq(30), any());
    }

    @Test
    void disabledGrantSkipsChecks() {
        PayProperties props = TestPayProperties.builder()
                .grant(new PayProperties.Grant(false, 0, 0)).build();

        assertThatCode(() -> service(props).reserve(3650)).doesNotThrowAnyException();
        verifyNoInteractions(quotaMapper);
    }
}
