package com.mindbase.pay.common;

import java.time.LocalDateTime;
import java.time.ZoneId;

/**
 * Single source of truth for the service time zone (plan/1.0.7-Pay: everything uses Asia/Shanghai wall-clock time).
 *
 * <p>Three places must share the same source: (1) business time retrieval (the injected Clock is built from this);
 * (2) entity field initializers (NOT NULL columns not explicitly assigned on MyBatis-Plus insert rely on them --
 * using the system default zone would produce an 8-hour offset on machines outside Beijing time);
 * (3) converting the trigger_time of outbound registration delegations.
 * Docker forces TZ to Asia/Shanghai, but the code does not depend on that environment guarantee.
 */
public final class PayTime {

    public static final ZoneId ZONE = ZoneId.of("Asia/Shanghai");

    private PayTime() {
    }

    /** Current Beijing wall-clock time (used by entity initializers and scenarios without a Clock injected). */
    public static LocalDateTime now() {
        return LocalDateTime.now(ZONE);
    }
}
