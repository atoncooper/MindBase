package com.mindbase.pay.common;

import com.mindbase.pay.config.PayProperties;
import com.mindbase.pay.testutil.TestPayProperties;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;

/** /internal/pay/* 服务端二次鉴权：未配置 fail-closed 503、缺失/错误 401、正确放行、非 internal 路径不拦截。 */
class InternalAuthFilterTest {

    private static InternalAuthFilter filter(String configuredKey) {
        PayProperties props = TestPayProperties.builder()
                .internal(new PayProperties.Internal("executor-token", configuredKey))
                .build();
        return new InternalAuthFilter(props, mock(PayMetrics.class));
    }

    private static MockHttpServletRequest request(String uri, String key) {
        MockHttpServletRequest request = new MockHttpServletRequest("POST", uri);
        if (key != null) {
            request.addHeader(InternalAuthFilter.HEADER, key);
        }
        return request;
    }

    @Test
    void rejectsWhenKeyNotConfigured() throws Exception {
        MockHttpServletResponse response = new MockHttpServletResponse();
        MockFilterChain chain = new MockFilterChain();
        filter("").doFilter(request("/internal/pay/grant", "anything"), response, chain);
        assertThat(response.getStatus()).isEqualTo(503);
        assertThat(response.getContentAsString()).contains("INTERNAL_AUTH_NOT_CONFIGURED");
        assertThat(chain.getRequest()).isNull();
    }

    @Test
    void rejectsMissingOrWrongKey() throws Exception {
        MockHttpServletResponse missing = new MockHttpServletResponse();
        MockFilterChain chain1 = new MockFilterChain();
        filter("s3cret").doFilter(request("/internal/pay/grant", null), missing, chain1);
        assertThat(missing.getStatus()).isEqualTo(401);
        assertThat(chain1.getRequest()).isNull();

        MockHttpServletResponse wrong = new MockHttpServletResponse();
        filter("s3cret").doFilter(request("/internal/pay/orders/PO1/refund", "nope"), wrong,
                new MockFilterChain());
        assertThat(wrong.getStatus()).isEqualTo(401);
    }

    @Test
    void passesWithCorrectKey() throws Exception {
        MockFilterChain chain = new MockFilterChain();
        MockHttpServletResponse response = new MockHttpServletResponse();
        filter("s3cret").doFilter(request("/internal/pay/grant", "s3cret"), response, chain);
        assertThat(response.getStatus()).isEqualTo(200);
        assertThat(chain.getRequest()).isNotNull();
    }

    @Test
    void executorCallbackPathIsExemptFromInternalKey() throws Exception {
        // app-task 直接 POST executor_url（不经 APISIX，没有 X-Internal-Key），只由 executor token 守门
        PayMetrics metrics = mock(PayMetrics.class);
        PayProperties props = TestPayProperties.builder()
                .internal(new PayProperties.Internal("executor-token", ""))
                .build();
        MockFilterChain chain = new MockFilterChain();
        new InternalAuthFilter(props, metrics).doFilter(
                new MockHttpServletRequest("POST", "/internal/pay/timeout/execute"),
                new MockHttpServletResponse(), chain);

        assertThat(chain.getRequest()).isNotNull();
        verifyNoInteractions(metrics);
    }

    @Test
    void rejectedRequestIncrementsSecurityMetric() throws Exception {
        PayMetrics metrics = mock(PayMetrics.class);
        PayProperties props = TestPayProperties.builder()
                .internal(new PayProperties.Internal("executor-token", "s3cret"))
                .build();
        new InternalAuthFilter(props, metrics).doFilter(
                request("/internal/pay/grant", "wrong"),
                new MockHttpServletResponse(), new MockFilterChain());

        verify(metrics).internalAuthRejected();
    }

    @Test
    void ignoresNonInternalPaths() throws Exception {
        MockFilterChain chain = new MockFilterChain();
        filter("").doFilter(new MockHttpServletRequest("GET", "/pay/products"),
                new MockHttpServletResponse(), chain);
        assertThat(chain.getRequest()).isNotNull();
    }
}
