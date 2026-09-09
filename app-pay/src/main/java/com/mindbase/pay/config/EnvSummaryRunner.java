package com.mindbase.pay.config;

import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

import java.nio.file.Files;
import java.nio.file.Path;

/**
 * 启动环境自检：
 * 1. 打印环境摘要（TLS/mock/测试入口/真实渠道/数据库），跑错实例一眼可辨；
 * 2. TLS 证书缺失时拒绝启动并给出可操作提示——服务端强制 HTTPS（含本地），
 *    缺证书不能悄悄回退明文，资金数据不允许明文上线；
 * 3. 危险组合拒绝启动——测试入口与【真实网关的】支付渠道不可同时开启，
 *    防止测试流量打到真钱（沙箱网关 URL 含 sandbox 视为安全，允许在测试环境联调）。
 * 资金系统宁可起不来，不能带风险配置上线。
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

        if (testEnabled && alipayReal) {
            log.error("[PAY] unsafe_config: test entry and real (non-sandbox) payment channel "
                    + "cannot be enabled together -- refusing to start");
            throw new IllegalStateException(
                    "[PAY] unsafe_config: pay.test.enabled and real gateway (pay.alipay) cannot be enabled together; "
                            + "sandbox gateway (URL containing sandbox) is exempt. Prevents test traffic hitting real money.");
        }
    }

    /**
     * TLS 证书/私钥缺失时的明确报错（带生成指引），替代 Tomcat 底层 SSLException 堆栈。
     * 未配置属 Spring 自身启动失败的范畴，这里只对「配了但文件不存在」给出可操作提示。
     */
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
