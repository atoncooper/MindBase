package com.mindbase.pay.common;

import com.mindbase.pay.config.PayProperties;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/**
 * /internal/pay/* 的服务端鉴权（纵深防御，P0）。
 *
 * <p>APISIX 的 key-auth / consumer-restriction 只对“经网关的请求”生效：app-pay 容器同时监听
 * 0.0.0.0:8002 并接入共享容器网络，任何同网络容器（被 SSRF/被攻破的业务服务）都能直连
 * /internal/pay/grant、/internal/pay/orders/{orderNo}/refund。因此服务端必须再校验一个只有网关/调用方
 * 知道的内部 key（与 app-content/app-cloud 的 X-Internal-Key 约定一致）。
 *
 * <p>行为：
 * - 未配置 api-key：fail-closed 503（资金服务不允许“未配置 = 放行”）；
 * - 缺失/错误：401 + 审计/指标，请求不进入业务层；
 * - 常量时间比较，避免计时侧信道。
 *
 * <p>例外：/internal/pay/timeout/execute 由 app-task 直接 POST（不经 APISIX，URL 携带一次性
 * executor token），该路径仅由控制器校验 token，并由 docker profile 启动自检强制 token 非空。
 */
@Slf4j
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 10)
@RequiredArgsConstructor
public class InternalAuthFilter extends OncePerRequestFilter {

    static final String HEADER = "X-Internal-Key";
    private static final String EXEMPT_PATH = "/internal/pay/timeout/execute";

    private final PayProperties props;
    private final PayMetrics metrics;

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String uri = request.getRequestURI();
        if (!uri.startsWith("/internal/")) {
            return true;
        }
        // app-task 的回调直接打容器端口（executor_url），不带 X-Internal-Key；由 token 单独守门
        return EXEMPT_PATH.equals(uri);
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        String expected = props.internal() == null ? null : props.internal().apiKey();
        if (expected == null || expected.isBlank()) {
            log.error("[PAY] internal_auth_not_configured uri={} -- refusing internal request", request.getRequestURI());
            metrics.internalAuthRejected();
            reject(response, HttpServletResponse.SC_SERVICE_UNAVAILABLE,
                    "INTERNAL_AUTH_NOT_CONFIGURED",
                    "Internal API key is not configured; refusing M2M request");
            return;
        }
        String got = request.getHeader(HEADER);
        if (got == null || !MessageDigest.isEqual(
                expected.getBytes(StandardCharsets.UTF_8), got.trim().getBytes(StandardCharsets.UTF_8))) {
            log.warn("[PAY] internal_auth_rejected uri={} remote={}", request.getRequestURI(), request.getRemoteAddr());
            metrics.internalAuthRejected();
            reject(response, HttpServletResponse.SC_UNAUTHORIZED,
                    "UNAUTHORIZED", "Invalid internal credentials");
            return;
        }
        chain.doFilter(request, response);
    }

    private static void reject(HttpServletResponse response, int status, String code, String message)
            throws IOException {
        response.setStatus(status);
        response.setContentType("application/json;charset=UTF-8");
        response.getWriter().write("{\"code\":\"" + code + "\",\"message\":\"" + message + "\"}");
    }
}
