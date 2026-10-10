package com.mindbase.pay.service.channel;

import com.alipay.api.AlipayApiException;
import com.alipay.api.DefaultAlipayClient;
import com.alipay.api.internal.util.AlipaySignature;
import com.alipay.api.domain.AlipayTradePrecreateModel;
import com.alipay.api.domain.AlipayTradeQueryModel;
import com.alipay.api.domain.AlipayTradeRefundModel;
import com.alipay.api.request.AlipayTradePrecreateRequest;
import com.alipay.api.request.AlipayTradeQueryRequest;
import com.alipay.api.request.AlipayTradeRefundRequest;
import com.alipay.api.response.AlipayTradePrecreateResponse;
import com.alipay.api.response.AlipayTradeQueryResponse;
import com.alipay.api.response.AlipayTradeRefundResponse;
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
 * Alipay face-to-face payment adapter (M2): precreate for scan-code orders + trade query for order lookup +
 * async notification signature verification.
 * All amounts are based on the local order: the local amount is sent at order time, and amounts returned by query /
 * callback are used only for comparison.
 */
@Slf4j
@Component
public class AlipayChannelAdapter implements PayChannelAdapter {

    private final PayProperties payProperties;
    private DefaultAlipayClient client;
    /** Consecutive signature-verification failures: >=3 raises an alert (wrong public key config or an ongoing forgery attack); one success resets it to zero. */
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
        // The SDK brings its own HTTP client: global spring.http.client.* has no effect on it, so timeouts must be
        // set explicitly; otherwise a slow channel response would occupy the order request thread for a long time
        this.client.setConnectTimeout(conf.connectTimeoutMs());
        this.client.setReadTimeout(conf.readTimeoutMs());
        log.info("[PAY] alipay_adapter_init gateway={} notify_url={} connect_timeout_ms={} read_timeout_ms={}",
                conf.gatewayUrl(),
                isBlank(conf.notifyUrl()) ? "(not configured, query-polling mode)" : conf.notifyUrl(),
                conf.connectTimeoutMs(), conf.readTimeoutMs());
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
            // When the sandbox gateway fails, the message may be a full HTML page (404 page, etc.) and the full stack
            // only has boilerplate SDK HTTP frames -- a one-line summary is enough
            log.error("[PAY] alipay_precreate_error order_no={} err={}", order.getOrderNo(), abbreviate(e));
            throw ApiException.badRequest("CHANNEL_CREATE_FAILED", "Alipay order creation failed, please retry later");
        }
    }

    @Override
    public ChannelQueryResult queryOrder(PayOrder order) {
        // 沙箱网关（openapi-sandbox.dl.alipaydev.com）间歇性 404 HTML，失败后立即重试一次再放弃
        ChannelQueryResult first = queryOnce(order);
        return first.status() == ChannelQueryResult.Status.NOT_PAID ? queryOnce(order) : first;
    }

    private ChannelQueryResult queryOnce(PayOrder order) {
        try {
            AlipayTradeQueryModel model = new AlipayTradeQueryModel();
            model.setOutTradeNo(order.getOrderNo());
            AlipayTradeQueryRequest request = new AlipayTradeQueryRequest();
            request.setBizModel(model);
            AlipayTradeQueryResponse resp = client.execute(request);
            if (resp == null || !resp.isSuccess()) {
                // The order not yet existing at the channel (buyer has not scanned) is normal; a transient query
                // failure is likewise retried next round rather than misjudged
                log.info("[PAY] alipay_query_not_ready order_no={} code={} sub={}",
                        order.getOrderNo(), codeOf(resp), subCodeOf(resp));
                return ChannelQueryResult.notPaid();
            }
            String status = resp.getTradeStatus();
            if ("TRADE_SUCCESS".equals(status) || "TRADE_FINISHED".equals(status)) {
                return ChannelQueryResult.paid(resp.getTradeNo(), toCents(resp.getTotalAmount()),
                        resp.getBuyerLogonId(), resp.getBuyerUserId());
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
     * Async notification signature verification + key field validation (app_id ownership, success status; the amount
     * is compared by PaymentService).
     * A failed signature or abnormal field always yields INVALID -> the callback responds fail so the channel retries.
     */
    public AlipayNotifyResult verifyNotify(Map<String, String> params) {
        try {
                boolean signOk = AlipaySignature.rsaCheckV1(params,
                        payProperties.alipay().platformPublicKey(), "UTF-8", "RSA2");
            if (!signOk || !payProperties.alipay().appId().equals(params.get("app_id"))) {
                int streak = verifyFailureStreak.incrementAndGet();
                // Consecutive failures = wrong Alipay public key config or an ongoing forgery attack; manual investigation is required immediately
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
                // A non-success notification (e.g. trade closed) does not advance the order
                return AlipayNotifyResult.notPaid();
            }
            return AlipayNotifyResult.paid(params.get("out_trade_no"), params.get("trade_no"),
                    toCents(params.get("total_amount")),
                    params.get("buyer_logon_id"), params.get("buyer_user_id"));
        } catch (AlipayApiException e) {
            log.error("[PAY] alipay_notify_verify_error", e);
            return AlipayNotifyResult.invalid();
        }
    }

    /**
     * Channel refund: out_request_no is fixed to REF-{orderNo}, making repeated refunds of the same order
     * idempotent (no second payout).
     * Only the channel_trade_no already on the local order is accepted (Alipay locates the original trade by
     * trade_no first).
     */
    @Override
    public RefundResult refund(PayOrder order, String reason) {
        try {
            AlipayTradeRefundModel model = new AlipayTradeRefundModel();
            model.setOutTradeNo(order.getOrderNo());
            if (!isBlank(order.getChannelTradeNo())) {
                model.setTradeNo(order.getChannelTradeNo());
            }
            model.setRefundAmount(toYuan(order.getAmountCents()));
            model.setOutRequestNo("REF-" + order.getOrderNo());
            if (!isBlank(reason)) {
                model.setRefundReason(reason.length() > 200 ? reason.substring(0, 200) : reason);
            }
            AlipayTradeRefundRequest request = new AlipayTradeRefundRequest();
            request.setBizModel(model);
            AlipayTradeRefundResponse resp = client.execute(request);
            if (resp == null || !resp.isSuccess()) {
                String error = "code=" + codeOf(resp) + " sub=" + subCodeOf(resp) + " msg=" + msgOf(resp);
                log.error("[PAY] alipay_refund_failed order_no={} {}", order.getOrderNo(), error);
                return RefundResult.failure(error);
            }
            log.info("[PAY] alipay_refund order_no={} trade_no={} fund_change={}",
                    order.getOrderNo(), resp.getTradeNo(), resp.getFundChange());
            return RefundResult.success(resp.getTradeNo() != null ? resp.getTradeNo() : order.getChannelTradeNo());
        } catch (AlipayApiException e) {
            log.error("[PAY] alipay_refund_error order_no={} err={}", order.getOrderNo(), abbreviate(e));
            return RefundResult.failure(abbreviate(e));
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

    /** One-line summary of an SDK exception message (truncated to 200 chars): gateway failure pages are full HTML and the stack only has boilerplate SDK HTTP frames, so logging it all just floods the log. */
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

    /** Async notification handling result. */
    public record AlipayNotifyResult(Status status, String orderNo, String tradeNo, Long paidAmountCents,
                                     String buyerLogonId, String buyerUserId) {

        public enum Status {PAID, NOT_PAID, INVALID}

        public static AlipayNotifyResult paid(String orderNo, String tradeNo, Long cents,
                                              String buyerLogonId, String buyerUserId) {
            return new AlipayNotifyResult(Status.PAID, orderNo, tradeNo, cents, buyerLogonId, buyerUserId);
        }

        public static AlipayNotifyResult notPaid() {
            return new AlipayNotifyResult(Status.NOT_PAID, null, null, null, null, null);
        }

        public static AlipayNotifyResult invalid() {
            return new AlipayNotifyResult(Status.INVALID, null, null, null, null, null);
        }
    }
}
