package com.mindbase.pay.controller;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.mindbase.pay.common.ApiException;
import com.mindbase.pay.common.PayAuditLogger;
import com.mindbase.pay.common.PayMetrics;
import com.mindbase.pay.model.PayCallbackLog;
import com.mindbase.pay.model.PayOrder;
import com.mindbase.pay.service.PaymentService;
import com.mindbase.pay.service.channel.AlipayChannelAdapter;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * Payment channel async callbacks (/pay/callback/*). The APISIX route requires no login state
 * (priority 60); forged requests are rejected by channel signature verification, and this service
 * trusts no unverified field.
 * Response contract: Alipay expects plain-text "success"/"fail"; a non-success response makes the
 * channel retry (idempotency keeps retries safe).
 */
@Slf4j
@RestController
@RequestMapping("/pay/callback")
@RequiredArgsConstructor
public class PayCallbackController {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final AlipayChannelAdapter alipayAdapter;
    private final PaymentService paymentService;
    private final PayAuditLogger audit;
    private final PayMetrics metrics;

    /** Alipay async notification: form-urlencoded; once signature verification and a success status pass, advance the order through the unified entry point. */
    @PostMapping(value = "/alipay", consumes = MediaType.APPLICATION_FORM_URLENCODED_VALUE,
            produces = MediaType.TEXT_PLAIN_VALUE)
    public String alipayNotify(@RequestParam Map<String, String> params) {
        String outTradeNo = params.get("out_trade_no");
        log.info("[PAY] alipay_notify out_trade_no={} trade_status={}", outTradeNo, params.get("trade_status"));

        AlipayChannelAdapter.AlipayNotifyResult result = alipayAdapter.verifyNotify(params);
        if (result.status() == AlipayChannelAdapter.AlipayNotifyResult.Status.INVALID) {
            // Signature verification failed = suspected forged request, a financial security event that must be audited
            metrics.callbackRejected();
            audit.audit("CALLBACK_REJECTED", "channel", "alipay",
                    "app_id", params.get("app_id"), "out_trade_no", outTradeNo);
            return "fail";
        }
        if (result.status() == AlipayChannelAdapter.AlipayNotifyResult.Status.NOT_PAID) {
            // Non-success notification (e.g. trade closed); do not ack success to avoid a retry storm of similar notifications
            return "success";
        }
        try {
            paymentService.handleChannelPaid(result.orderNo(), PayOrder.PayChannel.ALIPAY,
                    result.tradeNo(), result.paidAmountCents(), maskedPayload(params),
                    PayCallbackLog.SignatureResult.VALID,
                    result.buyerLogonId(), result.buyerUserId());
            return "success";
        } catch (ApiException e) {
            if ("AMOUNT_MISMATCH".equals(e.getCode()) || "AMOUNT_MISSING".equals(e.getCode())) {
                // Permanent discrepancy (amount mismatch/missing): ack success to stop the channel's
                // pointless retry storm; an ERROR log + audit + rejection metric are already emitted and
                // manual reconciliation is required
                log.error("[PAY] alipay_notify_amount_rejected out_trade_no={} code={} -- acked to stop retries",
                        outTradeNo, e.getCode());
                return "success";
            }
            if ("ORDER_NOT_FOUND".equals(e.getCode())) {
                // Permanent unknown order: the notify_url points at the wrong environment / the order never
                // existed here. Retrying for 24h changes nothing -- ack success (already audited as
                // ORDER_NOT_FOUND + callback log by PaymentService) and require manual investigation
                log.error("[PAY] alipay_notify_unknown_order out_trade_no={} -- acked to stop retries", outTradeNo);
                return "success";
            }
            log.error("[PAY] alipay_notify_handle_failed out_trade_no={} code={}", outTradeNo, e.getCode());
            return "fail";
        } catch (Exception e) {
            // Processing failed (transient fault): ack fail so the channel retries; idempotency and close/repair logic keep retries safe
            log.error("[PAY] alipay_notify_handle_failed out_trade_no={} err={}", outTradeNo, e.toString());
            return "fail";
        }
    }

    /** Callback archival keeps only key plaintext fields; long fields such as the signature are not stored. */
    private String maskedPayload(Map<String, String> params) {
        try {
            return MAPPER.writeValueAsString(Map.of(
                    "app_id", String.valueOf(params.get("app_id")),
                    "out_trade_no", String.valueOf(params.get("out_trade_no")),
                    "trade_no", String.valueOf(params.get("trade_no")),
                    "trade_status", String.valueOf(params.get("trade_status")),
                    "total_amount", String.valueOf(params.get("total_amount"))));
        } catch (JsonProcessingException e) {
            return "{}";
        }
    }
}
