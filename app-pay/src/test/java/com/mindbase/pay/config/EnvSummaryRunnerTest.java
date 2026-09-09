package com.mindbase.pay.config;

import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** 资金安全自检：测试入口 × 真实网关 = 拒绝启动；沙箱网关/关闭态放行；TLS 证书缺失拒绝启动。 */
class EnvSummaryRunnerTest {

    private static PayProperties props(boolean mock, boolean testEnabled, String testToken,
                                       boolean alipayEnabled, String gatewayUrl) {
        return new PayProperties(
                new PayProperties.Rdbms("jdbc:mysql://localhost/app_pay", "u", "p"),
                new PayProperties.Mock(mock),
                new PayProperties.Order(30),
                new PayProperties.Alipay(alipayEnabled, gatewayUrl, "app", "pk", "pbk", ""),
                new PayProperties.Test(testEnabled, testToken),
                null, null);
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
        // 生产形态：测试入口关闭 + 真实渠道开启 —— 合法
        var runner = new EnvSummaryRunner(props(false, false, "", true,
                "https://openapi.alipay.com/gateway.do"), new MockEnvironment());
        assertThatCode(() -> runner.run(null)).doesNotThrowAnyException();
    }

    @Test
    void nullSectionsDoNotBreakSummary() {
        var runner = new EnvSummaryRunner(new PayProperties(null, null, null, null, null, null, null),
                new MockEnvironment());
        assertThatCode(() -> runner.run(null)).doesNotThrowAnyException();
    }

    @Test
    void tlsEnabledWithMissingCertRefusesToStart() {
        // 服务端强制 HTTPS：证书文件不存在 = 带风险配置，拒绝启动（不能回退明文）
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
        // 应急逃生口：PAY_TLS_ENABLED=false 回退明文，不做证书文件检查
        var runner = new EnvSummaryRunner(props(true, true, "token", false, ""), env(
                "server.ssl.enabled", "false",
                "server.ssl.certificate", "certs/does-not-exist.crt"));
        assertThatCode(() -> runner.run(null)).doesNotThrowAnyException();
    }

    @Test
    void tlsEnabledWithoutConfiguredCertOnlyWarns() {
        // certificate 属性未配置属 Spring 自身启动失败的范畴，自检只警告不拦截
        var runner = new EnvSummaryRunner(props(true, true, "token", false, ""), env(
                "server.ssl.enabled", "true"));
        assertThatCode(() -> runner.run(null)).doesNotThrowAnyException();
    }
}
