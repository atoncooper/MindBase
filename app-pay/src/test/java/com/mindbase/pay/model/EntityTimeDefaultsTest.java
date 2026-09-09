package com.mindbase.pay.model;

import com.mindbase.pay.common.PayTime;
import org.junit.jupiter.api.Test;

import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.temporal.ChronoUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

/**
 * 实体字段初始化器必须用北京墙上时间（PayTime.now()），不得用系统默认时区——
 * 在非 Asia/Shanghai 时区的机器上（本用例 simulated：直接对 PayTime.ZONE 的当前时间断言）
 * 两者会差 8 小时，此测试在该类机器上是真正的拦截器。
 */
class EntityTimeDefaultsTest {

    private static final LocalDateTime BEIJING_NOW = LocalDateTime.now(PayTime.ZONE);

    @Test
    void payOrderDefaultsUseBeijingWallTime() {
        PayOrder order = new PayOrder();
        assertThat(order.getCreatedAt()).isCloseTo(BEIJING_NOW, within(1, ChronoUnit.MINUTES));
        assertThat(order.getUpdatedAt()).isCloseTo(BEIJING_NOW, within(1, ChronoUnit.MINUTES));
        assertThat(order.getVersion()).isEqualTo(1); // 委托版本基线
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
