package com.mindbase.pay.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.mindbase.pay.common.ApiException;
import com.mindbase.pay.common.PayAuditLogger;
import com.mindbase.pay.common.PayMetrics;
import com.mindbase.pay.config.PayProperties;
import com.mindbase.pay.mapper.PayOrderMapper;
import com.mindbase.pay.model.PayOrder;
import com.mindbase.pay.service.channel.PayChannelAdapter;
import com.mindbase.pay.service.channel.PayChannelRouter;
import com.mindbase.pay.service.channel.RefundResult;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.slf4j.MDC;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Clock;
import java.time.LocalDateTime;

/**
 * Refund reversal (M4). State machine: PAID|DELIVERED --accept--> REFUNDING --channel success--> REFUNDED.
 *
 * <p>Three phases (same principle as ordering: channel HTTP is never inside a transaction):
 * <ol>
 *   <li>conditional-update acceptance (atomic, prevents concurrent duplicate refunds);</li>
 *   <li>channel refund (HTTP, outside the transaction; out_request_no is idempotent, so retries are safe);</li>
 *   <li>inside a transaction: mark REFUNDED + revoke membership (atomic; a failure rolls back the whole step and
 *       leaves the order in REFUNDING for retry).</li>
 * </ol>
 *
 * <p>A channel failure rolls back to the pre-refund state (refund_prev_status) and does not accidentally trigger
 * delivery compensation; an order whose process crashed in REFUNDING is repaired by idempotent replay (calling the
 * same endpoint again resumes the channel refund).
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class RefundService {

    private final PayOrderMapper orderMapper;
    private final PayChannelRouter channelRouter;
    private final MembershipService membershipService;
    private final PayAuditLogger audit;
    private final PayMetrics metrics;
    private final PayProperties payProperties;
    private final Clock clock;
    private final TransactionTemplate txTemplate;

    public PayOrder refund(String orderNo, String reason, boolean revokeMembership) {
        if (payProperties.refund() == null || !payProperties.refund().enabled()) {
            throw ApiException.notFound("NOT_FOUND", "Endpoint not found");
        }
        MDC.put("orderNo", orderNo);
        try {
            PayOrder order = selectByOrderNo(orderNo);
            if (order == null) {
                throw ApiException.notFound("ORDER_NOT_FOUND", "Order not found");
            }
            // Idempotent: already refunded, return immediately
            if (order.getStatus() == PayOrder.OrderStatus.REFUNDED) {
                return order;
            }
            // Accepted but not finished (crash/timeout retry): resume the channel refund without accepting again
            boolean alreadyAccepted = order.getStatus() == PayOrder.OrderStatus.REFUNDING;
            if (!alreadyAccepted && order.getStatus() != PayOrder.OrderStatus.PAID
                    && order.getStatus() != PayOrder.OrderStatus.DELIVERED) {
                throw ApiException.conflict("ORDER_NOT_REFUNDABLE",
                        "Order is not refundable in current state: " + order.getStatus());
            }

            LocalDateTime now = LocalDateTime.now(clock);
            enforceRefundWindow(order, now);

            String refundNo = order.getRefundNo() != null ? order.getRefundNo() : "REF-" + orderNo;
            if (!alreadyAccepted) {
                int accepted = orderMapper.markRefunding(orderNo, refundNo, reason, now);
                if (accepted == 0) {
                    PayOrder fresh = selectByOrderNo(orderNo);
                    if (fresh.getStatus() == PayOrder.OrderStatus.REFUNDED) {
                        return fresh;
                    }
                    throw ApiException.conflict("REFUND_STATE_INVALID",
                            "Order state changed, please retry: " + fresh.getStatus());
                }
                audit.audit("REFUND_ACCEPTED", "order_no", orderNo, "uid", order.getUid(),
                        "amount_cents", order.getAmountCents(), "reason", reason);
            }

            // ---- channel refund (HTTP outside the transaction) ----
            PayChannelAdapter adapter = channelRouter.requireAdapter(order.getChannel());
            RefundResult result = adapter.refund(order, reason);
            if (!result.success()) {
                orderMapper.revertRefunding(orderNo, now);
                metrics.refundFailed();
                audit.audit("REFUND_FAILED", "order_no", orderNo, "uid", order.getUid(),
                        "err", result.error());
                throw ApiException.internalServerError("REFUND_FAILED",
                        "Channel refund failed, order reverted for retry");
            }

            // ---- inside the transaction: mark refund complete + revoke membership ----
            String finalRefundNo = result.refundNo() != null ? result.refundNo() : refundNo;
            // On resume (REFUNDING) the status has already been overwritten, so the pre-refund status must be used
            // to decide whether membership was delivered; otherwise a crash replay would "refund the money without
            // revoking membership"
            String prevStatus = order.getStatus() == PayOrder.OrderStatus.REFUNDING
                    ? order.getRefundPrevStatus()
                    : order.getStatus().name();
            boolean wasDelivered = PayOrder.OrderStatus.DELIVERED.name().equals(prevStatus);
            txTemplate.execute(status -> {
                int done = orderMapper.markRefunded(orderNo, finalRefundNo, now);
                if (done == 0) {
                    throw ApiException.conflict("REFUND_STATE_INVALID", "Order is no longer REFUNDING");
                }
                if (revokeMembership && wasDelivered) {
                    membershipService.revoke(order.getUid(), order.getDurationDays(), orderNo, reason);
                }
                return null;
            });

            metrics.refundSucceeded();
            audit.audit("ORDER_REFUNDED", "order_no", orderNo, "uid", order.getUid(),
                    "amount_cents", order.getAmountCents(), "refund_no", finalRefundNo,
                    "revoke_membership", revokeMembership && wasDelivered, "reason", reason);
            log.info("[PAY] order_refunded order_no={} refund_no={} revoke={}",
                    orderNo, finalRefundNo, revokeMembership && wasDelivered);
            return selectByOrderNo(orderNo);
        } finally {
            MDC.remove("orderNo");
        }
    }

    private void enforceRefundWindow(PayOrder order, LocalDateTime now) {
        int maxDays = payProperties.refund().maxDaysBack();
        if (maxDays > 0 && order.getPaidAt() != null
                && order.getPaidAt().isBefore(now.minusDays(maxDays))) {
            throw ApiException.badRequest("REFUND_WINDOW_EXCEEDED",
                    "Order is outside the refundable window of " + maxDays + " days");
        }
    }

    private PayOrder selectByOrderNo(String orderNo) {
        return orderMapper.selectOne(
                new LambdaQueryWrapper<PayOrder>().eq(PayOrder::getOrderNo, orderNo));
    }
}
