package com.mindbase.pay.common;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import java.io.IOException;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** traceId 贯穿：复用合法上游 ID、非法注入重新生成、结束后 MDC 清理、响应回写。 */
class TraceIdFilterTest {

    private final TraceIdFilter filter = new TraceIdFilter();

    @AfterEach
    void tearDown() {
        org.slf4j.MDC.clear();
    }

    @Test
    void generatesTraceIdAndClearsMdcAfterChain() throws ServletException, IOException {
        MockHttpServletRequest request = new MockHttpServletRequest("POST", "/pay/orders");
        MockHttpServletResponse response = new MockHttpServletResponse();
        FilterChain chain = (req, res) -> { };

        filter.doFilter(request, response, chain);

        assertThat(org.slf4j.MDC.get(TraceIdFilter.TRACE_ID)).isNull(); // 结束后必须清理
        assertThat(response.getHeader("X-Trace-Id")).hasSize(16);
    }

    @Test
    void traceIdVisibleInsideChainAndReusesSafeUpstreamId() throws ServletException, IOException {
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/pay/membership");
        request.addHeader("X-Trace-Id", "abc-DEF-123");
        MockHttpServletResponse response = new MockHttpServletResponse();
        FilterChain chain = (req, res) ->
                // 链内任意组件都能读到同一 traceId（日志/审计互相关联的依据）
                assertThat(org.slf4j.MDC.get(TraceIdFilter.TRACE_ID)).isEqualTo("abc-DEF-123");

        filter.doFilter(request, response, chain);

        assertThat(response.getHeader("X-Trace-Id")).isEqualTo("abc-DEF-123");
    }

    @Test
    void unsafeIncomingTraceIdIsRegenerated() throws ServletException, IOException {
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/pay/products");
        request.addHeader("X-Trace-Id", "evil<script>alert(1)</script>");
        MockHttpServletResponse response = new MockHttpServletResponse();
        FilterChain chain = (req, res) -> { };

        filter.doFilter(request, response, chain);

        // 不透传含白名单外字符的头（防日志注入），重新生成的 ID 回写响应
        assertThat(response.getHeader("X-Trace-Id")).hasSize(16)
                .isNotEqualTo("evil<script>alert(1)</script>");
    }

    @Test
    void mdcClearedEvenWhenChainThrows() {
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/pay/orders");
        MockHttpServletResponse response = new MockHttpServletResponse();
        FilterChain chain = (req, res) -> {
            throw new IllegalStateException("boom");
        };

        assertThatThrownBy(() -> filter.doFilter(request, response, chain))
                .isInstanceOf(IllegalStateException.class);
        assertThat(org.slf4j.MDC.get(TraceIdFilter.TRACE_ID)).isNull();
    }
}
