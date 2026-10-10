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

/** traceId propagation: reuse a valid upstream ID, regenerate on unsafe injection, clear MDC afterwards, write back to the response. */
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

        assertThat(org.slf4j.MDC.get(TraceIdFilter.TRACE_ID)).isNull(); // must be cleared after the chain completes
        assertThat(response.getHeader("X-Trace-Id")).hasSize(16);
    }

    @Test
    void traceIdVisibleInsideChainAndReusesSafeUpstreamId() throws ServletException, IOException {
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/pay/membership");
        request.addHeader("X-Trace-Id", "abc-DEF-123");
        MockHttpServletResponse response = new MockHttpServletResponse();
        FilterChain chain = (req, res) ->
                // any component inside the chain can read the same traceId (the basis for correlating logs/audit)
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

        // do not pass through a header containing characters outside the whitelist (prevents log injection); the regenerated ID is written back to the response
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
