package com.mindbase.pay.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.mindbase.pay.common.ApiException;
import com.mindbase.pay.common.PayAuditLogger;
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
 * 渠道支付通知统一入口（M1 mock / M2 支付宝回调与查单共用）。
 *
 * 幂等设计（plan/1.0.7-Pay §4）：
 * ① markPaid 条件更新（WHERE status='CREATED'）在数据库层保证并发回调只有一次生效；
 * ② 回调流水落档（含幂等命中/关单补单等分支）；
 * ③ 交付走 DeliveryService（PAID 是已收款事实，不随交付失败回滚）。
 * 所有资金事件同步写 PayAuditLogger（JSONL 审计文件）。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class PaymentService {

    private final PayOrderMapper orderMapper;
    private final PayCallbackLogMapper callbackLogMapper;
    private final DeliveryService deliveryService;
    private final PayAuditLogger audit;
    private final Clock clock;

    public PayOrder handleChannelPaid(String orderNo,
                                      PayOrder.PayChannel channel,
                                      String channelTradeNo,
                                      Long paidAmountCents,
                                      String payloadMasked,
                                      PayCallbackLog.SignatureResult signatureResult) {
        // orderNo 进 MDC：本条支付链路后续所有日志自动携带，可与审计流水互查
        MDC.put("orderNo", orderNo);
        try {
            PayOrder order = selectByOrderNo(orderNo);
            if (order == null) {
                log.warn("[PAY] callback_unknown_order channel={}", channel);
                logCallback(orderNo, channel, payloadMasked, signatureResult,
                        PayCallbackLog.HandleResult.ORDER_NOT_FOUND, null);
                throw ApiException.notFound("ORDER_NOT_FOUND", "Order not found");
            }

            // 金额以本地订单为准，不信渠道回传值
            if (paidAmountCents != null && paidAmountCents != order.getAmountCents()) {
                log.error("[PAY] amount_mismatch expect={} actual={}", order.getAmountCents(), paidAmountCents);
                audit.audit("AMOUNT_MISMATCH", "order_no", orderNo, "channel", channel.name(),
                        "expect_cents", order.getAmountCents(), "actual_cents", paidAmountCents);
                logCallback(orderNo, channel, payloadMasked, signatureResult,
                        PayCallbackLog.HandleResult.ERROR, "amount mismatch");
                throw ApiException.badRequest("AMOUNT_MISMATCH", "Callback amount does not match the order");
            }

            int updated = orderMapper.markPaid(orderNo, channelTradeNo, LocalDateTime.now(clock));
            if (updated == 0) {
                return handleNonCreatedState(orderNo, channel, channelTradeNo, payloadMasked, signatureResult);
            }

            logCallback(orderNo, channel, payloadMasked, signatureResult,
                    PayCallbackLog.HandleResult.ACCEPTED, null);
            log.info("[PAY] order_paid channel={} amount_cents={}", channel, order.getAmountCents());
            audit.audit("ORDER_PAID", "order_no", orderNo, "uid", order.getUid(),
                    "channel", channel.name(), "amount_cents", order.getAmountCents(),
                    "trade_no", channelTradeNo);

            deliveryService.deliverOrder(order);
            order.setStatus(PayOrder.OrderStatus.DELIVERED);
            return order;
        } finally {
            MDC.remove("orderNo");
        }
    }

    /** markPaid 未命中：订单已被并发通知推进（幂等）或已关闭（渠道确认收款后补单）。 */
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
                // 幂等命中同时是自愈触发器：上次交付中断（进程崩溃在 PAID 后）时，
                // 借本次回调重发立即补交付；并发竞争由 markDelivered 条件更新兜底
                deliveryService.deliverOrder(current);
                current = selectByOrderNo(orderNo);
            }
            return current;
        }
        if (status == PayOrder.OrderStatus.CLOSED) {
            // 关单后到账（用户在超时关单瞬间完成支付）：渠道已确认收款（验签通知/查单），
            // 无条件补单 reopen——钱已收是事实；逆向走 M4 退款路径
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
