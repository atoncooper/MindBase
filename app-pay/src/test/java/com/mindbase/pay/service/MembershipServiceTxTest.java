package com.mindbase.pay.service;

import com.mindbase.pay.model.PayMembershipEvent;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.annotation.Transactional;

import java.lang.reflect.Method;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * P0 regression guard: the admin grant goes through the 6-arg extend overload; if the transaction
 * annotation only lands on the 5-arg version, grant would run under autocommit (FOR UPDATE released
 * immediately + event insert non-atomic). Reflection asserts both overloads carry @Transactional.
 */
class MembershipServiceTxTest {

    @Test
    void bothExtendOverloadsAreTransactional() throws Exception {
        Method fiveArg = MembershipService.class.getMethod("extend",
                long.class, int.class, String.class, PayMembershipEvent.EventType.class, String.class);
        Method sixArg = MembershipService.class.getMethod("extend",
                long.class, int.class, String.class, PayMembershipEvent.EventType.class,
                String.class, String.class);

        assertThat(fiveArg.isAnnotationPresent(Transactional.class))
                .as("5-arg extend must be @Transactional").isTrue();
        assertThat(sixArg.isAnnotationPresent(Transactional.class))
                .as("6-arg extend must be @Transactional (the direct entry point for grant)").isTrue();
    }

    @Test
    void revokeIsTransactional() throws Exception {
        Method revoke = MembershipService.class.getMethod("revoke",
                long.class, int.class, String.class, String.class);
        assertThat(revoke.isAnnotationPresent(Transactional.class))
                .as("refund revocation must be @Transactional").isTrue();
    }
}
