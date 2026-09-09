package com.mindbase.pay.service.channel;

import com.alipay.api.AlipayApiException;
import com.alipay.api.AlipayClient;
import com.alipay.api.DefaultAlipayClient;
import com.alipay.api.internal.util.AlipaySignature;
import com.alipay.api.domain.AlipayTradePrecreateModel;
import com.alipay.api.domain.AlipayTradeQueryModel;
import com.alipay.api.request.AlipayTradePrecreateRequest;
import com.alipay.api.request.AlipayTradeQueryRequest;
import com.alipay.api.response.AlipayTradePrecreateResponse;
import com.alipay.api.response.AlipayTradeQueryResponse;
import com.mindbase.pay.common.ApiException;
import com.mindbase.pay.config.PayProperties;
import com.mindbase.pay.model.PayOrder;
import jakarta.annotation.PostConstruct;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.math.BigDecimal;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 支付宝当面付适配器（M2）：precreate 扫码下单 + trade query 查单 + 异步通知验签。
 * 金额全部以本地订单为准：下单传本地金额，查单/回调回传金额仅做比对。
 */
@Slf4j
@Component
public class AlipayChannelAdapter implements PayChannelAdapter {

    private final PayProperties payProperties;
    private AlipayClient client;
    /** 验签连续失败计数：≥3 触发告警（公钥配置错误或持续伪造攻击信号），成功一次清零。 */
    private final AtomicInteger verifyFailureStreak = new AtomicInteger();

    public AlipayChannelAdapter(PayProperties payProperties) {
        this.payProperties = payProperties;
    }

    @PostConstruct
    void init() {
        PayProperties.Alipay conf = payProperties.alipay();
        if (!conf.enabled()) {
            return;
        }
        if (isBlank(conf.appId()) || isBlank(conf.appPrivateKey()) || isBlank(conf.platformPublicKey())) {
            throw new IllegalStateException(
                    "[PAY] alipay enabled but missing key config: need ALIPAY_APP_ID, "
                            + "ALIPAY_APP_PRIVATE_KEY (app private key, signs requests), "
                            + "ALIPAY_PLATFORM_PUBLIC_KEY (alipay public key from the platform console "
                            + "'interface signing method' -- NOT your own app public key)");
        }
        this.client = new DefaultAlipayClient(conf.gatewayUrl(), conf.appId(), conf.appPrivateKey(),
                "json", "UTF-8", conf.platformPublicKey(), "RSA2");
        log.info("[PAY] alipay_adapter_init gateway={} notify_url={}", conf.gatewayUrl(),
                isBlank(conf.notifyUrl()) ? "(not configured, query-polling mode)" : conf.notifyUrl());
    }

    @Override
    public PayOrder.PayChannel channel() {
        return PayOrder.PayChannel.ALIPAY;
    }

    @Override
    public boolean enabled() {
        return payProperties.alipay().enabled() && client != null;
    }

    @Override
    public Map<String, Object> createPayment(PayOrder order) {
        try {
            AlipayTradePrecreateModel model = new AlipayTradePrecreateModel();
            model.setOutTradeNo(order.getOrderNo());
            model.setTotalAmount(toYuan(order.getAmountCents()));
            model.setSubject(order.getProductTitle());
            AlipayTradePrecreateRequest request = new AlipayTradePrecreateRequest();
            request.setBizModel(model);
            String notifyUrl = payProperties.alipay().notifyUrl();
            if (!isBlank(notifyUrl)) {
                request.setNotifyUrl(notifyUrl);
            }
            AlipayTradePrecreateResponse resp = client.execute(request);
            if (resp == null || !resp.isSuccess() || isBlank(resp.getQrCode())) {
                log.error("[PAY] alipay_precreate_failed order_no={} code={} sub={} msg={}",
                        order.getOrderNo(), codeOf(resp), subCodeOf(resp), msgOf(resp));
                throw ApiException.badRequest("CHANNEL_CREATE_FAILED", "Alipay order creation failed, please retry later");
            }
            log.info("[PAY] alipay_precreate order_no={} qr_prefix={}",
                    order.getOrderNo(), abbreviate(resp.getQrCode()));
            return Map.of("type", "alipay_qr", "orderNo", order.getOrderNo(), "qrCode", resp.getQrCode());
        } catch (AlipayApiException e) {
            // 沙箱网关故障时消息可能是整页 HTML（404 页等），全量堆栈只有 SDK HTTP 样板帧——单行摘要足够
            log.error("[PAY] alipay_precreate_error order_no={} err={}", order.getOrderNo(), abbreviate(e));
            throw ApiException.badRequest("CHANNEL_CREATE_FAILED", "Alipay order creation failed, please retry later");
        }
    }

    @Override
    public ChannelQueryResult queryOrder(PayOrder order) {
        try {
            AlipayTradeQueryModel model = new AlipayTradeQueryModel();
            model.setOutTradeNo(order.getOrderNo());
            AlipayTradeQueryRequest request = new AlipayTradeQueryRequest();
            request.setBizModel(model);
            AlipayTradeQueryResponse resp = client.execute(request);
            if (resp == null || !resp.isSuccess()) {
                // 订单尚未在渠道创建（买家未扫码）属常态；查询暂时失败同样下轮再查，不误判
                log.info("[PAY] alipay_query_not_ready order_no={} code={} sub={}",
                        order.getOrderNo(), codeOf(resp), subCodeOf(resp));
                return ChannelQueryResult.notPaid();
            }
            String status = resp.getTradeStatus();
            if ("TRADE_SUCCESS".equals(status) || "TRADE_FINISHED".equals(status)) {
                return ChannelQueryResult.paid(resp.getTradeNo(), toCents(resp.getTotalAmount()));
            }
            if ("TRADE_CLOSED".equals(status)) {
                return ChannelQueryResult.closed(resp.getTradeNo());
            }
            return ChannelQueryResult.notPaid(); // WAIT_BUYER_PAY
        } catch (AlipayApiException e) {
            log.error("[PAY] alipay_query_error order_no={} err={}", order.getOrderNo(), abbreviate(e));
            return ChannelQueryResult.notPaid();
        }
    }

    /**
     * 异步通知验签 + 关键字段校验（app_id 归属、成功态、金额由 PaymentService 比对）。
     * 验签失败/字段异常一律 INVALID → 回调方应答 fail 让渠道重试。
     */
    public AlipayNotifyResult verifyNotify(Map<String, String> params) {
        try {
                boolean signOk = AlipaySignature.rsaCheckV1(params,
                        payProperties.alipay().platformPublicKey(), "UTF-8", "RSA2");
            if (!signOk || !payProperties.alipay().appId().equals(params.get("app_id"))) {
                int streak = verifyFailureStreak.incrementAndGet();
                // 连续失败 = 支付宝公钥配置错误或遭遇持续伪造攻击，必须立刻人工核查
                if (streak >= 3) {
                    log.error("[PAY] alipay_verify_failure_streak count={} -- wrong platform public key "
                            + "or ongoing forgery, investigate immediately", streak);
                }
                log.error("[PAY] alipay_notify_verify_failed app_id={} out_trade_no={}",
                        params.get("app_id"), params.get("out_trade_no"));
                return AlipayNotifyResult.invalid();
            }
            verifyFailureStreak.set(0);
            String status = params.get("trade_status");
            if (!"TRADE_SUCCESS".equals(status) && !"TRADE_FINISHED".equals(status)) {
                // 非成功态通知（如交易关闭）不推进订单
                return AlipayNotifyResult.notPaid();
            }
            return AlipayNotifyResult.paid(params.get("out_trade_no"), params.get("trade_no"),
                    toCents(params.get("total_amount")));
        } catch (AlipayApiException e) {
            log.error("[PAY] alipay_notify_verify_error", e);
            return AlipayNotifyResult.invalid();
        }
    }

    static String toYuan(long cents) {
        return BigDecimal.valueOf(cents, 2).toPlainString();
    }

    static Long toCents(String yuan) {
        try {
            return new BigDecimal(yuan).movePointRight(2).setScale(0).longValueExact();
        } catch (Exception e) {
            return null;
        }
    }

    private static boolean isBlank(String s) {
        return s == null || s.isBlank();
    }

    /** SDK 异常消息单行摘要（截断 200 字符）：网关故障页是整页 HTML，堆栈只有 SDK HTTP 样板帧，全量落日志纯刷屏。 */
    private static String abbreviate(AlipayApiException e) {
        String msg = String.valueOf(e.getMessage()).replaceAll("\\s+", " ").trim();
        return msg.length() <= 200 ? msg : msg.substring(0, 200) + "...(truncated)";
    }

    private static String codeOf(com.alipay.api.AlipayResponse resp) {
        return resp == null ? "-" : resp.getCode();
    }

    private static String subCodeOf(com.alipay.api.AlipayResponse resp) {
        return resp == null ? "-" : resp.getSubCode();
    }

    private static String msgOf(com.alipay.api.AlipayResponse resp) {
        return resp == null ? "-" : resp.getMsg();
    }

    private static String abbreviate(String qrCode) {
        return qrCode.length() <= 24 ? qrCode : qrCode.substring(0, 24) + "...";
    }

    /** 异步通知处理结果。 */
    public record AlipayNotifyResult(Status status, String orderNo, String tradeNo, Long paidAmountCents) {

        public enum Status {PAID, NOT_PAID, INVALID}

        public static AlipayNotifyResult paid(String orderNo, String tradeNo, Long cents) {
            return new AlipayNotifyResult(Status.PAID, orderNo, tradeNo, cents);
        }

        public static AlipayNotifyResult notPaid() {
            return new AlipayNotifyResult(Status.NOT_PAID, null, null, null);
        }

        public static AlipayNotifyResult invalid() {
            return new AlipayNotifyResult(Status.INVALID, null, null, null);
        }
    }
}
