package com.mindbase.pay.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.mindbase.pay.common.ApiException;
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
 * Idempotency design (plan/1.0.7-Pay §4):
 * (1) the markPaid conditional update (WHERE status='CREATED') guarantees at the database layer that only one of
 *     several concurrent callbacks takes effect;
 * (2) every callback is written to the callback log (including idempotent hits / re-open after close branches);
 * (3) delivery goes through DeliveryService (PAID is the received-payment fact and is not rolled back when delivery
 *     fails).
 * All money events are written synchronously to PayAuditLogger (the JSONL audit file).
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class PaymentService {

    private final PayOrderMapper orderMapper;
    private final PayCallbackLogMapper callbackLogMapper;
    private final DeliveryService deliveryService;
    private final RefundService refundService;
    private final MembershipService membershipService;
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

            // ── 第二道墙（安全纵深）：PAID 落库后复核档位 ——
            // 即使恶意脚本绕过下单拦截（并发窗口/伪造请求），付款确认时也会复核：
            // 违规单（档位不高于现有生效会员）不交付权益，自动原路退款（本单未交付，
            // 不撤销任何天数）。退款失败则保持 PAID 禁止交付并告警，人工介入。
            // tier 快照为空（历史/异常单）不拦截 —— 与 applyTier 的 normalize 语义一致。
            String paidTier = order.getTier();
            // 升级换购单豁免第二道墙：同档升级单的档位 == 现有档位，按设计应交付
            // （差价已在建单时按基准单折算）；第二道墙只拦“未升级语义”的重复购买。
            if (paidTier != null && !paidTier.isBlank() && order.getUpgradeFromOrderNo() == null) {
                int activeRank = membershipService.activeTierRank(order.getUid());
                int orderRank = MembershipService.tierRank(paidTier);
                if (orderRank <= activeRank) {
                    log.warn("[PAY] duplicate_order_auto_refund order_no={} order_tier={} active_rank={}",
                            orderNo, paidTier, activeRank);
                    audit.audit("DUPLICATE_ORDER_AUTO_REFUND", "order_no", orderNo, "uid", order.getUid(),
                            "tier", paidTier, "active_rank", activeRank,
                            "amount_cents", order.getAmountCents());
                    try {
                        refundService.refund(orderNo, "重复购买自动退款（仅允许向上升级）", false);
                    } catch (Exception e) {
                        // 冻结为 REFUND_HOLD：交付补偿任务（DeliveryRetryJob / 重复回调自愈）只认 PAID，
                        // 因此冻结是真实的；人工经退款端点重放续走（未交付过，退款不回收会员）
                        int frozen = orderMapper.markRefundHold(orderNo, LocalDateTime.now(clock));
                        log.error("[PAY] duplicate_order_refund_failed order_no={} frozen={} -- 禁止交付，需人工退款",
                                orderNo, frozen == 1, e);
                        audit.audit("DUPLICATE_ORDER_REFUND_FAILED", "order_no", orderNo, "uid", order.getUid(),
                                "frozen", frozen == 1);
                        throw ApiException.internalServerError("AUTO_REFUND_FAILED",
                                "Duplicate order detected; delivery frozen pending manual refund");
                    }
                    return selectByOrderNo(orderNo);
                }
            }

            deliveryService.deliverOrder(order);
            order.setStatus(PayOrder.OrderStatus.DELIVERED);
            return order;
        } finally {
            MDC.remove("orderNo");
        }
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
                // races are handled by the markDelivered conditional update
                deliveryService.deliverOrder(current);
                current = selectByOrderNo(orderNo);
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
            PayOrder reopenedOrder = selectByOrderNo(orderNo);
            deliveryService.deliverOrder(reopenedOrder);
            reopenedOrder.setStatus(PayOrder.OrderStatus.DELIVERED);
            return reopenedOrder;
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
        record.setMessage(message);
        callbackLogMapper.insert(record);
    }
}
