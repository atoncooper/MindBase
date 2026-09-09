package com.mindbase.pay.controller;

import com.mindbase.pay.common.GlobalExceptionHandler;
import com.mindbase.pay.service.timer.ExecuteResult;
import com.mindbase.pay.service.timer.TimeoutCommand;
import com.mindbase.pay.service.timer.TimeoutExecutionQueue;
import org.junit.jupiter.api.BeforeEach;
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

/** executor 端点：200 结果透传；队列满 503（app-task 退避重试信号）。 */
@ExtendWith(MockitoExtension.class)
class PayTimeoutExecutionControllerTest {

    @Mock
    private TimeoutExecutionQueue queue;

    private MockMvc mockMvc;

    @BeforeEach
    void setUp() {
        mockMvc = MockMvcBuilders.standaloneSetup(new PayTimeoutExecutionController(queue))
                .setControllerAdvice(new GlobalExceptionHandler()).build();
    }

    @Test
    void resultIsPassedThrough() throws Exception {
        when(queue.submit(new TimeoutCommand("PO1", 1)))
                .thenReturn(ExecuteResult.skip("SKIP_VERSION_MISMATCH"));

        mockMvc.perform(post("/internal/pay/timeout/execute")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"orderNo\":\"PO1\",\"version\":1}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.executed").value(false))
                .andExpect(jsonPath("$.reason").value("SKIP_VERSION_MISMATCH"));
    }

    @Test
    void queueFullReturns503() throws Exception {
        when(queue.submit(any(TimeoutCommand.class)))
                .thenThrow(new TimeoutExecutionQueue.QueueFullException());

        mockMvc.perform(post("/internal/pay/timeout/execute")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"orderNo\":\"PO1\",\"version\":1}"))
                .andExpect(status().isServiceUnavailable())
                .andExpect(jsonPath("$.code").value("EXECUTOR_BUSY"));
    }
}
