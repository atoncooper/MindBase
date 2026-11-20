package com.mindbase.pay.e2e.flow;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.mindbase.pay.e2e.support.PayTestConfig;
import com.mindbase.pay.e2e.support.PayTestHttpClient;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Black-box business-flow tests against the running app-pay test environment.
 *
 * <p>Unlike {@code security.PaySecurityTest} (auth boundaries) these tests cover
 * the full money lifecycle: real user purchase, duplicate-purchase second wall,
 * operations refund, grant idempotency, cancel, order cap, idempotency key,
 * read/metadata endpoints, timeout version guard and QR failure behavior.
 *
 * <p>Prerequisite: {@code docker compose -f docker-compose.test.yml up -d};
 * run with {@code mvn test -Dtest=PayPurchaseFlowTest}.
 * When the environment is down the class is skipped (assumption).
 */
@DisplayName("app-pay purchase/refund/grant business flows")
class PayPurchaseFlowTest {

    private static final Logger log = LoggerFactory.getLogger(PayPurchaseFlowTest.class);
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final AtomicLong UID_GENERATOR =
            new AtomicLong(System.currentTimeMillis() * 1000L);
    private static final FlowMetrics METRICS = new FlowMetrics();

    private static PayTestConfig config;
    private static PayTestHttpClient http;
    private static boolean serviceHealthy;

    @BeforeAll
    static void setUp() {
        config = PayTestConfig.load();
        log.info("[flow] test log file: logs/app-tests.log (relative to app-pay)");
        log.info("[flow] test config baseUrl={} testEnabled={}",
                config.baseUrl(), config.testEnabled());
        if (config.testEnabled()) {
            http = new PayTestHttpClient(config);
            serviceHealthy = http.healthy();
            if (serviceHealthy) {
                log.info("[flow] ===== app-pay purchase flow test START =====");
            } else {
                log.error("[flow] app-pay unreachable baseUrl={}; start it with "
                        + "docker compose -f docker-compose.test.yml up -d", config.baseUrl());
            }
        } else {
            log.warn("[flow] SKIP: pay.test.enabled=false");
        }
    }

    @BeforeEach
    void checkPreconditions() {
        Assumptions.assumeTrue(config.testEnabled(), "pay.test.enabled=false; skipping flow tests");
        Assumptions.assumeTrue(serviceHealthy,
                "app-pay test environment is not running: " + config.baseUrl());
    }

    @AfterAll
    static void tearDown() {
        METRICS.log(log);
        log.info("[flow] ===== app-pay purchase flow test END =====");
        if (http != null) {
            http.close();
        }
    }

    // ==================== P0: money lifecycle ====================

    @Test
    @DisplayName("real user purchase: create order -> mock confirm -> DELIVERED + membership active")
    void purchaseDeliversMembership() throws Exception {
        long uid = nextUid();
        JsonNode created = createOrder(uid, "VIP_MONTHLY", "MOCK", null);
        String orderNo = created.path("orderNo").asText();
        expect(created.path("status").asText(), "CREATED", "created order status");

        JsonNode paid = confirm(uid, orderNo);
        expect(paid.path("status").asText(), "DELIVERED", "confirmed order status");

        JsonNode membership = membership(uid);
        expectTrue(membership.path("active").asBoolean(), "membership active after purchase");
        expect(membership.path("tier").asText(), "VIP", "membership tier");

        JsonNode order = getOrder(uid, orderNo);
        expect(order.path("status").asText(), "DELIVERED", "order detail status");
        METRICS.transaction("purchase");
        log.info("[flow] purchase delivered uid={} orderNo={}", uid, orderNo);
    }

    @Test
    @DisplayName("duplicate same-tier purchase: second payment is auto-refunded, membership not extended")
    void secondSameTierPurchaseIsAutoRefunded() throws Exception {
        long uid = nextUid();
        String first = createOrder(uid, "VIP_MONTHLY", "MOCK", null).path("orderNo").asText();
        // create both orders before any delivery: membership is not active yet
        String second = createOrder(uid, "VIP_MONTHLY", "MOCK", null).path("orderNo").asText();

        confirm(uid, first);
        JsonNode secondPaid = confirm(uid, second);
        expect(secondPaid.path("status").asText(), "REFUNDED",
                "duplicate payment should be auto-refunded (REFUND_HOLD means manual refund failed)");

        JsonNode membership = membership(uid);
        expectTrue(membership.path("active").asBoolean(), "membership remains active");
        METRICS.transaction("duplicate_purchase_refund");
        log.info("[flow] duplicate purchase refunded uid={} first={} second={}",
                uid, first, second);
    }

    @Test
    @DisplayName("operations refund: DELIVERED -> REFUNDED + membership revoked, second call idempotent")
    void refundRevokesMembershipIdempotently() throws Exception {
        long uid = nextUid();
        String orderNo = createOrder(uid, "VIP_MONTHLY", "MOCK", null).path("orderNo").asText();
        confirm(uid, orderNo);
        expectTrue(membership(uid).path("active").asBoolean(), "membership active before refund");

        JsonNode refunded = internalRefund(orderNo, true, "flow-refund-" + orderNo);
        expect(refunded.path("status").asText(), "REFUNDED", "refund status");
        expectFalse(membership(uid).path("active").asBoolean(), "membership revoked after refund");

        JsonNode replay = internalRefund(orderNo, true, "flow-refund-replay-" + orderNo);
        expect(replay.path("status").asText(), "REFUNDED", "refund replay is idempotent");
        METRICS.transaction("refund");
        log.info("[flow] refund revoked membership uid={} orderNo={}", uid, orderNo);
    }

    @Test
    @DisplayName("grant: same requestId only extends once")
    void grantRequestIsIdempotent() throws Exception {
        long uid = nextUid();
        String requestId = "flow-grant-" + uid;
        JsonNode first = grant(uid, 3, requestId);
        expectTrue(first.path("active").asBoolean(), "granted membership active");

        // Read the persisted value (DATETIME(6)) before replay: MySQL truncates
        // nanoseconds, so comparing the first in-memory response to the replay
        // would fail on sub-microsecond precision alone.
        String firstExpire = membership(uid).path("expireAt").asText();

        JsonNode replay = grant(uid, 3, requestId);
        expect(replay.path("expireAt").asText(), firstExpire,
                "grant replay with same requestId must not extend expireAt");
        METRICS.transaction("grant");
        log.info("[flow] grant idempotent uid={} requestId={} expireAt={}",
                uid, requestId, firstExpire);
    }

    @Test
    @DisplayName("cancel: CREATED -> CLOSED, second cancel rejected")
    void cancelCreatedOrder() throws Exception {
        long uid = nextUid();
        String orderNo = createOrder(uid, "VIP_MONTHLY", "MOCK", null).path("orderNo").asText();
        JsonNode cancelled = cancel(uid, orderNo);
        expect(cancelled.path("status").asText(), "CLOSED", "cancelled order status");

        PayTestHttpClient.HttpResult again = cancelRaw(uid, orderNo);
        expect(again.status(), 409, "second cancel status");
        expect(codeOf(again), "ORDER_NOT_CANCELLABLE", "second cancel code");
        METRICS.transaction("cancel");
        log.info("[flow] cancel order uid={} orderNo={}", uid, orderNo);
    }

    // ==================== P1: boundaries ====================

    @Test
    @DisplayName("unpaid order cap: 51st open order returns 429")
    void openOrderCapReturns429() throws Exception {
        long uid = nextUid();
        List<String> orderNos = new ArrayList<>();
        try {
            for (int i = 1; i <= 50; i++) {
                JsonNode created = createOrder(uid, "VIP_MONTHLY", "MOCK", null);
                orderNos.add(created.path("orderNo").asText());
            }
            PayTestHttpClient.HttpResult overflow = createOrderRaw(uid, "VIP_MONTHLY", "MOCK", null);
            expect(overflow.status(), 429, "51st open order status");
            expect(codeOf(overflow), "TOO_MANY_OPEN_ORDERS", "51st open order code");
            METRICS.transaction("open_order_cap");
            log.info("[flow] open-order cap reached uid={} created={}", uid, orderNos.size());
        } finally {
            for (String orderNo : orderNos) {
                try {
                    cancel(uid, orderNo);
                } catch (Exception ignored) {
                    // cleanup best-effort
                }
            }
        }
    }

    @Test
    @DisplayName("idempotency key: repeated create returns the same order")
    void idempotencyKeyReusesOrder() throws Exception {
        long uid = nextUid();
        String key = "flow-idem-" + uid;
        String first = createOrder(uid, "VIP_MONTHLY", "MOCK", key).path("orderNo").asText();
        String second = createOrder(uid, "VIP_MONTHLY", "MOCK", key).path("orderNo").asText();
        expect(second, first, "same idempotency key should return the same orderNo");
        METRICS.transaction("idempotency_key");
        log.info("[flow] idempotency key uid={} key={} orderNo={}", uid, key, first);
    }

    @Test
    @DisplayName("read and metadata endpoints respond with expected shapes")
    void readAndMetadataEndpoints() throws Exception {
        long uid = nextUid();
        String orderNo = createOrder(uid, "VIP_MONTHLY", "MOCK", null).path("orderNo").asText();

        expectList("/pay/orders?limit=5", uid, "orders list");
        expectList("/pay/tiers", uid, "tiers");
        expectList("/pay/comparison", uid, "comparison");
        expectList("/pay/channels", uid, "channels");
        expectList("/pay/upgrade-quotes", uid, "upgrade quotes");
        expectList("/pay/products", uid, "products");

        JsonNode detail = getOrder(uid, orderNo);
        expectTrue(!detail.path("orderNo").asText().isBlank(), "order detail contains orderNo");
        METRICS.transaction("read_metadata");
        log.info("[flow] read/metadata endpoints ok uid={}", uid);
    }

    @Test
    @DisplayName("timeout executor version mismatch leaves the order CREATED")
    void timeoutVersionMismatchDoesNotCloseOrder() throws Exception {
        long uid = nextUid();
        String orderNo = createOrder(uid, "VIP_MONTHLY", "MOCK", null).path("orderNo").asText();
        String body = "{\"orderNo\":\"" + orderNo + "\",\"version\":999}";
        PayTestHttpClient.HttpResult result = http.postJson(
                "/internal/pay/timeout/execute?token=" + config.executorToken(), body, Map.of());
        expect(result.status(), 200, "timeout executor mismatch status");
        JsonNode payload = json(result);
        expectFalse(payload.path("executed").asBoolean(true),
                "version mismatch must not execute timeout close");
        expect(getOrder(uid, orderNo).path("status").asText(), "CREATED",
                "order stays CREATED after version mismatch");
        METRICS.transaction("timeout_guard");
    }

    @Test
    @DisplayName("QR endpoint for MOCK fails with 400 (not 500)")
    void mockQrFailsGracefully() throws Exception {
        long uid = nextUid();
        String orderNo = createOrder(uid, "VIP_MONTHLY", "MOCK", null).path("orderNo").asText();
        PayTestHttpClient.HttpResult result = http.get(
                "/pay/orders/" + orderNo + "/qr", Map.of("X-Uid", String.valueOf(uid)));
        expect(result.status(), 400, "MOCK QR status");
        expect(codeOf(result), "QR_NOT_AVAILABLE", "MOCK QR code");
        METRICS.transaction("mock_qr_guard");
    }


    @Test
    @DisplayName("create order validation: X-Uid / SKU / channel errors")
    void createOrderValidation() throws Exception {
        long uid = nextUid();
        String validBody = "{\"skuCode\":\"VIP_MONTHLY\",\"channel\":\"MOCK\"}";

        PayTestHttpClient.HttpResult noUid = call("POST /pay/orders",
                () -> http.postJson("/pay/orders", validBody, Map.of()));
        expect(noUid.status(), 401, "create order without X-Uid");

        String unknownSku = "{\"skuCode\":\"NO_SUCH_SKU\",\"channel\":\"MOCK\"}";
        PayTestHttpClient.HttpResult sku = call("POST /pay/orders",
                () -> http.postJson("/pay/orders", unknownSku,
                        Map.of("X-Uid", String.valueOf(uid))));
        expect(sku.status(), 404, "create order with unknown SKU");
        expect(codeOf(sku), "SKU_NOT_FOUND", "unknown SKU code");

        String badChannel = "{\"skuCode\":\"VIP_MONTHLY\",\"channel\":\"NOT_A_CHANNEL\"}";
        PayTestHttpClient.HttpResult channel = call("POST /pay/orders",
                () -> http.postJson("/pay/orders", badChannel,
                        Map.of("X-Uid", String.valueOf(uid))));
        expect(channel.status(), 400, "create order with invalid channel");

        String badSkuBlank = "{\"skuCode\":\"\",\"channel\":\"MOCK\"}";
        PayTestHttpClient.HttpResult blank = call("POST /pay/orders",
                () -> http.postJson("/pay/orders", badSkuBlank,
                        Map.of("X-Uid", String.valueOf(uid))));
        expect(blank.status(), 400, "create order with blank SKU");
        METRICS.transaction("create_order_validation");
    }

    @Test
    @DisplayName("payment state machine: second confirm / QR / cancel on DELIVERED are rejected")
    void paymentStateMachineRejectsInvalidTransitions() throws Exception {
        long uid = nextUid();
        String orderNo = createOrder(uid, "VIP_MONTHLY", "MOCK", null).path("orderNo").asText();
        confirm(uid, orderNo);

        PayTestHttpClient.HttpResult secondConfirm = call("POST /pay/mock/confirm",
                () -> http.postJson("/pay/mock/confirm",
                        "{\"orderNo\":\"" + orderNo + "\"}",
                        Map.of("X-Uid", String.valueOf(uid))));
        expect(secondConfirm.status(), 409, "second confirm status");
        expect(codeOf(secondConfirm), "ORDER_NOT_PAYABLE", "second confirm code");

        PayTestHttpClient.HttpResult qr = call("GET /pay/orders/{orderNo}/qr",
                () -> http.get("/pay/orders/" + orderNo + "/qr",
                        Map.of("X-Uid", String.valueOf(uid))));
        expect(qr.status(), 409, "QR on DELIVERED order");
        expect(codeOf(qr), "ORDER_NOT_PAYABLE", "QR on DELIVERED order code");

        PayTestHttpClient.HttpResult cancel = cancelRaw(uid, orderNo);
        expect(cancel.status(), 409, "cancel DELIVERED order");
        expect(codeOf(cancel), "ORDER_NOT_CANCELLABLE", "cancel DELIVERED code");
        METRICS.transaction("payment_state_machine_guard");
    }

    @Test
    @DisplayName("mock confirm validation: bad orderNo / unknown order")
    void mockConfirmValidation() throws Exception {
        long uid = nextUid();
        PayTestHttpClient.HttpResult badFormat = call("POST /pay/mock/confirm",
                () -> http.postJson("/pay/mock/confirm",
                        "{\"orderNo\":\"not-an-order\"}",
                        Map.of("X-Uid", String.valueOf(uid))));
        expect(badFormat.status(), 400, "mock confirm bad orderNo status");

        PayTestHttpClient.HttpResult notFound = call("POST /pay/mock/confirm",
                () -> http.postJson("/pay/mock/confirm",
                        "{\"orderNo\":\"PONOTFOUND123\"}",
                        Map.of("X-Uid", String.valueOf(uid))));
        expect(notFound.status(), 404, "mock confirm unknown order status");
        expect(codeOf(notFound), "ORDER_NOT_FOUND", "mock confirm unknown order code");
        METRICS.transaction("mock_confirm_validation");
    }

    @Test
    @DisplayName("test-entry surface: products/order/orders/membership/qr")
    void testEntrySurface() throws Exception {
        long uid = nextUid();
        String createBody = "{\"uid\":" + uid + ",\"skuCode\":\"VIP_MONTHLY\",\"channel\":\"MOCK\"}";
        JsonNode created = json(call("POST /test/pay/orders",
                () -> http.testEntryPostJson("/test/pay/orders", createBody)));
        String orderNo = created.path("order").path("orderNo").asText();
        expectTrue(!orderNo.isBlank(), "test-entry create returns orderNo");

        expectStatusOk(call("GET /test/pay/products",
                        () -> http.get("/test/pay/products",
                                Map.of("X-Test-Token", config.testToken()))),
                "test-entry products");
        expectStatusOk(call("GET /test/pay/order/{orderNo}",
                        () -> http.get("/test/pay/order/" + orderNo + "?uid=" + uid,
                                Map.of("X-Test-Token", config.testToken()))),
                "test-entry order detail");
        expectStatusOk(call("GET /test/pay/orders",
                        () -> http.get("/test/pay/orders?uid=" + uid,
                                Map.of("X-Test-Token", config.testToken()))),
                "test-entry orders");
        expectStatusOk(call("GET /test/pay/membership/{uid}",
                        () -> http.get("/test/pay/membership/" + uid,
                                Map.of("X-Test-Token", config.testToken()))),
                "test-entry membership");

        PayTestHttpClient.HttpResult qr = call("GET /test/pay/qr",
                () -> http.get("/test/pay/qr?text=hello",
                        Map.of("X-Test-Token", config.testToken())));
        expectStatusOk(qr, "test-entry qr");
        expectTrue(qr.bodyOrEmpty().length() > 0, "test-entry qr returns content");

        // cleanup the created order through the real user endpoint
        cancel(uid, orderNo);
        METRICS.transaction("test_entry_surface");
    }

    @Test
    @DisplayName("test-entry burst PAY_SAME: concurrent payment of one order delivers only once")
    void burstPaySameOrderIsIdempotent() throws Exception {
        long uid = nextUid();
        String orderNo = createOrder(uid, "VIP_MONTHLY", "MOCK", null).path("orderNo").asText();
        String body = "{\"mode\":\"PAY_SAME\",\"count\":5,\"uid\":" + uid
                + ",\"orderNo\":\"" + orderNo + "\"}";
        JsonNode result = json(call("POST /test/pay/burst",
                () -> http.testEntryPostJson("/test/pay/burst", body)));
        int paid = result.path("stats").path("PAY").asInt(0);
        expectTrue(paid >= 1, "at least one concurrent payment response succeeds");
        expect(getOrder(uid, orderNo).path("status").asText(), "DELIVERED",
                "order is delivered");

        // The key idempotency property is not the response count (concurrent
        // confirmations may all return the delivered state) but that membership
        // is extended exactly once: ~30 days, not 30 * number-of-successes.
        String expireAt = membership(uid).path("expireAt").asText();
        LocalDateTime expiry = LocalDateTime.parse(expireAt);
        expectTrue(expiry.isBefore(LocalDateTime.now().plusDays(31)),
                "membership extended for one 30-day period only");
        METRICS.transaction("concurrent_payment");
    }

    @Test
    @DisplayName("test-entry burst: create orders concurrently and clean up")
    void testEntryBurstCreateOrders() throws Exception {
        long uid = nextUid();
        String body = "{\"mode\":\"CREATE_ORDERS\",\"count\":2,\"uid\":" + uid
                + ",\"skuCode\":\"VIP_MONTHLY\"}";
        JsonNode result = json(call("POST /test/pay/burst",
                () -> http.testEntryPostJson("/test/pay/burst", body)));
        expect(result.path("stats").path("CREATE").asInt(0), 2, "burst CREATE count");
        for (JsonNode item : result.path("results")) {
            String raw = item.asText();
            if (raw.startsWith("CREATE:")) {
                cancel(uid, raw.substring("CREATE:".length()));
            }
        }
        METRICS.transaction("concurrent_create_orders");
    }

    @Test
    @DisplayName("internal refund-requests: key required, list readable with key")
    void internalRefundRequestsAuth() throws Exception {
        PayTestHttpClient.HttpResult noKey = call("GET /internal/pay/refund-requests",
                () -> http.get("/internal/pay/refund-requests", Map.of()));
        expect(noKey.status(), 401, "refund-requests without key");

        PayTestHttpClient.HttpResult withKey = call("GET /internal/pay/refund-requests",
                () -> http.get("/internal/pay/refund-requests",
                        Map.of("X-Internal-Key", config.internalKey())));
        expectStatusOk(withKey, "refund-requests with key");
        expectTrue(withKey.bodyOrEmpty().trim().startsWith("["),
                "refund-requests returns a JSON array");
        METRICS.transaction("refund_requests_query");
    }

    // ==================== helpers ====================

    @FunctionalInterface
    private interface HttpCall {
        PayTestHttpClient.HttpResult execute() throws Exception;
    }

    /** Execute one HTTP call and record operation-level latency/status metrics. */
    private static PayTestHttpClient.HttpResult call(String operation, HttpCall call) throws Exception {
        long startedAt = System.nanoTime();
        try {
            PayTestHttpClient.HttpResult result = call.execute();
            METRICS.record(operation, result, System.nanoTime() - startedAt);
            return result;
        } catch (Exception e) {
            METRICS.exception(operation, System.nanoTime() - startedAt);
            throw e;
        }
    }

    private static long nextUid() {
        return UID_GENERATOR.incrementAndGet();
    }

    private static PayTestHttpClient.HttpResult createOrderRaw(long uid, String sku, String channel,
                                                               String idempotencyKey) throws Exception {
        StringBuilder body = new StringBuilder("{\"skuCode\":\"").append(sku)
                .append("\",\"channel\":\"").append(channel).append("\"");
        if (idempotencyKey != null) {
            body.append(",\"idempotencyKey\":\"").append(idempotencyKey).append("\"");
        }
        body.append("}");
        return call("POST /pay/orders", () -> http.postJson("/pay/orders", body.toString(),
                Map.of("X-Uid", String.valueOf(uid))));
    }

    private static JsonNode createOrder(long uid, String sku, String channel, String idempotencyKey)
            throws Exception {
        PayTestHttpClient.HttpResult result = createOrderRaw(uid, sku, channel, idempotencyKey);
        expect(result.status(), 200, "create order status");
        return json(result);
    }

    private static JsonNode confirm(long uid, String orderNo) throws Exception {
        String body = "{\"orderNo\":\"" + orderNo + "\"}";
        PayTestHttpClient.HttpResult result = call("POST /pay/mock/confirm",
                () -> http.postJson("/pay/mock/confirm", body,
                        Map.of("X-Uid", String.valueOf(uid))));
        expect(result.status(), 200, "mock confirm status");
        return json(result);
    }

    private static JsonNode membership(long uid) throws Exception {
        PayTestHttpClient.HttpResult result = call("GET /pay/membership",
                () -> http.getWithUid("/pay/membership", uid));
        expect(result.status(), 200, "membership status");
        return json(result);
    }

    private static JsonNode getOrder(long uid, String orderNo) throws Exception {
        PayTestHttpClient.HttpResult result = call("GET /pay/orders/{orderNo}",
                () -> http.getWithUid("/pay/orders/" + orderNo, uid));
        expect(result.status(), 200, "order detail status");
        return json(result);
    }

    private static JsonNode cancel(long uid, String orderNo) throws Exception {
        PayTestHttpClient.HttpResult result = cancelRaw(uid, orderNo);
        expect(result.status(), 200, "cancel order status");
        return json(result);
    }

    private static PayTestHttpClient.HttpResult cancelRaw(long uid, String orderNo) throws Exception {
        return call("POST /pay/orders/{orderNo}/cancel",
                () -> http.postJson("/pay/orders/" + orderNo + "/cancel", "{}",
                        Map.of("X-Uid", String.valueOf(uid))));
    }

    private static JsonNode grant(long uid, int days, String requestId) throws Exception {
        String body = "{\"uid\":" + uid + ",\"durationDays\":" + days
                + ",\"reason\":\"flow-test\",\"tier\":\"VIP\",\"requestId\":\""
                + requestId + "\"}";
        PayTestHttpClient.HttpResult result = call("POST /internal/pay/grant",
                () -> http.postJson("/internal/pay/grant", body,
                        Map.of("X-Internal-Key", config.internalKey())));
        expect(result.status(), 200, "grant status");
        return json(result);
    }

    private static JsonNode internalRefund(String orderNo, boolean revokeMembership, String operator)
            throws Exception {
        String body = "{\"reason\":\"flow-test-refund\",\"revokeMembership\":"
                + revokeMembership + ",\"operator\":\"" + operator + "\",\"confirm\":false}";
        PayTestHttpClient.HttpResult result = call("POST /internal/pay/orders/{orderNo}/refund",
                () -> http.postJson("/internal/pay/orders/" + orderNo + "/refund", body,
                        Map.of("X-Internal-Key", config.internalKey())));
        expect(result.status(), 200, "refund status");
        return json(result);
    }

    private static void expectStatusOk(PayTestHttpClient.HttpResult result, String what) {
        log.info("[flow] check={} status={} body={}", what, result.status(),
                snippet(result.bodyOrEmpty()));
        if (result.status() < 200 || result.status() >= 300) {
            log.error("[flow] FAIL check={} status={} body={}", what, result.status(),
                    snippet(result.bodyOrEmpty()));
        }
        assertThat(result.status()).as(what).isBetween(200, 299);
    }

    private static void expectList(String path, long uid, String what) throws Exception {
        PayTestHttpClient.HttpResult result = call("GET " + path, () -> http.getWithUid(path, uid));
        expect(result.status(), 200, what + " status");
        expectTrue(result.bodyOrEmpty().trim().startsWith("["), what + " returns a JSON array");
    }

    private static void expectTrue(boolean condition, String what) {
        if (!condition) {
            log.error("[flow] FAIL: {}", what);
        }
        assertThat(condition).as(what).isTrue();
    }

    private static void expectFalse(boolean condition, String what) {
        if (condition) {
            log.error("[flow] FAIL: {}", what);
        }
        assertThat(condition).as(what).isFalse();
    }

    private static void expect(int actual, int expected, String what) {
        log.info("[flow] check={} expected={} actual={}", what, expected, actual);
        if (actual != expected) {
            log.error("[flow] FAIL check={} expected={} actual={}", what, expected, actual);
        }
        assertThat(actual).as(what).isEqualTo(expected);
    }

    private static void expect(String actual, String expected, String what) {
        log.info("[flow] check={} expected={} actual={}", what, expected, actual);
        if (!expected.equals(actual)) {
            log.error("[flow] FAIL check={} expected={} actual={}", what, expected, actual);
        }
        assertThat(actual).as(what).isEqualTo(expected);
    }

    private static JsonNode json(PayTestHttpClient.HttpResult result) throws Exception {
        return MAPPER.readTree(result.bodyOrEmpty());
    }

    private static String codeOf(PayTestHttpClient.HttpResult result) {
        try {
            return MAPPER.readTree(result.bodyOrEmpty()).path("code").asText("");
        } catch (Exception e) {
            return "";
        }
    }

    private static String snippet(String body) {
        if (body == null) {
            return "";
        }
        String oneLine = body.replaceAll("\\s+", " ").trim();
        return oneLine.length() <= 300 ? oneLine : oneLine.substring(0, 300) + "...(truncated)";
    }
}