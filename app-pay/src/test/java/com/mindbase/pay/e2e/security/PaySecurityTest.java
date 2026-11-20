package com.mindbase.pay.e2e.security;

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

import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * app-pay 安全测试（黑盒，Java，src/test）。
 *
 * <p>前置：先启动独立测试环境：
 * <pre>
 *   cd app-pay
 *   mvn -DskipTests package
 *   docker compose -f docker-compose.test.yml up -d --build
 * </pre>
 * 运行：{@code mvn test -Dtest=PaySecurityTest}
 *
 * <p>覆盖本轮 P0/P1 安全边界：
 * <ul>
 *   <li>/internal/pay/* 的 X-Internal-Key 服务端二次校验；</li>
 *   <li>/test/pay/* 测试入口 token；</li>
 *   <li>需要用户身份的接口必须带 X-Uid；</li>
 *   <li>订单 IDOR（他人订单/他人确认支付）；</li>
 *   <li>伪造支付宝回调；</li>
 *   <li>错误响应不泄漏堆栈/SQL。</li>
 * </ul>
 *
 * <p>日志：每个检查输出 check/expected/actual/body（截断），失败时先 log.error 再断言；
 * 服务未启动时自动跳过（Assumptions），不会让普通 mvn test 失败。
 */
@DisplayName("app-pay security tests (black-box)")
class PaySecurityTest {

    private static final Logger log = LoggerFactory.getLogger(PaySecurityTest.class);
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final AtomicLong UID_GENERATOR =
            new AtomicLong(System.currentTimeMillis() * 1000L);

    private static PayTestConfig config;
    private static PayTestHttpClient http;
    private static boolean serviceHealthy;

    @BeforeAll
    static void setUp() {
        // 只加载配置/做一次健康检查；是否执行放到 @BeforeEach 判断，
        // 避免整个测试类在 @BeforeAll 被 abort 后 IntelliJ 显示 exit code -1。
        config = PayTestConfig.load();
        log.info("[security] test log file: logs/app-tests.log (relative to app-pay)");
        log.info("[security] test config baseUrl={} testEnabled={} securityEnabled={}",
                config.baseUrl(), config.testEnabled(), config.securityEnabled());

        if (config.testEnabled() && config.securityEnabled()) {
            http = new PayTestHttpClient(config);
            serviceHealthy = http.healthy();
            if (serviceHealthy) {
                log.info("[security] ===== app-pay security test START =====");
                log.info("[security] app-pay reachable, security checks started");
            } else {
                log.error("[security] app-pay unreachable baseUrl={}; start it with "
                        + "docker compose -f docker-compose.test.yml up -d", config.baseUrl());
            }
        } else {
            log.warn("[security] SKIP: pay.test.enabled={} security.enabled={}",
                    config.testEnabled(), config.securityEnabled());
        }
    }

    /** 每个用例执行前判断前置条件；不满足时该用例标记为 skipped（进程退出码 0）。 */
    @BeforeEach
    void checkPreconditions() {
        Assumptions.assumeTrue(config.testEnabled(),
                "pay.test.enabled=false; skipping security tests");
        Assumptions.assumeTrue(config.securityEnabled(),
                "security.enabled=false; skipping security tests");
        Assumptions.assumeTrue(serviceHealthy,
                "app-pay test environment is not running: " + config.baseUrl());
    }

    @AfterAll
    static void tearDown() {
        log.info("[security] ===== app-pay security test END =====");
        if (http != null) {
            http.close();
        }
    }

    // ==================== 基础存活/认证 ====================

    @Test
    @DisplayName("health endpoints: /health/live and /health are UP")
    void healthEndpointsAreUp() throws Exception {
        PayTestHttpClient.HttpResult live = http.get("/health/live", Map.of());
        expectStatus("health/live", live, 200);
        expectTrue("health/live contains UP", live.bodyOrEmpty().contains("UP"), live);

        PayTestHttpClient.HttpResult db = http.get("/health", Map.of());
        expectStatus("health/db", db, 200);
        expectTrue("health/db contains UP", db.bodyOrEmpty().contains("UP"), db);
    }

    @Test
    @DisplayName("user endpoints require X-Uid (401 without, 200 with)")
    void userEndpointsRequireUidHeader() throws Exception {
        // /pay/products 是公开商品列表，不校验 X-Uid；这里选 /pay/membership（必须识别用户身份）
        String path = "/pay/membership";

        PayTestHttpClient.HttpResult missing = http.get(path, Map.of());
        expectStatus("membership without X-Uid", missing, 401);
        expectCode("membership without X-Uid", missing, "UNAUTHORIZED");

        PayTestHttpClient.HttpResult withUid = http.getWithUid(path, 10086L);
        expectStatus("membership with X-Uid", withUid, 200);
        expectTrue("membership body contains active", withUid.bodyOrEmpty().contains("active"), withUid);

        PayTestHttpClient.HttpResult invalid = http.get(path, Map.of("X-Uid", "abc"));
        expectStatus("membership with invalid X-Uid", invalid, 401);
    }

    // ==================== 内部接口：服务端二次鉴权 ====================

    @Test
    @DisplayName("internal membership: 401 without/wrong key, 200 with correct key")
    void internalMembershipRequiresInternalKey() throws Exception {
        String path = "/internal/pay/membership/10086";

        PayTestHttpClient.HttpResult noKey = http.get(path, Map.of());
        expectStatus("internal membership without key", noKey, 401);
        expectCode("internal membership without key", noKey, "UNAUTHORIZED");

        PayTestHttpClient.HttpResult wrongKey = http.get(path, Map.of("X-Internal-Key", "wrong-key"));
        expectStatus("internal membership with wrong key", wrongKey, 401);
        expectCode("internal membership with wrong key", wrongKey, "UNAUTHORIZED");

        PayTestHttpClient.HttpResult ok = http.getInternal(path);
        expectStatus("internal membership with correct key", ok, 200);
        expectTrue("internal membership body contains uid", ok.bodyOrEmpty().contains("\"uid\":10086"), ok);
    }

    @Test
    @DisplayName("internal grant: 401 without/wrong key; 400 with correct key and invalid body")
    void internalGrantRequiresInternalKey() throws Exception {
        String path = "/internal/pay/grant";
        String invalidBody = "{}";

        PayTestHttpClient.HttpResult noKey = http.postJson(path, invalidBody, Map.of());
        expectStatus("internal grant without key", noKey, 401);
        expectCode("internal grant without key", noKey, "UNAUTHORIZED");

        PayTestHttpClient.HttpResult wrongKey = http.postJson(path, invalidBody,
                Map.of("X-Internal-Key", "wrong-key"));
        expectStatus("internal grant with wrong key", wrongKey, 401);

        // 正确 key + 缺字段：应在参数校验层 400，而不是真的开通会员
        PayTestHttpClient.HttpResult invalidPayload = http.postJson(path, invalidBody,
                Map.of("X-Internal-Key", config.internalKey()));
        expectStatus("internal grant with correct key but invalid payload", invalidPayload, 400);
        expectCode("internal grant validation", invalidPayload, "VALIDATION_ERROR");
    }

    @Test
    @DisplayName("internal refund: 401 without/wrong internal key")
    void internalRefundRequiresInternalKey() throws Exception {
        String path = "/internal/pay/orders/POINVALID/refund";
        String body = "{\"reason\":\"security-test\",\"revokeMembership\":true}";

        PayTestHttpClient.HttpResult noKey = http.postJson(path, body, Map.of());
        expectStatus("internal refund without key", noKey, 401);
        expectCode("internal refund without key", noKey, "UNAUTHORIZED");

        PayTestHttpClient.HttpResult wrongKey = http.postJson(path, body,
                Map.of("X-Internal-Key", "wrong-key"));
        expectStatus("internal refund with wrong key", wrongKey, 401);
        expectCode("internal refund with wrong key", wrongKey, "UNAUTHORIZED");
    }

    @Test
    @DisplayName("timeout executor: 401 without/wrong token")
    void timeoutExecutorRequiresToken() throws Exception {
        String path = "/internal/pay/timeout/execute";
        String body = "{\"orderNo\":\"PO1\",\"version\":1}";

        PayTestHttpClient.HttpResult noToken = http.postJson(path, body, Map.of());
        expectStatus("timeout executor without token", noToken, 401);
        expectCode("timeout executor without token", noToken, "UNAUTHORIZED");

        PayTestHttpClient.HttpResult wrongToken = http.postJson(path + "?token=wrong", body, Map.of());
        expectStatus("timeout executor with wrong token", wrongToken, 401);
        expectCode("timeout executor with wrong token", wrongToken, "UNAUTHORIZED");
    }

    // ==================== 测试入口令牌 ====================

    @Test
    @DisplayName("test entry: 401 without/wrong token, order created with correct token")
    void testEntryRequiresToken() throws Exception {
        String path = "/test/pay/orders";
        String body = "{\"uid\":" + nextUid()
                + ",\"skuCode\":\"VIP_MONTHLY\",\"channel\":\"MOCK\"}";

        PayTestHttpClient.HttpResult noToken = http.postJson(path, body, Map.of());
        expectStatus("test entry without token", noToken, 401);
        expectCode("test entry without token", noToken, "UNAUTHORIZED");

        PayTestHttpClient.HttpResult wrongToken = http.postJson(path, body,
                Map.of("X-Test-Token", "wrong-test-token"));
        expectStatus("test entry with wrong token", wrongToken, 401);

        PayTestHttpClient.HttpResult ok = http.testEntryPostJson(path, body);
        expectStatus("test entry with correct token", ok, 200);
        expectTrue("create order returns orderNo",
                PayTestHttpClient.extractOrderNo(ok.bodyOrEmpty()) != null, ok);
    }

    // ==================== 越权（IDOR） ====================

    @Test
    @DisplayName("order ownership (IDOR): other user gets 404 and cannot confirm payment")
    void orderOwnershipIsEnforced() throws Exception {
        long owner = nextUid();
        long other = owner + 1;

        PayTestHttpClient.HttpResult created = http.testEntryPostJson("/test/pay/orders",
                "{\"uid\":" + owner + ",\"skuCode\":\"VIP_MONTHLY\",\"channel\":\"MOCK\"}");
        expectStatus("create order for owner", created, 200);
        String orderNo = PayTestHttpClient.extractOrderNo(created.bodyOrEmpty());
        expectTrue("create order returns orderNo", orderNo != null && !orderNo.isBlank(), created);

        PayTestHttpClient.HttpResult ownerRead = http.getWithUid("/pay/orders/" + orderNo, owner);
        expectStatus("owner reads own order", ownerRead, 200);

        PayTestHttpClient.HttpResult otherRead = http.getWithUid("/pay/orders/" + orderNo, other);
        expectStatus("other user reads order", otherRead, 404);
        expectCode("other user reads order", otherRead, "ORDER_NOT_FOUND");

        PayTestHttpClient.HttpResult otherPay = http.testEntryPostJson("/test/pay/mock-pay",
                "{\"uid\":" + other + ",\"orderNo\":\"" + orderNo + "\"}");
        expectStatus("other user confirms payment", otherPay, 404);

        PayTestHttpClient.HttpResult ownerPay = http.testEntryPostJson("/test/pay/mock-pay",
                "{\"uid\":" + owner + ",\"orderNo\":\"" + orderNo + "\"}");
        expectStatus("owner confirms payment", ownerPay, 200);
        expectTrue("owner payment delivered", ownerPay.bodyOrEmpty().contains("DELIVERED"), ownerPay);
    }

    // ==================== 回调伪造与错误响应 ====================

    @Test
    @DisplayName("forged Alipay callback returns fail")
    void forgedAlipayCallbackIsRejected() throws Exception {
        String form = "out_trade_no=POFORGED123"
                + "&trade_status=TRADE_SUCCESS"
                + "&total_amount=0.01"
                + "&app_id=fake-app"
                + "&sign=fake-sign"
                + "&sign_type=RSA2";

        PayTestHttpClient.HttpResult result = http.postForm("/pay/callback/alipay", form, Map.of());
        expectStatus("forged alipay callback", result, 200);
        expectTrue("forged callback returns fail", "fail".equals(result.bodyOrEmpty().trim()), result);
    }

    @Test
    @DisplayName("error responses do not leak stack traces or SQL")
    void errorResponsesDoNotLeakInternals() throws Exception {
        PayTestHttpClient.HttpResult missing = http.getWithUid("/pay/orders/POINVALID", 10086L);
        expectStatus("unknown order", missing, 404);
        expectCode("unknown order", missing, "ORDER_NOT_FOUND");

        String body = missing.bodyOrEmpty();
        expectTrue("error body has no Exception", !body.contains("Exception"), missing);
        expectTrue("error body has no java. package", !body.contains("java."), missing);
        expectTrue("error body has no SQL", !body.contains("SQL"), missing);
        expectTrue("error body has no stack trace", !body.contains("at com.mindbase"), missing);
    }

    // ==================== 断言/日志工具 ====================

    /** 断言状态码；无论通过与否都先输出一条结构化日志。 */
    private static void expectStatus(String check, PayTestHttpClient.HttpResult result, int expected) {
        log.info("[security] check={} expectedStatus={} actualStatus={} body={}",
                check, expected, result.status(), snippet(result.bodyOrEmpty()));
        if (result.status() != expected) {
            log.error("[security] FAIL check={} expectedStatus={} actualStatus={} body={}",
                    check, expected, result.status(), snippet(result.bodyOrEmpty()));
        }
        assertThat(result.status())
                .as("%s: expected HTTP %d, actual body=%s", check, expected, snippet(result.bodyOrEmpty()))
                .isEqualTo(expected);
    }

    /** 断言统一错误体的 code。 */
    private static void expectCode(String check, PayTestHttpClient.HttpResult result, String expectedCode) {
        String actualCode = codeOf(result);
        log.info("[security] check={} expectedCode={} actualCode={}", check, expectedCode, actualCode);
        if (!expectedCode.equals(actualCode)) {
            log.error("[security] FAIL check={} expectedCode={} actualCode={} body={}",
                    check, expectedCode, actualCode, snippet(result.bodyOrEmpty()));
        }
        assertThat(actualCode)
                .as("%s: expected code %s, actual body=%s", check, expectedCode, snippet(result.bodyOrEmpty()))
                .isEqualTo(expectedCode);
    }

    /** 断言布尔条件（带响应体上下文）。 */
    private static void expectTrue(String check, boolean condition, PayTestHttpClient.HttpResult result) {
        log.info("[security] check={} result={} status={} body={}",
                check, condition ? "PASS" : "FAIL", result.status(), snippet(result.bodyOrEmpty()));
        if (!condition) {
            log.error("[security] FAIL check={} status={} body={}",
                    check, result.status(), snippet(result.bodyOrEmpty()));
        }
        assertThat(condition)
                .as("%s: status=%d body=%s", check, result.status(), snippet(result.bodyOrEmpty()))
                .isTrue();
    }

    /** 每次生成不同 uid，避免重复购买墙/存量数据影响安全用例。 */
    private static long nextUid() {
        return UID_GENERATOR.incrementAndGet();
    }

    /** 解析统一错误体的 code 字段（响应不是 JSON 时返回空串）。 */
    private static String codeOf(PayTestHttpClient.HttpResult result) {
        try {
            JsonNode root = MAPPER.readTree(result.bodyOrEmpty());
            return root.path("code").asText("");
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