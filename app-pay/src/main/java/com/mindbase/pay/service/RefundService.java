package com.mindbase.pay.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.UpdateWrapper;
import com.mindbase.pay.common.ApiException;
import com.mindbase.pay.common.LogSanitizer;
import com.mindbase.pay.common.PayAuditLogger;
import com.mindbase.pay.common.PayMetrics;
import com.mindbase.pay.config.PayProperties;
import com.mindbase.pay.mapper.PayRefundApprovalMapper;
import com.mindbase.pay.mapper.PayOrderMapper;
import com.mindbase.pay.model.PayRefundApproval;
import com.mindbase.pay.model.PayOrder;
import com.mindbase.pay.service.channel.PayChannelAdapter;
import com.mindbase.pay.service.channel.PayChannelRouter;
import com.mindbase.pay.service.channel.RefundResult;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.slf4j.MDC;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Clock;
import java.time.LocalDateTime;

/**
 * Refund reversal (M4). State machine: PAID|DELIVERED --accept--> REFUNDING --channel success--> REFUNDED.
 *
 * <p>State machine: PAID|DELIVERED|REFUND_HOLD --accept--> REFUNDING --channel success--> REFUNDED.
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
    private final PayRefundApprovalMapper approvalMapper;
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
            // Accepted but not finished (crash/timeout retry): resume the channel refund without accepting again.
            // REFUND_HOLD (tier-violation freeze, auto-refund failed) is refundable too: replaying the refund
            // endpoint resumes the frozen reversal; nothing was delivered, so wasDelivered stays false below
            boolean alreadyAccepted = order.getStatus() == PayOrder.OrderStatus.REFUNDING;
            if (!alreadyAccepted && order.getStatus() != PayOrder.OrderStatus.PAID
                    && order.getStatus() != PayOrder.OrderStatus.DELIVERED
                    && order.getStatus() != PayOrder.OrderStatus.REFUND_HOLD) {
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

            // ---- inside the transaction: revoke membership + mark refund complete ----
            String finalRefundNo = result.refundNo() != null ? result.refundNo() : refundNo;
            // 关键：是否“已交付过”必须以数据库当前的 refund_prev_status 为准。入口读到的实体可能已过期
            // （并发交付把 PAID 推进成 DELIVERED），用旧快照判断会“退款成功但不回收会员”。
            PayOrder current = selectByOrderNo(orderNo);
            String prevStatus = current != null && current.getRefundPrevStatus() != null
                    ? current.getRefundPrevStatus()
                    : (current != null ? current.getStatus().name() : order.getStatus().name());
            boolean wasDelivered = PayOrder.OrderStatus.DELIVERED.name().equals(prevStatus);
            txTemplate.execute(status -> {
                // 锁顺序与 DeliveryService 一致：先会员行、再订单行，避免 ABBA 死锁
                if (revokeMembership && wasDelivered) {
                    membershipService.revoke(order.getUid(), order.getDurationDays(), orderNo, reason);
                }
                int done = orderMapper.markRefunded(orderNo, finalRefundNo, now);
                if (done == 0) {
                    throw ApiException.conflict("REFUND_STATE_INVALID", "Order is no longer REFUNDING");
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

    /**
     * Ops entry with maker-checker: require-approval=true (production) means the first call records a
     * PENDING approval (operator = maker), and only a SECOND operator (server-side enforced != maker, confirm=true)
     * releases the actual channel refund. require-approval=false (local/test) refunds immediately and the operator
     * is only recorded in the audit trail. The system auto-refund path ({@link #refund}) bypasses approval by design
     * (it is machine-initiated and fully audited).
     */
    public PayOrder refundByOps(String orderNo, String reason, boolean revokeMembership,
                                String operator, boolean confirm) {
        if (payProperties.refund() == null || !payProperties.refund().enabled()) {
            throw ApiException.notFound("NOT_FOUND", "Endpoint not found");
        }
        String operatorSafe = operator == null || operator.isBlank() ? null : operator.trim();
        if (operatorSafe == null) {
            throw ApiException.badRequest("OPERATOR_REQUIRED",
                    "operator is required for refunds (maker-checker audit trail)");
        }
        if (!payProperties.refund().requireApproval()) {
            MDC.put("orderNo", orderNo);
            try {
                audit.audit("REFUND_NO_APPROVAL_MODE", "order_no", orderNo, "operator", operatorSafe);
                return refund(orderNo, reason, revokeMembership);
            } finally {
                MDC.remove("orderNo");
            }
        }
        MDC.put("orderNo", orderNo);
        try {
            PayRefundApproval pending = findPendingRequest(orderNo);
            if (pending == null) {
                // First call = maker request: validate refundability now (fail fast), record PENDING, do not touch the order
                PayOrder order = selectByOrderNo(orderNo);
                if (order == null) {
                    throw ApiException.notFound("ORDER_NOT_FOUND", "Order not found");
                }
                if (order.getStatus() != PayOrder.OrderStatus.PAID
                        && order.getStatus() != PayOrder.OrderStatus.DELIVERED
                        && order.getStatus() != PayOrder.OrderStatus.REFUND_HOLD) {
                    throw ApiException.conflict("ORDER_NOT_REFUNDABLE",
                            "Order is not refundable in current state: " + order.getStatus());
                }
                enforceRefundWindow(order, LocalDateTime.now(clock));
                PayRefundApproval request = new PayRefundApproval();
                request.setOrderNo(orderNo);
                request.setMaker(operatorSafe);
                request.setMakerReason(reason);
                request.setStatus(PayRefundApproval.ApprovalStatus.PENDING);
                request.setCreatedAt(LocalDateTime.now(clock));
                try {
                    approvalMapper.insert(request);
                } catch (DuplicateKeyException e) {
                    // 并发首次调用：唯一键 (order_no,status) 保证只有一条 PENDING；另一条请求已登记，等待复核即可
                    log.warn("[PAY] refund_request_duplicate order_no={} operator={}",
                            orderNo, LogSanitizer.safe(operatorSafe));
                    audit.audit("REFUND_REQUEST_DUPLICATE", "order_no", orderNo,
                            "operator", LogSanitizer.safe(operatorSafe));
                    return order;
                }
                audit.audit("REFUND_REQUESTED", "order_no", orderNo, "maker", LogSanitizer.safe(operatorSafe),
                        "reason", LogSanitizer.safe(reason, 200));
                log.info("[PAY] refund_requested order_no={} maker={}", orderNo, LogSanitizer.safe(operatorSafe));
                return order;
            }
            if (!confirm) {
                // Explicit probe: still pending, need a second operator to confirm
                audit.audit("REFUND_REQUEST_PENDING", "order_no", orderNo,
                        "maker", pending.getMaker(), "operator", operatorSafe);
                log.info("[PAY] refund_request_pending order_no={} maker={} operator={}",
                        orderNo, pending.getMaker(), operatorSafe);
                return selectByOrderNo(orderNo);
            }
            if (operatorSafe.equalsIgnoreCase(pending.getMaker())) {
                throw ApiException.conflict("REFUND_CHECKER_EQUALS_MAKER",
                        "The confirming operator must differ from the requesting maker");
            }
            // 使用列名字符串（内部常量，无用户输入）而不是 lambda：单测无 MyBatis TableInfo 时
            // LambdaUpdateWrapper 会在构造期解析 lambda 缓存而报错；条件更新语义不变。
            int approved = approvalMapper.update(null, new UpdateWrapper<PayRefundApproval>()
                    .eq("id", pending.getId())
                    .eq("status", PayRefundApproval.ApprovalStatus.PENDING.name())
                    .set("status", PayRefundApproval.ApprovalStatus.APPROVED.name())
                    .set("checker", operatorSafe)
                    .set("check_reason", reason)
                    .set("decided_at", LocalDateTime.now(clock)));
            if (approved == 0) {
                // 并发复核：另一人已批准/驳回；不得重复触发渠道退款
                throw ApiException.conflict("REFUND_REQUEST_NOT_PENDING",
                        "Refund request was already decided, please refresh");
            }
            audit.audit("REFUND_APPROVED", "order_no", orderNo,
                    "maker", LogSanitizer.safe(pending.getMaker()), "checker", LogSanitizer.safe(operatorSafe),
                    "reason", LogSanitizer.safe(reason, 200));
            log.info("[PAY] refund_approved order_no={} maker={} checker={}",
                    orderNo, LogSanitizer.safe(pending.getMaker()), LogSanitizer.safe(operatorSafe));
            return refund(orderNo, reason, revokeMembership);
        } finally {
            MDC.remove("orderNo");
        }
    }

    /** Rejects the pending refund request for the order (second person; enforced != maker). */
    public PayOrder rejectRefundRequest(String orderNo, String operator) {
        String operatorSafe = operator == null || operator.isBlank() ? null : operator.trim();
        if (operatorSafe == null) {
            throw ApiException.badRequest("OPERATOR_REQUIRED",
                    "operator is required to reject a refund request");
        }
        MDC.put("orderNo", orderNo);
        try {
            PayRefundApproval pending = findPendingRequest(orderNo);
            if (pending == null) {
                throw ApiException.notFound("REFUND_REQUEST_NOT_FOUND",
                        "No pending refund request for this order");
            }
            if (operatorSafe.equalsIgnoreCase(pending.getMaker())) {
                throw ApiException.conflict("REFUND_CHECKER_EQUALS_MAKER",
                        "The rejecting operator must differ from the requesting maker");
            }
            int rejected = approvalMapper.update(null, new UpdateWrapper<PayRefundApproval>()
                    .eq("id", pending.getId())
                    .eq("status", PayRefundApproval.ApprovalStatus.PENDING.name())
                    .set("status", PayRefundApproval.ApprovalStatus.REJECTED.name())
                    .set("checker", operatorSafe)
                    .set("check_reason", "rejected")
                    .set("decided_at", LocalDateTime.now(clock)));
            if (rejected == 0) {
                throw ApiException.conflict("REFUND_REQUEST_NOT_PENDING",
                        "Refund request was already decided, please refresh");
            }
            audit.audit("REFUND_REQUEST_REJECTED", "order_no", orderNo,
                    "maker", LogSanitizer.safe(pending.getMaker()), "checker", LogSanitizer.safe(operatorSafe));
            log.info("[PAY] refund_request_rejected order_no={} maker={} checker={}",
                    orderNo, pending.getMaker(), operatorSafe);
            return selectByOrderNo(orderNo);
        } finally {
            MDC.remove("orderNo");
        }
    }

    /** Pending/approved/rejected refund requests, newest first (ops visibility; bounded page). */
    public java.util.List<PayRefundApproval> listRefundRequests(String status) {
        LambdaQueryWrapper<PayRefundApproval> wrapper = new LambdaQueryWrapper<PayRefundApproval>()
                .orderByDesc(PayRefundApproval::getCreatedAt)
                .last("LIMIT 200");
        if (status != null && !status.isBlank()) {
            wrapper.eq(PayRefundApproval::getStatus, status.trim().toUpperCase());
        }
        return approvalMapper.selectList(wrapper);
    }

    private PayRefundApproval findPendingRequest(String orderNo) {
        return approvalMapper.selectOne(new LambdaQueryWrapper<PayRefundApproval>()
                .eq(PayRefundApproval::getOrderNo, orderNo)
                .eq(PayRefundApproval::getStatus, PayRefundApproval.ApprovalStatus.PENDING)
                .orderByDesc(PayRefundApproval::getCreatedAt)
                .last("LIMIT 1"));
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
