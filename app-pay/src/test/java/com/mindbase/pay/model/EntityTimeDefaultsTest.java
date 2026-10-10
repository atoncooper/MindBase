package com.mindbase.pay.model;

import com.mindbase.pay.common.PayTime;
import org.junit.jupiter.api.Test;

import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.temporal.ChronoUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

/**
 * Entity field initializers must use Beijing wall-clock time (PayTime.now()), not the system default zone --
 * on machines in a timezone other than Asia/Shanghai (this case is simulated: it asserts directly against the
 * current time in PayTime.ZONE) the two differ by 8 hours, making this test a real interceptor on such machines.
 */
class EntityTimeDefaultsTest {

    private static final LocalDateTime BEIJING_NOW = LocalDateTime.now(PayTime.ZONE);

    @Test
    void payOrderDefaultsUseBeijingWallTime() {
        PayOrder order = new PayOrder();
        assertThat(order.getCreatedAt()).isCloseTo(BEIJING_NOW, within(1, ChronoUnit.MINUTES));
        assertThat(order.getUpdatedAt()).isCloseTo(BEIJING_NOW, within(1, ChronoUnit.MINUTES));
        assertThat(order.getVersion()).isEqualTo(1); // delegation version baseline
    }

    @Test
    void otherEntityDefaultsUseBeijingWallTime() {
        assertThat(new PayProduct().getCreatedAt()).isCloseTo(BEIJING_NOW, within(1, ChronoUnit.MINUTES));
        assertThat(new PayMembership().getCreatedAt()).isCloseTo(BEIJING_NOW, within(1, ChronoUnit.MINUTES));
        assertThat(new PayMembership().getUpdatedAt()).isCloseTo(BEIJING_NOW, within(1, ChronoUnit.MINUTES));
        assertThat(new PayCallbackLog().getCreatedAt()).isCloseTo(BEIJING_NOW, within(1, ChronoUnit.MINUTES));
        assertThat(new PayMembershipEvent().getCreatedAt()).isCloseTo(BEIJING_NOW, within(1, ChronoUnit.MINUTES));
    }

    @Test
    void serviceTimeZoneIsBeijingEverywhere() {
        assertThat(PayTime.ZONE).isEqualTo(ZoneId.of("Asia/Shanghai"));
    }
}
