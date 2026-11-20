package com.mindbase.pay.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.mindbase.pay.common.ApiException;
import com.mindbase.pay.common.LogSanitizer;
import com.mindbase.pay.common.PayAuditLogger;
import com.mindbase.pay.common.PayMetrics;
import com.mindbase.pay.mapper.PayCallbackLogMapper;
import com.mindbase.pay.mapper.PayOrderMapper;
import com.mindbase.pay.model.PayCallbackLog;
import com.mindbase.pay.model.PayOrder;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.slf4j.MDC;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.LocalDateTime;

/**
 * Unified entry point for channel payment notifications (shared by M1 mock / M2 Alipay callbacks and query polling).
 *
 * <p>Idempotency design (plan/1.0.7-Pay §4):
 * (1) the markPaid conditional update (WHERE status='CREATED') guarantees at the database layer that only one of
 *     several concurrent callbacks takes effect;
 * (2) every callback is written to the callback log (including idempotent hits / re-open after close branches);
 * (3) delivery goes through DeliveryService (PAID is the received-payment fact and is not rolled back when delivery
 *     fails).
 *
 * <p><b>第二道墙已下沉到 DeliveryService（唯一交付入口）</b>：此前只在本类首次接受路径做重复购买判定，
 * 造成“并发自愈/补偿路径可绕过”的竞态；现在本类只负责“把 PAID 交给交付”，若交付返回 TIER_BLOCKED
 * （违规订单已被冻结为 REFUND_HOLD），统一在此触发原路自动退款。所有路径（首次回调、重复回调自愈、
 * 补偿 Job）行为一致。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class PaymentService {

    /** 重复购买自动退款原因（审计与客服对账共用同一文案）。 */
    public static final String DUPLICATE_PURCHASE_REASON = "重复购买自动退款（仅允许向上升级）";

    private final PayOrderMapper orderMapper;
    private final PayCallbackLogMapper callbackLogMapper;
    private final DeliveryService deliveryService;
    private final RefundService refundService;
    private final PayAuditLogger audit;
    private final PayMetrics metrics;
    private final Clock clock;
    private final org.springframework.transaction.support.TransactionTemplate txTemplate;

    public PayOrder handleChannelPaid(String orderNo,
                                      PayOrder.PayChannel channel,
                                      String channelTradeNo,
                                      Long paidAmountCents,
                                      String payloadMasked,
                                      PayCallbackLog.SignatureResult signatureResult,
                                      String buyerLogonId,
                                      String buyerUserId) {
        // Put orderNo in MDC: all later logs of this payment path carry it automatically and can be cross-checked against the audit trail
        MDC.put("orderNo", orderNo);
        try {
            PayOrder order = selectByOrderNo(orderNo);
            if (order == null) {
                log.warn("[PAY] callback_unknown_order channel={}", channel);
                logCallback(orderNo, channel, payloadMasked, signatureResult,
                        PayCallbackLog.HandleResult.ORDER_NOT_FOUND, null);
                throw ApiException.notFound("ORDER_NOT_FOUND", "Order not found");
            }

            // Amounts are based on the local order, never on the value the channel returns. A missing/unparseable
            // amount is always rejected -- the old "paidAmount != null && compare" skipped validation on null and
            // still marked the order PAID.
            if (paidAmountCents == null) {
                log.error("[PAY] amount_missing channel={} order_no={}", channel, orderNo);
                metrics.callbackAmountMismatch();
                audit.audit("AMOUNT_MISSING", "order_no", orderNo, "channel", channel.name());
                logCallback(orderNo, channel, payloadMasked, signatureResult,
                        PayCallbackLog.HandleResult.ERROR, "amount missing");
                throw ApiException.badRequest("AMOUNT_MISSING", "Callback amount is missing or unparseable");
            }
            // 买家信息是渠道验签/查单确认过的事实，先落库（订单详情展示付款账户）。
            if (buyerLogonId != null || buyerUserId != null) {
                orderMapper.update(null, new LambdaUpdateWrapper<PayOrder>()
                        .eq(PayOrder::getOrderNo, orderNo)
                        .set(PayOrder::getBuyerLogonId, buyerLogonId)
                        .set(PayOrder::getBuyerUserId, buyerUserId));
            }
            if (paidAmountCents != order.getAmountCents()) {
                log.error("[PAY] amount_mismatch expect={} actual={}", order.getAmountCents(), paidAmountCents);
                audit.audit("AMOUNT_MISMATCH", "order_no", orderNo, "channel", channel.name(),
                        "expect_cents", order.getAmountCents(), "actual_cents", paidAmountCents);
                metrics.callbackAmountMismatch();
                logCallback(orderNo, channel, payloadMasked, signatureResult,
                        PayCallbackLog.HandleResult.ERROR, "amount mismatch");
                throw ApiException.badRequest("AMOUNT_MISMATCH", "Callback amount does not match the order");
            }

            // 接受相事务折叠：markPaid + 回调留痕同一事务提交，fsync 4→3/笔，
            // 且 markPaid 成功后回调日志不再可能因崩溃而丢失；幂等/状态机语义不变
            Boolean accepted = txTemplate.execute(status -> {
                int updated = orderMapper.markPaid(orderNo, channelTradeNo, LocalDateTime.now(clock));
                if (updated == 1) {
                    logCallback(orderNo, channel, payloadMasked, signatureResult,
                            PayCallbackLog.HandleResult.ACCEPTED, null);
                }
                return updated == 1;
            });
            if (!Boolean.TRUE.equals(accepted)) {
                return handleNonCreatedState(orderNo, channel, channelTradeNo, payloadMasked, signatureResult);
            }
            log.info("[PAY] order_paid channel={} amount_cents={}", channel, order.getAmountCents());
            metrics.orderPaid();
            audit.audit("ORDER_PAID", "order_no", orderNo, "uid", order.getUid(),
                    "channel", channel.name(), "amount_cents", order.getAmountCents(),
                    "trade_no", channelTradeNo);
            return deliverAccepted(order);
        } finally {
            MDC.remove("orderNo");
        }
    }

    /**
     * 把已 PAID 的订单交给唯一交付入口；违规订单（TIER_BLOCKED）触发原路自动退款。
     * 所有“已收到钱”的路径共用，避免第二道墙被绕过。
     */
    private PayOrder deliverAccepted(PayOrder order) {
        DeliveryService.DeliveryResult result = deliveryService.deliverOrder(order);
        if (result == DeliveryService.DeliveryResult.TIER_BLOCKED) {
            return autoRefundTierBlocked(order);
        }
        if (result == DeliveryService.DeliveryResult.DELIVERED) {
            order.setStatus(PayOrder.OrderStatus.DELIVERED);
            return order;
        }
        // SKIPPED = 并发方已交付/退款，返回数据库最新状态
        return selectByOrderNo(order.getOrderNo());
    }

    /**
     * 重复购买订单的原路退款。订单已被 DeliveryService 冻结为 REFUND_HOLD（不会交付），
     * 退款失败时保持冻结（DeliveryRetryJob/重复回调只认 PAID，因此冻结是真实的），需人工重放退款端点。
     */
    private PayOrder autoRefundTierBlocked(PayOrder order) {
        String orderNo = order.getOrderNo();
        log.warn("[PAY] duplicate_order_auto_refund order_no={} order_tier={}",
                orderNo, order.getTier());
        audit.audit("DUPLICATE_ORDER_AUTO_REFUND", "order_no", orderNo, "uid", order.getUid(),
                "tier", order.getTier(), "amount_cents", order.getAmountCents());
        try {
            refundService.refund(orderNo, DUPLICATE_PURCHASE_REASON, false);
        } catch (Exception e) {
            metrics.autoRefundFailed();
            audit.audit("DUPLICATE_ORDER_REFUND_FAILED", "order_no", orderNo, "uid", order.getUid());
            log.error("[PAY] duplicate_order_refund_failed order_no={} -- frozen as REFUND_HOLD, manual refund required",
                    orderNo, e);
            throw ApiException.internalServerError("AUTO_REFUND_FAILED",
                    "Duplicate order detected; delivery frozen pending manual refund");
        }
        metrics.autoRefund();
        return selectByOrderNo(orderNo);
    }

    /** markPaid missed: the order was advanced by a concurrent notification (idempotent) or is already closed (re-open after the channel confirms receipt). */
    private PayOrder handleNonCreatedState(String orderNo,
                                           PayOrder.PayChannel channel,
                                           String channelTradeNo,
                                           String payloadMasked,
                                           PayCallbackLog.SignatureResult signatureResult) {
        PayOrder current = selectByOrderNo(orderNo);
        PayOrder.OrderStatus status = current.getStatus();
        if (status == PayOrder.OrderStatus.PAID || status == PayOrder.OrderStatus.DELIVERED) {
            logCallback(orderNo, channel, payloadMasked, signatureResult,
                    PayCallbackLog.HandleResult.ACCEPTED_DUPLICATE, "status=" + status);
            log.info("[PAY] callback_duplicate status={}", status);
            audit.audit("ORDER_PAID_DUPLICATE", "order_no", orderNo, "channel", channel.name(),
                    "status", status.name(), "trade_no", channelTradeNo);
            if (status == PayOrder.OrderStatus.PAID) {
                // An idempotent hit doubles as a self-healing trigger: if the previous delivery was interrupted
                // (the process crashed after PAID), this redelivered callback immediately completes it; concurrent
                // races are handled by the markDelivered conditional update. 违规订单同样经唯一交付入口冻结+退款。
                return deliverAccepted(current);
            }
            return current;
        }
        if (status == PayOrder.OrderStatus.CLOSED) {
            // Payment arrived after close (the user paid at the instant the timeout closed the order): the channel
            // has confirmed receipt (verified notification / query), so re-open unconditionally -- the money was
            // received; the reverse path goes through the M4 refund flow
            log.warn("[PAY] paid_after_close_reopening");
            int reopened = orderMapper.markPaidAfterClose(orderNo, channelTradeNo, LocalDateTime.now(clock));
            if (reopened == 0) {
                throw ApiException.conflict("ORDER_STATE_INVALID", "Invalid order state: " + status);
            }
            logCallback(orderNo, channel, payloadMasked, signatureResult,
                    PayCallbackLog.HandleResult.ACCEPTED, "status=CLOSED reopened");
            audit.audit("ORDER_REOPENED", "order_no", orderNo, "channel", channel.name(),
                    "trade_no", channelTradeNo);
            return deliverAccepted(selectByOrderNo(orderNo));
        }
        if (status == PayOrder.OrderStatus.REFUNDING || status == PayOrder.OrderStatus.REFUNDED
                || status == PayOrder.OrderStatus.REFUND_HOLD) {
            // Duplicate paid notification while the refund flow owns the order (REFUNDING), the refund already
            // completed (REFUNDED), or the order is frozen pending manual refund (REFUND_HOLD): the payment was
            // accepted earlier, so ack the duplicate -- a "fail" reply would make the channel retry for up to 24h
            // against a state that will never accept payment again
            logCallback(orderNo, channel, payloadMasked, signatureResult,
                    PayCallbackLog.HandleResult.ACCEPTED_DUPLICATE, "status=" + status);
            log.info("[PAY] callback_duplicate_refund_flow status={}", status);
            audit.audit("ORDER_PAID_DUPLICATE", "order_no", orderNo, "channel", channel.name(),
                    "status", status.name(), "trade_no", channelTradeNo);
            return current;
        }
        throw ApiException.conflict("ORDER_STATE_INVALID", "Invalid order state: " + status);
    }

    private PayOrder selectByOrderNo(String orderNo) {
        return orderMapper.selectOne(
                new LambdaQueryWrapper<PayOrder>().eq(PayOrder::getOrderNo, orderNo));
    }

    private void logCallback(String orderNo,
                             PayOrder.PayChannel channel,
                             String payloadMasked,
                             PayCallbackLog.SignatureResult signatureResult,
                             PayCallbackLog.HandleResult handleResult,
                             String message) {
        PayCallbackLog record = new PayCallbackLog();
        record.setOrderNo(orderNo);
        record.setChannel(channel);
        record.setPayloadMasked(payloadMasked);
        record.setSignatureResult(signatureResult != null
                ? signatureResult : PayCallbackLog.SignatureResult.SKIPPED);
        record.setHandleResult(handleResult);
        record.setMessage(LogSanitizer.safe(message, 200));
        callbackLogMapper.insert(record);
    }
}
