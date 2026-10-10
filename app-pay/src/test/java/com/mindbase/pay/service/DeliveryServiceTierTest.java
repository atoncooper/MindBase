package com.mindbase.pay.service;

import com.mindbase.pay.model.PayOrder;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** Tier resolution: prefer the order snapshot; legacy orders (null tier) fall back to the SKU prefix. */
class DeliveryServiceTierTest {

    @Test
    void snapshotTierWinsOverPrefix() {
        PayOrder order = new PayOrder();
        order.setSkuCode("VIP_MONTHLY");
        order.setTier("SVIP");
        assertThat(DeliveryService.resolveTier(order)).isEqualTo("SVIP");
    }

    @Test
    void legacyOrderFallsBackToSvipPrefix() {
        PayOrder order = new PayOrder();
        order.setSkuCode("SVIP_YEARLY");
        order.setTier(null);
        assertThat(DeliveryService.resolveTier(order)).isEqualTo("SVIP");
    }

    @Test
    void legacyVipOrderFallsBackToVip() {
        PayOrder order = new PayOrder();
        order.setSkuCode("VIP_MONTHLY");
        order.setTier(null);
        assertThat(DeliveryService.resolveTier(order)).isEqualTo("VIP");
    }
}
