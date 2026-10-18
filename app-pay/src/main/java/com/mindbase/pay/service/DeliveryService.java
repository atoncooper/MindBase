package com.mindbase.pay.service;

import java.time.Clock;
import java.time.LocalDateTime;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

import com.mindbase.pay.common.PayAuditLogger;
import com.mindbase.pay.common.PayMetrics;
import com.mindbase.pay.mapper.PayOrderMapper;
import com.mindbase.pay.model.PayMembershipEvent;
import com.mindbase.pay.model.PayOrder;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;

/**
 * Delivery = membership extension + order PAID->DELIVERED, committed atomically in one transaction.
 * Kept as a separate bean rather than a method inside PaymentService so the transaction proxy stays effective
 * (self-invocation would bypass @Transactional).
 * On failure everything rolls back and the order stays PAID for DeliveryRetryJob to compensate -- the fact that
 * payment was received is never rolled back.
 *
 * <p>Callers (callback path / compensation job) already hold the order entity, so this method does not re-read the DB;
 * whether delivery actually happens is decided at the database layer by the markDelivered conditional update
 * (under concurrency only one side wins).
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class DeliveryService {

    private final PayOrderMapper orderMapper;
    private final MembershipService membershipService;
    private final PayAuditLogger audit;
    private final PayMetrics metrics;
    private final Clock clock;

    /**
     * READ_COMMITTED：首购用户无会员行时，RR 的 FOR UPDATE 会加间隙锁，
     * 两个新 uid 的并发首购交付互相挡住对方 INSERT 形成死锁；RC 不加间隙锁，死锁面消除。
     * 本事务的并发正确性只依赖显式 FOR UPDATE + markDelivered 条件更新，不依赖 RR 快照语义。
     */
    @Transactional(isolation = Isolation.READ_COMMITTED)
    public void deliverOrder(PayOrder order) {
        LocalDateTime now = LocalDateTime.now(clock);
        // The conditional update ensures only one side actually delivers when racing concurrent callbacks/compensation jobs
        int delivered = orderMapper.markDelivered(order.getOrderNo(), now);
        if (delivered == 0) {
            log.info("[PAY] deliver_skip_not_paid order_no={}", order.getOrderNo());
            return;
        }
        try {
            // 升级换购单的权益事件标记为 UPGRADE（pay-admin 事件流水可辨）
            PayMembershipEvent.EventType explicit = order.getUpgradeFromOrderNo() != null
                    ? PayMembershipEvent.EventType.UPGRADE : null;
            membershipService.extend(order.getUid(), order.getDurationDays(), order.getOrderNo(),
                    explicit, null, resolveTier(order));
        } catch (Exception e) {
            // Rethrow to roll back this transaction (the DELIVERED mark is undone too), leaving the order PAID for compensation
            metrics.deliveryFailed();
            audit.audit("DELIVER_FAILED", "order_no", order.getOrderNo(),
                    "uid", order.getUid(), "err", e.toString());
            log.error("[PAY] deliver_failed uid={}", order.getUid(), e);
            throw e;
        }
        audit.audit("ORDER_DELIVERED", "uid", order.getUid(), "order_no", order.getOrderNo(),
                "channel", order.getChannel().name(), "days", order.getDurationDays());
        log.info("[PAY] order_delivered uid={} days={}", order.getUid(), order.getDurationDays());
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
