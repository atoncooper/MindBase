package com.mindbase.pay.service;

import java.time.Clock;
import java.time.LocalDateTime;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.mindbase.pay.common.PayAuditLogger;
import com.mindbase.pay.mapper.PayOrderMapper;
import com.mindbase.pay.model.PayOrder;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;

/**
 * 交付 = 会员顺延 + 订单 PAID->DELIVERED，二者同一事务原子提交。
 * 独立成 bean 而非 PaymentService 内部方法，保证事务代理生效（自调用会绕过 @Transactional）。
 * 失败时整体回滚，订单停留在 PAID，由 DeliveryRetryJob 补偿——钱已收的事实不被回滚。
 *
 * <p>调用方（回调链路/补偿 job）都已持有订单实体，本方法不再回查库；
 * 是否真正交付由 markDelivered 条件更新在数据库层裁定（并发竞争下只有一方生效）。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class DeliveryService {

    private final PayOrderMapper orderMapper;
    private final MembershipService membershipService;
    private final PayAuditLogger audit;
    private final Clock clock;

    @Transactional
    public void deliverOrder(PayOrder order) {
        LocalDateTime now = LocalDateTime.now(clock);
        // 条件更新保证与并发回调/补偿 job 竞争时只有一方真正交付
        int delivered = orderMapper.markDelivered(order.getOrderNo(), now);
        if (delivered == 0) {
            log.info("[PAY] deliver_skip_not_paid order_no={}", order.getOrderNo());
            return;
        }
        try {
            // tier derived from the SKU code prefix ("SVIP_*" -> SVIP, otherwise VIP)
            String tier = order.getSkuCode() != null && order.getSkuCode().startsWith("SVIP")
                    ? "SVIP" : "VIP";
            membershipService.extend(order.getUid(), order.getDurationDays(), order.getOrderNo(), null, null, tier);
        } catch (Exception e) {
            // 抛出使本事务回滚（DELIVERED 标记一并撤销），订单留 PAID 等待补偿
            audit.audit("DELIVER_FAILED", "order_no", order.getOrderNo(),
                    "uid", order.getUid(), "err", e.toString());
            log.error("[PAY] deliver_failed uid={}", order.getUid(), e);
            throw e;
        }
        audit.audit("ORDER_DELIVERED", "uid", order.getUid(), "order_no", order.getOrderNo(),
                "channel", order.getChannel().name(), "days", order.getDurationDays());
        log.info("[PAY] order_delivered uid={} days={}", order.getUid(), order.getDurationDays());
    }
}
