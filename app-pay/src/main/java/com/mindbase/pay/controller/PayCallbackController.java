package com.mindbase.pay.controller;

import com.mindbase.pay.common.PayAuditLogger;
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
 * 支付渠道异步回调（/pay/callback/*）。APISIX 路由免登录态（priority 60），
 * 伪造请求由渠道验签拒绝；本服务不信任任何未验签字段。
 * 应答约定：支付宝要求纯文本 "success"/"fail"，非 success 渠道会重试（幂等保证重试安全）。
 */
@Slf4j
@RestController
@RequestMapping("/pay/callback")
@RequiredArgsConstructor
public class PayCallbackController {

    private final AlipayChannelAdapter alipayAdapter;
    private final PaymentService paymentService;
    private final PayAuditLogger audit;

    /** 支付宝异步通知：form-urlencoded，验签通过且成功态 → 统一入口推进订单。 */
    @PostMapping(value = "/alipay", consumes = MediaType.APPLICATION_FORM_URLENCODED_VALUE,
            produces = MediaType.TEXT_PLAIN_VALUE)
    public String alipayNotify(@RequestParam Map<String, String> params) {
        String outTradeNo = params.get("out_trade_no");
        log.info("[PAY] alipay_notify out_trade_no={} trade_status={}", outTradeNo, params.get("trade_status"));

        AlipayChannelAdapter.AlipayNotifyResult result = alipayAdapter.verifyNotify(params);
        if (result.status() == AlipayChannelAdapter.AlipayNotifyResult.Status.INVALID) {
            // 验签失败 = 疑似伪造请求，资金安全事件，必须留审计
            audit.audit("CALLBACK_REJECTED", "channel", "alipay",
                    "app_id", params.get("app_id"), "out_trade_no", outTradeNo);
            return "fail";
        }
        if (result.status() == AlipayChannelAdapter.AlipayNotifyResult.Status.NOT_PAID) {
            // 非成功态通知（交易关闭等），不应答 success 防止同类通知重试风暴
            return "success";
        }
        try {
            paymentService.handleChannelPaid(result.orderNo(), PayOrder.PayChannel.ALIPAY,
                    result.tradeNo(), result.paidAmountCents(), maskedPayload(params),
                    PayCallbackLog.SignatureResult.VALID);
            return "success";
        } catch (Exception e) {
            // 处理失败（临时故障）应答 fail 让渠道重试；幂等与关单补单保证重试安全
            log.error("[PAY] alipay_notify_handle_failed out_trade_no={} err={}", outTradeNo, e.toString());
            return "fail";
        }
    }

    /** 回调留档只取关键明文字段，签名等长字段不入库。 */
    private String maskedPayload(Map<String, String> params) {
        return "{\"app_id\":\"" + params.get("app_id")
                + "\",\"out_trade_no\":\"" + params.get("out_trade_no")
                + "\",\"trade_no\":\"" + params.get("trade_no")
                + "\",\"trade_status\":\"" + params.get("trade_status")
                + "\",\"total_amount\":\"" + params.get("total_amount") + "\"}";
    }
}
