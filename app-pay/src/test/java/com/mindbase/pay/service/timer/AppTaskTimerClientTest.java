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

/** Timeout delegation registration: contract aligned with app-task /tasks/register; failures only warn, never throw (the fallback takes over). */
class AppTaskTimerClientTest {

    private static final String BASE = "http://apptask-test";
    private static final LocalDateTime TRIGGER = LocalDateTime.of(2026, 9, 6, 20, 30);

    private PayAuditLogger audit;
    private MockRestServiceServer server;

    private AppTaskTimerClient client(boolean registerEnabled) {
        PayProperties props = com.mindbase.pay.testutil.TestPayProperties.builder()
                .apptask(new PayProperties.Apptask(BASE, "secret-key", registerEnabled, "http://app-pay:8002", 2, 1000))
                .build();
        RestClient.Builder builder = RestClient.builder()
                .baseUrl(BASE)
                .defaultHeader("apikey", "secret-key"); // In production this is injected by the constructor; the test sets it manually to match
        server = MockRestServiceServer.bindTo(builder).build();
        audit = mock(PayAuditLogger.class);
        AppTaskTimerClient c = new AppTaskTimerClient(builder, props, audit);
        c.setRegisterExecutorForTest(Runnable::run); // 同步执行器：注册语义测试保持确定性
        return c;
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

        // Failure does not throw: fallback polling takes over, and the fund audit records TIMER_REGISTER_FAILED
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
        server.verify(); // zero requests
    }
}
