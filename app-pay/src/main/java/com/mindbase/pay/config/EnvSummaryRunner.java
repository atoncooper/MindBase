package com.mindbase.pay.config;

import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.env.Environment;
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
