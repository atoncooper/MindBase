package com.mindbase.pay.config;

import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.env.Environment;
import org.springframework.core.env.Profiles;
import org.springframework.stereotype.Component;

import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Startup environment self-check:
 * 1. Print an environment summary (TLS/mock/test entry/real channel/database) so a misconfigured instance is obvious at a glance;
 * 2. Refuse to start when the TLS certificate is missing and give actionable guidance -- the server enforces HTTPS (including locally),
 *    and a missing certificate must not silently fall back to plaintext; fund data is not allowed to go live in plaintext;
 * 3. Refuse to start on dangerous combinations -- the test entry and a [real-gateway] payment channel cannot be enabled together,
 *    preventing test traffic from hitting real money (a sandbox gateway URL containing "sandbox" is considered safe and allowed for integration testing in test environments).
 * A fund system should fail to start rather than go live with a risky configuration.
 */
@Slf4j
@Component
public record EnvSummaryRunner(PayProperties props, Environment env) implements ApplicationRunner {

    @Override
    public void run(ApplicationArguments args) {
        boolean testEnabled = props.test() != null && props.test().enabled();
        boolean alipayEnabled = props.alipay() != null && props.alipay().enabled();
        boolean alipayReal = alipayEnabled && props.alipay().gatewayUrl() != null
                && !props.alipay().gatewayUrl().contains("sandbox");
        boolean tlsEnabled = Boolean.parseBoolean(env.getProperty("server.ssl.enabled", "false"));
        String cert = env.getProperty("server.ssl.certificate");
        String key = env.getProperty("server.ssl.certificate-private-key");

        log.info("[PAY] env_summary tls_enabled={} tls_cert={} tls_key={} mock_enabled={} test_entry_enabled={} "
                        + "alipay_enabled={} alipay_gateway={} order_timeout_minutes={} rdbms={}",
                tlsEnabled, cert, key,
                props.mock() != null && props.mock().enabled(), testEnabled, alipayEnabled,
                props.alipay() != null ? props.alipay().gatewayUrl() : "-",
                props.order() != null ? props.order().timeoutMinutes() : "-",
                props.rdbms() != null ? props.rdbms().url() : "-");

        if (tlsEnabled) {
            requireTlsMaterial(cert, "server.ssl.certificate", "PAY_TLS_CERT");
            requireTlsMaterial(key, "server.ssl.certificate-private-key", "PAY_TLS_KEY");
        }

        // ── 生产形态（docker profile）强制项（P0/P2）──────────────────────────────
        // 资金服务“配置错了就拒绝启动”，而不是带着弱配置上线。
        if (env.acceptsProfiles(Profiles.of("docker"))) {
            if (!tlsEnabled) {
                log.error("[PAY] unsafe_config: docker profile requires TLS -- refusing to start in plaintext");
                throw new IllegalStateException(
                        "[PAY] unsafe_config: docker profile requires server.ssl.enabled=true "
                                + "(PAY_TLS_ENABLED=false is local troubleshooting only)");
            }
            String internalKey = props.internal() == null ? null : props.internal().apiKey();
            if (internalKey == null || internalKey.isBlank()) {
                log.error("[PAY] unsafe_config: /internal/pay/* X-Internal-Key is blank -- refusing to start");
                throw new IllegalStateException(
                        "[PAY] unsafe_config: pay.internal.api-key (PAY_INTERNAL_KEY / APISIX_CONSUMER_KEY) "
                                + "must be non-blank in docker profile: internal fund endpoints would otherwise "
                                + "accept any container on the network");
            }
            String executorToken = props.internal() == null ? null : props.internal().executorToken();
            if (executorToken == null || executorToken.isBlank()) {
                log.error("[PAY] unsafe_config: PAY_EXECUTOR_TOKEN is blank -- refusing to start");
                throw new IllegalStateException(
                        "[PAY] unsafe_config: pay.internal.executor-token (PAY_EXECUTOR_TOKEN) must be non-blank "
                                + "in docker profile; the timeout executor is directly reachable inside the network");
            }
            String dbPassword = props.rdbms() == null ? null : props.rdbms().password();
            if (dbPassword == null || dbPassword.isBlank()
                    || "app-pay".equals(dbPassword) || "root123".equals(dbPassword)
                    || "app-pay-test".equals(dbPassword)) {
                // 本地/内网 dev 形态允许默认口令（DB 仅回环 + TLS），但生产必须替换：
                // 这里告警而不阻断，避免把本地栈锁死；上线检查清单要求强随机口令。
                log.warn("[PAY] weak_db_password: docker profile is using a default/blank PAY_MYSQL_PASSWORD "
                        + "-- replace it with a strong secret before production deployment");
            }
            if (alipayEnabled && (props.alipay().notifyUrl() == null || props.alipay().notifyUrl().isBlank())) {
                // 纯查单模式是允许的（本地/无公网回调），但生产应为回调主路径：只告警不阻断
                log.warn("[PAY] alipay notify_url is empty -- payment detection relies on query polling "
                        + "(ChannelQueryJob + order-read sync); configure ALIPAY_NOTIFY_URL in production");
            }
        }

        // Test entry enabled + token required but blank = degraded to no authentication: refuse to start
        if (testEnabled && props.test().requireToken()
                && (props.test().token() == null || props.test().token().isBlank())) {
            log.error("[PAY] unsafe_config: pay.test.require-token=true but token is blank -- refusing to start");
            throw new IllegalStateException(
                    "[PAY] unsafe_config: pay.test.enabled with require-token=true requires a non-blank "
                            + "pay.test.token (env PAY_TEST_TOKEN); blank would leave /test/pay/* unauthenticated.");
        }

        // Test entry enabled with a blank token (guard() passes by default): the only remaining gate is the
        // loopback binding -- refuse unless server.address is explicitly loopback. Prevents the "bare jar on a
        // server with the base profile" shape where /test/pay/* and /pay/mock/confirm (any spoofable X-Uid)
        // are reachable from the LAN.
        if (testEnabled && (props.test().token() == null || props.test().token().isBlank())
                && !isLoopbackAddress(env.getProperty("server.address", ""))) {
            log.error("[PAY] unsafe_config: pay.test.enabled with a blank token but server.address='{}' is not "
                    + "loopback -- refusing to start", env.getProperty("server.address", ""));
            throw new IllegalStateException(
                    "[PAY] unsafe_config: pay.test.enabled with a blank token requires server.address=127.0.0.1 "
                            + "(local debugging only); set PAY_TEST_TOKEN or bind the loopback interface.");
        }

        if (testEnabled && alipayReal) {
            log.error("[PAY] unsafe_config: test entry and real (non-sandbox) payment channel "
                    + "cannot be enabled together -- refusing to start");
            throw new IllegalStateException(
                    "[PAY] unsafe_config: pay.test.enabled and real gateway (pay.alipay) cannot be enabled together; "
                            + "sandbox gateway (URL containing sandbox) is exempt. Prevents test traffic hitting real money.");
        }
    }

    /**
     * Explicit error when the TLS certificate/private key is missing (with generation guidance), replacing Tomcat's low-level
     * SSLException stack trace.
     * A missing configuration is Spring's own startup-failure domain; here we only give actionable guidance for "configured but file does not exist".
     */
    /** Explicitly configured loopback binding (the only remaining gate when the test entry has no token). */
    private static boolean isLoopbackAddress(String address) {
        return "127.0.0.1".equals(address) || "localhost".equals(address) || "::1".equals(address);
    }

    private void requireTlsMaterial(String path, String prop, String envVar) {
        if (path == null || path.isBlank()) {
            log.warn("[PAY] tls_material_missing: {} is not set while TLS is enabled "
                    + "-- startup will fail unless Spring can resolve key material", prop);
            return;
        }
        Path abs = Path.of(path).toAbsolutePath();
        if (!Files.exists(abs)) {
            log.error("[PAY] tls_material_missing: {} not found at {}", prop, abs);
            throw new IllegalStateException("[PAY] tls_material_missing: " + prop + " not found at " + abs
                    + ". Generate dev certs via app-pay/scripts/gen-dev-cert.sh (Git Bash) or gen-dev-cert.ps1 "
                    + "(PowerShell), or point " + envVar + " at an existing PEM cert/key pair.");
        }
    }
}
