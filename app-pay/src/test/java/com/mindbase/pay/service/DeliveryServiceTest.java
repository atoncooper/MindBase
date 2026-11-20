package com.mindbase.pay.service;

import com.mindbase.pay.common.PayAuditLogger;
import com.mindbase.pay.common.PayMetrics;
import com.mindbase.pay.mapper.PayOrderMapper;
import com.mindbase.pay.model.PayMembership;
import com.mindbase.pay.model.PayOrder;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 第二道墙（唯一交付入口）：同档/降档且会员仍有效 -> 冻结 REFUND_HOLD、不交付；
 * 首购/升级单正常交付；条件更新未命中 -> SKIPPED。
 */
@ExtendWith(MockitoExtension.class)
class DeliveryServiceTest {

    private static final LocalDateTime NOW = LocalDateTime.of(2026, 9, 6, 12, 0);

    @Mock
    private PayOrderMapper orderMapper;
    @Mock
    private MembershipService membershipService;
    @Mock
    private PayAuditLogger audit;
    @Mock
    private PayMetrics metrics;

    private DeliveryService service;

    @BeforeEach
    void setUp() {
        Clock clock = Clock.fixed(Instant.parse("2026-09-06T04:00:00Z"), ZoneId.of("Asia/Shanghai"));
        service = new DeliveryService(orderMapper, membershipService, audit, metrics, clock);
    }

    private PayOrder paidOrder(String tier, String upgradeFrom) {
        PayOrder order = new PayOrder();
        order.setOrderNo("PO1");
        order.setUid(10086L);
        order.setDurationDays(30);
        order.setTier(tier);
        order.setSkuCode("VIP_MONTHLY");
        order.setChannel(PayOrder.PayChannel.MOCK);
        order.setStatus(PayOrder.OrderStatus.PAID);
        order.setUpgradeFromOrderNo(upgradeFrom);
        // DeliveryService now locks the order row before the tier wall; tests use the same entity.
        when(orderMapper.selectByOrderNoForUpdate(order.getOrderNo())).thenReturn(order);
        return order;
    }

    private PayMembership activeMembership(String tier) {
        PayMembership m = new PayMembership();
        m.setUid(10086L);
        m.setTier(tier);
        m.setExpireAt(NOW.plusDays(30));
        return m;
    }

    @Test
    void duplicateSameTierIsFrozenNotDelivered() {
        when(membershipService.lockActiveMembershipForUpdate(10086L))
                .thenReturn(activeMembership("VIP"));
        when(membershipService.isActive(any(PayMembership.class))).thenReturn(true);
        when(orderMapper.markRefundHold(eq("PO1"), any())).thenReturn(1);

        DeliveryService.DeliveryResult result = service.deliverOrder(paidOrder("VIP", null));

        assertThat(result).isEqualTo(DeliveryService.DeliveryResult.TIER_BLOCKED);
        verify(orderMapper).markRefundHold(eq("PO1"), any());
        verify(orderMapper, never()).markDelivered(anyString(), any());
        verify(membershipService, never()).extendLocked(any(), anyLong(), anyInt(), anyString(), any(), any(), any());
    }

    @Test
    void firstPurchaseDelivers() {
        when(membershipService.lockActiveMembershipForUpdate(10086L)).thenReturn(null);
        when(orderMapper.markDelivered(eq("PO1"), any())).thenReturn(1);
        when(membershipService.extendLocked(any(), anyLong(), anyInt(), anyString(), any(), any(), any()))
                .thenReturn(activeMembership("VIP"));

        DeliveryService.DeliveryResult result = service.deliverOrder(paidOrder("VIP", null));

        assertThat(result).isEqualTo(DeliveryService.DeliveryResult.DELIVERED);
        verify(membershipService).extendLocked(any(), eq(10086L), eq(30), eq("PO1"), any(), any(), eq("VIP"));
    }

    @Test
    void upgradeOrderExemptFromTierWall() {
        when(membershipService.lockActiveMembershipForUpdate(10086L))
                .thenReturn(activeMembership("VIP"));
        when(membershipService.isActive(any(PayMembership.class))).thenReturn(true);
        when(orderMapper.markDelivered(eq("PO1"), any())).thenReturn(1);
        when(membershipService.extendLocked(any(), anyLong(), anyInt(), anyString(), any(), any(), any()))
                .thenReturn(activeMembership("VIP"));

        DeliveryService.DeliveryResult result = service.deliverOrder(paidOrder("VIP", "PO-BASE"));

        assertThat(result).isEqualTo(DeliveryService.DeliveryResult.DELIVERED);
        verify(orderMapper, never()).markRefundHold(anyString(), any());
    }

    @Test
    void expiredMembershipDoesNotBlockDelivery() {
        PayMembership expired = activeMembership("VIP");
        expired.setExpireAt(NOW.minusDays(1));
        when(membershipService.lockActiveMembershipForUpdate(10086L)).thenReturn(expired);
        when(membershipService.isActive(any(PayMembership.class))).thenReturn(false);
        when(orderMapper.markDelivered(eq("PO1"), any())).thenReturn(1);
        when(membershipService.extendLocked(any(), anyLong(), anyInt(), anyString(), any(), any(), any()))
                .thenReturn(activeMembership("VIP"));

        assertThat(service.deliverOrder(paidOrder("VIP", null)))
                .isEqualTo(DeliveryService.DeliveryResult.DELIVERED);
        verify(orderMapper, never()).markRefundHold(anyString(), any());
    }

    @Test
    void crossTierUpgradeDelivers() {
        // 有效 VIP 购买 SVIP（跨档全价购买）：档位更高，正常交付
        when(membershipService.lockActiveMembershipForUpdate(10086L))
                .thenReturn(activeMembership("VIP"));
        when(membershipService.isActive(any(PayMembership.class))).thenReturn(true);
        when(orderMapper.markDelivered(eq("PO1"), any())).thenReturn(1);
        when(membershipService.extendLocked(any(), anyLong(), anyInt(), anyString(), any(), any(), any()))
                .thenReturn(activeMembership("SVIP"));

        PayOrder svip = paidOrder("SVIP", null);
        assertThat(service.deliverOrder(svip))
                .isEqualTo(DeliveryService.DeliveryResult.DELIVERED);
    }

    @Test
    void legacyNullTierFallsBackToSkuAndIsStillBlocked() {
        // 历史订单 tier 为空：必须回退 SKU 前缀判定，仍有第二道墙（不能因为 tier=null 就放行重复购买）
        when(membershipService.lockActiveMembershipForUpdate(10086L))
                .thenReturn(activeMembership("VIP"));
        when(membershipService.isActive(any(PayMembership.class))).thenReturn(true);
        when(orderMapper.markRefundHold(eq("PO1"), any())).thenReturn(1);
        PayOrder legacy = paidOrder(null, null);

        assertThat(service.deliverOrder(legacy))
                .isEqualTo(DeliveryService.DeliveryResult.TIER_BLOCKED);
        verify(orderMapper, never()).markDelivered(anyString(), any());
    }

    @Test
    void freezeUpdateMissStillReportsBlocked() {
        // 并发退款已把订单推进 REFUNDING，markRefundHold 命中 0 行：仍必须返回 TIER_BLOCKED（调用方幂等退款）
        when(membershipService.lockActiveMembershipForUpdate(10086L))
                .thenReturn(activeMembership("VIP"));
        when(membershipService.isActive(any(PayMembership.class))).thenReturn(true);
        when(orderMapper.markRefundHold(eq("PO1"), any())).thenReturn(0);

        assertThat(service.deliverOrder(paidOrder("VIP", null)))
                .isEqualTo(DeliveryService.DeliveryResult.TIER_BLOCKED);
        verify(orderMapper, never()).markDelivered(anyString(), any());
    }

    @Test
    void conditionalUpdateMissIsSkipped() {
        when(membershipService.lockActiveMembershipForUpdate(10086L)).thenReturn(null);
        when(orderMapper.markDelivered(eq("PO1"), any())).thenReturn(0);

        DeliveryService.DeliveryResult result = service.deliverOrder(paidOrder("VIP", null));

        assertThat(result).isEqualTo(DeliveryService.DeliveryResult.SKIPPED);
        verify(membershipService, never()).extendLocked(any(), anyLong(), anyInt(), anyString(), any(), any(), any());
    }
}