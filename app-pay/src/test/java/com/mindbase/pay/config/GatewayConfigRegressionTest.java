package com.mindbase.pay.config;

import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * 网关/运维配置回归：这些改动没有编译期约束（APISIX YAML / OpenResty / 告警规则），
 * 很容易在后续调路由时被静默改回去，因此用字符串断言守住关键安全/可用性契约。
 *
 * <p>只在仓库根目录布局下运行（从 app-pay 模块执行 mvn test）；隔离构建/镜像构建跳过。
 */
class GatewayConfigRegressionTest {

    private static String apisix;
    private static String openresty;
    private static String renderScript;
    private static String alerts;

    @BeforeAll
    static void load() throws IOException {
        Path moduleDir = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        Path root = moduleDir.getFileName().toString().equals("app-pay") ? moduleDir.getParent() : moduleDir;
        Path apisixTpl = root.resolve("apisix/apisix.yaml.template");
        Path locations = root.resolve("openresty/locations.conf");
        Path render = root.resolve("apisix/render-config.sh");
        Path alertRules = root.resolve("ops/archive/app-pay/monitoring/app-pay-alerts.rules.yml");
        assumeTrue(Files.exists(apisixTpl) && Files.exists(locations) && Files.exists(render)
                        && Files.exists(alertRules),
                "repository root layout not present; skipping gateway config regression");
        apisix = Files.readString(apisixTpl, StandardCharsets.UTF_8);
        openresty = Files.readString(locations, StandardCharsets.UTF_8);
        renderScript = Files.readString(render, StandardCharsets.UTF_8);
        alerts = Files.readString(alertRules, StandardCharsets.UTF_8);
    }

    @Test
    void payInternalRoutesInjectServiceSideKey() {
        // 所有 /internal/pay/* 路由必须注入 X-Internal-Key（app-pay 服务侧 fail-closed 校验）
        assertThat(apisix).contains("X-Internal-Key: \"__PAY_INTERNAL_KEY__\"");
        assertThat(renderScript).contains("PAY_INTERNAL_KEY");
        assertThat(renderScript).contains("pay_internal=");
    }

    @Test
    void grantUsesNoRetryUpstream() {
        // 非幂等资金写：网关不得重试（重试只能由调用方携带同一 requestId 发起）
        assertThat(apisix).contains("id: upstream-app-pay-no-retry");
        assertThat(apisix).contains("upstream_id: upstream-app-pay-no-retry");
        assertThat(apisix).contains("retries: 0");
    }

    @Test
    void gatewayUsesLivenessProbeAndRealClientIpForCallbacks() {
        // 连接池饱和不能触发整站摘除；回调限流必须按真实客户端 IP（remote_addr 在边缘转发下是边缘 IP）
        assertThat(apisix).contains("http_path: /health/live");
        assertThat(apisix).contains("key: http_x_forwarded_for");
    }

    @Test
    void callbackBodyIsBoundedAtEdge() {
        assertThat(openresty).contains("location ^~ /mindbase/api/v1/pay/callback/");
        assertThat(openresty).contains("location ^~ /pay/callback/");
        assertThat(openresty).contains("client_max_body_size 1m;");
    }

    @Test
    void alertsReferenceMetricsThatActuallyExist() {
        // 历史回归：AppPayJobStalled 曾引用不存在的指标，告警永不触发
        assertThat(alerts).contains("pay_job_last_run");
        assertThat(alerts).doesNotContain("app_pay_job_last_run_timestamp_seconds");
        assertThat(alerts).contains("pay_callback_amount_mismatch_total");
        assertThat(alerts).contains("pay_internal_auth_rejected_total");
        assertThat(alerts).contains("pay_delivery_exhausted_total");
    }

    @Test
    void payUserRouteStripsBearerTokenBeforeUpstream() {
        // 支付服务不需要用户 token；减少会话凭据在服务间传播面
        assertThat(apisix).contains("remove: [X-Uid, X-Roles, Authorization]");
    }
}