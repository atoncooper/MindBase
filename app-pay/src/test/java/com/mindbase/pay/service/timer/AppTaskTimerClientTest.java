package com.mindbase.pay.service.timer;

import com.mindbase.pay.common.PayAuditLogger;
import com.mindbase.pay.config.PayProperties;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.client.MockRestServiceServer;
import org.springframework.web.client.RestClient;

import java.time.LocalDateTime;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.springframework.http.HttpMethod.POST;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.header;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.method;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess;

/** 超时委托注册：契约对齐 app-task /tasks/register；失败仅告警不抛出（兜底接管）。 */
class AppTaskTimerClientTest {

    private static final String BASE = "http://apptask-test";
    private static final LocalDateTime TRIGGER = LocalDateTime.of(2026, 9, 6, 20, 30);

    private PayAuditLogger audit;
    private MockRestServiceServer server;

    private AppTaskTimerClient client(boolean registerEnabled) {
        PayProperties props = new PayProperties(null, null, null, null, null,
                new PayProperties.Apptask(BASE, "secret-key", registerEnabled,
                        "http://app-pay:8002"),
                null);
        RestClient.Builder builder = RestClient.builder()
                .baseUrl(BASE)
                .defaultHeader("apikey", "secret-key"); // 生产路径由构造器注入，测试手动等价
        server = MockRestServiceServer.bindTo(builder).build();
        audit = mock(PayAuditLogger.class);
        return new AppTaskTimerClient(builder, props, audit);
    }

    @Test
    void registersHttpPostWithKeyAuth() {
        AppTaskTimerClient client = client(true);
        server.expect(requestTo(BASE + "/tasks/register"))
                .andExpect(method(POST))
                .andExpect(header("apikey", "secret-key"))
                .andRespond(withSuccess());

        assertThatCode(() -> client.registerOrderTimeoutAfterCommit(
                10086L, "PO1", 1, TRIGGER)).doesNotThrowAnyException();
        server.verify();
    }

    @Test
    void registerFailureIsSwallowedAndAudited() {
        AppTaskTimerClient client = client(true);
        server.expect(requestTo(BASE + "/tasks/register"))
                .andExpect(method(POST))
                .andRespond(org.springframework.test.web.client.response.MockRestResponseCreators
                        .withServerError());

        // 失败不抛出：兜底轮询接管，资金审计记录 TIMER_REGISTER_FAILED
        assertThatCode(() -> client.registerOrderTimeoutAfterCommit(
                10086L, "PO1", 1, TRIGGER)).doesNotThrowAnyException();
        verify(audit).audit(eq("TIMER_REGISTER_FAILED"), eq("order_no"), eq("PO1"),
                any(), any());
    }

    @Test
    void disabledRegistrationSendsNoRequest() {
        AppTaskTimerClient client = client(false);

        assertThatCode(() -> client.registerOrderTimeoutAfterCommit(
                10086L, "PO1", 1, TRIGGER)).doesNotThrowAnyException();
        server.verify(); // 零请求
    }
}
