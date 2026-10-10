package com.mindbase.pay.controller;

import com.mindbase.pay.common.GlobalExceptionHandler;
import com.mindbase.pay.config.PayProperties;
import com.mindbase.pay.service.timer.ExecuteResult;
import com.mindbase.pay.service.timer.TimeoutCommand;
import com.mindbase.pay.service.timer.TimeoutExecutionQueue;
import com.mindbase.pay.testutil.TestPayProperties;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** executor endpoint: 200 with the result passed through; 503 when the queue is full; 401 when a token is configured but the correct token is absent. */
@ExtendWith(MockitoExtension.class)
class PayTimeoutExecutionControllerTest {

    private static final String BODY = "{\"orderNo\":\"PO1\",\"version\":1}";

    @Mock
    private TimeoutExecutionQueue queue;

    private MockMvc mvc(PayProperties props) {
        return MockMvcBuilders.standaloneSetup(new PayTimeoutExecutionController(queue, props))
                .setControllerAdvice(new GlobalExceptionHandler()).build();
    }

    @Test
    void resultIsPassedThrough() throws Exception {
        when(queue.submit(new TimeoutCommand("PO1", 1)))
                .thenReturn(ExecuteResult.skip("SKIP_VERSION_MISMATCH"));

        mvc(TestPayProperties.defaults()).perform(post("/internal/pay/timeout/execute")
                        .contentType(MediaType.APPLICATION_JSON).content(BODY))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.executed").value(false))
                .andExpect(jsonPath("$.reason").value("SKIP_VERSION_MISMATCH"));
    }

    @Test
    void queueFullReturns503() throws Exception {
        when(queue.submit(any(TimeoutCommand.class)))
                .thenThrow(new TimeoutExecutionQueue.QueueFullException());

        mvc(TestPayProperties.defaults()).perform(post("/internal/pay/timeout/execute")
                        .contentType(MediaType.APPLICATION_JSON).content(BODY))
                .andExpect(status().isServiceUnavailable())
                .andExpect(jsonPath("$.code").value("EXECUTOR_BUSY"));
    }

    @Test
    void configuredTokenIsEnforced() throws Exception {
        PayProperties props = TestPayProperties.builder()
                .internal(new PayProperties.Internal("s3cr3t")).build();

        mvc(props).perform(post("/internal/pay/timeout/execute")
                        .contentType(MediaType.APPLICATION_JSON).content(BODY))
                .andExpect(status().isUnauthorized());
        mvc(props).perform(post("/internal/pay/timeout/execute")
                        .param("token", "wrong")
                        .contentType(MediaType.APPLICATION_JSON).content(BODY))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void correctTokenAccepted() throws Exception {
        PayProperties props = TestPayProperties.builder()
                .internal(new PayProperties.Internal("s3cr3t")).build();
        when(queue.submit(new TimeoutCommand("PO1", 1))).thenReturn(ExecuteResult.ok());

        mvc(props).perform(post("/internal/pay/timeout/execute")
                        .param("token", "s3cr3t")
                        .contentType(MediaType.APPLICATION_JSON).content(BODY))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.executed").value(true));
    }
}
