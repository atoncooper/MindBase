package com.mindbase.pay.service;

import java.time.Clock;
import java.time.LocalDateTime;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

import com.mindbase.pay.common.PayAuditLogger;
import com.mindbase.pay.common.PayMetrics;
import com.mindbase.pay.mapper.PayOrderMapper;
import com.mindbase.pay.model.PayMembership;
import com.mindbase.pay.model.PayMembershipEvent;
import com.mindbase.pay.model.PayOrder;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;

/**
 * Delivery = membership extension + order PAID->DELIVERED, committed atomically in one transaction.
 * Kept as a separate bean rather than a method inside PaymentService so the transaction proxy stays effective
 * (self-invocation would bypass @Transactional).
 *
 * <p><b>第二道墙的唯一入口（P1 修复）</b>：重复购买/降档拦截此前只写在
 * PaymentService.handleChannelPaid 的首次接受路径，重复回调自愈、DeliveryRetryJob 补偿等
 * “已 PAID”路径可以绕过它，导致重复订单既被退款又保留会员。现在档位判定下沉到本方法：
 * 所有交付（回调、自愈、补偿、重试）都必须先通过这里，违规订单直接冻结为 REFUND_HOLD 并返回
 * TIER_BLOCKED，由调用方触发自动退款；本方法绝不交付违规订单。
 *
 * <p><b>锁顺序</b>：先锁会员行、再更新订单行，与授权/退款路径保持一致，避免与
 * 退款事务（会员行 + 订单行）形成 ABBA 死锁。
 *
 * <p>READ_COMMITTED：首购用户无会员行时，RR 的 FOR UPDATE 会加间隙锁，
 * 两个新 uid 的并发首购交付互相挡住对方 INSERT 形成死锁；RC 不加间隙锁，死锁面消除。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class DeliveryService {

    /** 交付结果：调用方必须区分“已交付 / 已他人处理 / 档位违规冻结（需退款）”。 */
    public enum DeliveryResult {
        DELIVERED, SKIPPED, TIER_BLOCKED
    }

    private final PayOrderMapper orderMapper;
    private final MembershipService membershipService;
    private final PayAuditLogger audit;
    private final PayMetrics metrics;
    private final Clock clock;

    @Transactional(isolation = Isolation.READ_COMMITTED)
    public DeliveryResult deliverOrder(PayOrder order) {
        LocalDateTime now = LocalDateTime.now(clock);
        String orderNo = order.getOrderNo();

        // ⓪ 先锁订单行：同一订单的并发回调用同一个 order 串行化。若另一线程已经交付，
        // 这里读到 DELIVERED 直接 SKIPPED，避免拿“刚被本单延长过的会员”误判重复购买并退款。
        PayOrder current = orderMapper.selectByOrderNoForUpdate(orderNo);
        if (current == null || current.getStatus() != PayOrder.OrderStatus.PAID) {
            log.info("[PAY] deliver_skip_status order_no={} status={}", orderNo,
                    current == null ? "null" : current.getStatus());
            return DeliveryResult.SKIPPED;
        }
        order = current;

        // ① 再锁会员行：同一用户的并发交付串行化，且档位判定基于最新已提交数据
        PayMembership locked = membershipService.lockActiveMembershipForUpdate(order.getUid());
        int activeRank = (locked != null && membershipService.isActive(locked))
                ? MembershipService.tierRank(locked.getTier()) : 0;

        // ② 第二道墙：非升级单且订单档位 <= 当前生效档位 = 重复购买/降档，禁止交付
        String tier = resolveTier(order);
        boolean upgrade = order.getUpgradeFromOrderNo() != null;
        if (!upgrade && tier != null && !tier.isBlank()
                && MembershipService.tierRank(tier) <= activeRank) {
            int held = orderMapper.markRefundHold(orderNo, now);
            audit.audit("DELIVERY_TIER_BLOCKED", "order_no", orderNo, "uid", order.getUid(),
                    "order_tier", tier, "active_rank", activeRank, "frozen", held == 1);
            metrics.deliveryTierBlocked();
            log.warn("[PAY] delivery_tier_blocked order_no={} order_tier={} active_rank={} frozen={}",
                    orderNo, tier, activeRank, held == 1);
            return DeliveryResult.TIER_BLOCKED;
        }

        // ③ 条件更新保证并发交付只有一方生效
        int delivered = orderMapper.markDelivered(orderNo, now);
        if (delivered == 0) {
            log.info("[PAY] deliver_skip_not_paid order_no={}", orderNo);
            return DeliveryResult.SKIPPED;
        }
        try {
            // 升级换购单的权益事件标记为 UPGRADE（pay-admin 事件流水可辨）
            PayMembershipEvent.EventType explicit = upgrade
                    ? PayMembershipEvent.EventType.UPGRADE : null;
            membershipService.extendLocked(locked, order.getUid(), order.getDurationDays(), orderNo,
                    explicit, null, tier);
        } catch (Exception e) {
            // Rethrow to roll back this transaction (the DELIVERED mark is undone too), leaving the order PAID for compensation
            metrics.deliveryFailed();
            audit.audit("DELIVER_FAILED", "order_no", orderNo,
                    "uid", order.getUid(), "err", e.toString());
            log.error("[PAY] deliver_failed uid={}", order.getUid(), e);
            throw e;
        }
        audit.audit("ORDER_DELIVERED", "uid", order.getUid(), "order_no", orderNo,
                "channel", order.getChannel().name(), "days", order.getDurationDays());
        log.info("[PAY] order_delivered uid={} days={}", order.getUid(), order.getDurationDays());
        return DeliveryResult.DELIVERED;
    }

    /**
     * Tier resolution: prefer the order snapshot (copied from the SKU at order time); for historical orders
     * (tier column empty) fall back to deriving it from the SKU code prefix, so old orders still deliver correctly
     * during the upgrade migration.
     */
    static String resolveTier(PayOrder order) {
        if (order.getTier() != null && !order.getTier().isBlank()) {
            return order.getTier();
        }
        return order.getSkuCode() != null && order.getSkuCode().startsWith("SVIP") ? "SVIP" : "VIP";
    }
}
