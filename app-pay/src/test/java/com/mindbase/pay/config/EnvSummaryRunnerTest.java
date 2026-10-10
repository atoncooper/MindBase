package com.mindbase.pay.config;

import com.mindbase.pay.testutil.TestPayProperties;
import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Money-safety self-check: test entry x real gateway = refuse to start; sandbox gateway/disabled is allowed; missing TLS cert refuses to start; a required token must not be blank. */
class EnvSummaryRunnerTest {

    private static PayProperties props(boolean mock, boolean testEnabled, String testToken,
                                       boolean alipayEnabled, String gatewayUrl) {
        return TestPayProperties.builder()
                .mock(new PayProperties.Mock(mock))
                .test(new PayProperties.Test(testEnabled, testToken, false))
                .alipay(new PayProperties.Alipay(alipayEnabled, gatewayUrl, "app", "pk", "pbk", "", 2000, 5000))
                .build();
    }

    private static MockEnvironment env(String... pairs) {
        MockEnvironment e = new MockEnvironment();
        for (int i = 0; i + 1 < pairs.length; i += 2) {
            e.setProperty(pairs[i], pairs[i + 1]);
        }
        return e;
    }

    @Test
    void testEntryWithRealGatewayRefusesToStart() {
        var runner = new EnvSummaryRunner(props(true, true, "token", true,
                "https://openapi.alipay.com/gateway.do"), new MockEnvironment());
        assertThatThrownBy(() -> runner.run(null))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("cannot be enabled together");
    }

    @Test
    void testEntryWithSandboxGatewayIsAllowed() {
        var runner = new EnvSummaryRunner(props(true, true, "token", true,
                "https://openapi-sandbox.dl.alipaydev.com/gateway.do"), new MockEnvironment());
        assertThatCode(() -> runner.run(null)).doesNotThrowAnyException();
    }

    @Test
    void prodShapeConfigPasses() {
        // production shape: test entry disabled + real channel enabled -- valid
        var runner = new EnvSummaryRunner(props(false, false, "", true,
                "https://openapi.alipay.com/gateway.do"), new MockEnvironment());
        assertThatCode(() -> runner.run(null)).doesNotThrowAnyException();
    }

    @Test
    void nullSectionsDoNotBreakSummary() {
        var runner = new EnvSummaryRunner(
                new PayProperties(null, null, null, null, null, null, null, null, null),
                new MockEnvironment());
        assertThatCode(() -> runner.run(null)).doesNotThrowAnyException();
    }

    @Test
    void tlsEnabledWithMissingCertRefusesToStart() {
        // server enforces HTTPS: a missing certificate file = risky configuration, refuse to start (must not fall back to plaintext)
        var runner = new EnvSummaryRunner(props(true, true, "token", false, ""), env(
                "server.ssl.enabled", "true",
                "server.ssl.certificate", "certs/does-not-exist.crt",
                "server.ssl.certificate-private-key", "certs/does-not-exist.key"));
        assertThatThrownBy(() -> runner.run(null))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("gen-dev-cert");
    }

    @Test
    void tlsDisabledSkipsCertCheck() {
        // emergency escape hatch: PAY_TLS_ENABLED=false falls back to plaintext, no certificate file check
        var runner = new EnvSummaryRunner(props(true, true, "token", false, ""), env(
                "server.ssl.enabled", "false",
                "server.ssl.certificate", "certs/does-not-exist.crt"));
        assertThatCode(() -> runner.run(null)).doesNotThrowAnyException();
    }

    @Test
    void tlsEnabledWithoutConfiguredCertOnlyWarns() {
        // an unconfigured certificate property falls under Spring's own startup failure; the self-check only warns and does not block
        var runner = new EnvSummaryRunner(props(true, true, "token", false, ""), env(
                "server.ssl.enabled", "true"));
        assertThatCode(() -> runner.run(null)).doesNotThrowAnyException();
    }

    @Test
    void requireTokenWithBlankTokenRefusesToStart() {
        // test entry enabled + require-token=true but blank token = no authentication, refuse to start
        PayProperties props = TestPayProperties.builder()
                .mock(new PayProperties.Mock(true))
                .test(new PayProperties.Test(true, "", true))
                .build();
        var runner = new EnvSummaryRunner(props, new MockEnvironment());
        assertThatThrownBy(() -> runner.run(null))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("require-token");
    }
}
