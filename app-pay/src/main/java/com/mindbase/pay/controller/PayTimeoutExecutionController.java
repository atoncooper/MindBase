package com.mindbase.pay.controller;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import com.mindbase.pay.common.ApiException;
import com.mindbase.pay.config.PayProperties;
import com.mindbase.pay.dto.PayDtos;
import com.mindbase.pay.service.timer.ExecuteResult;
import com.mindbase.pay.service.timer.TimeoutCommand;
import com.mindbase.pay.service.timer.TimeoutExecutionQueue;

import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;


/**
 * Timeout delegation executor (plan/1.0.8): app-task POSTs the raw payload here when a deadline fires.
 *
 * <p>Trust boundary: at registration executor_url carries the token query string (app-task POSTs it
 * verbatim, no changes needed); when pay.internal.executor-token is configured it is enforced. The SQL
 * side also guards on expires_at, so even if the token is missing/bypassed only genuinely expired orders
 * can be closed.
 *
 * <p>Concurrency self-limiting (§5.3): enqueueing is clamped by {@link TimeoutExecutionQueue}; a full
 * queue returns 503 -> the caller backs off and retries.
 * Responses are always 200 (a business skip is still a successful handling); only 5xx triggers an
 * app-task retry.
 */
@Slf4j
@RestController
@RequestMapping("/internal/pay/timeout")
@RequiredArgsConstructor
public class PayTimeoutExecutionController {

    private final TimeoutExecutionQueue queue;
    private final PayProperties payProperties;

    @PostMapping("/execute")
    public ResponseEntity<ExecuteResult> execute(
            @Valid @RequestBody PayDtos.TimeoutExecutionRequest req,
            @RequestParam(value = "token", required = false) String token) {
        String expected = payProperties.internal() == null ? null : payProperties.internal().executorToken();
        if (expected != null && !expected.isBlank() && !expected.equals(token)) {
            log.warn("[PAY] timeout_executor_unauthorized order_no={}", req.orderNo());
            throw ApiException.unauthorized("UNAUTHORIZED", "Invalid executor token");
        }
        try {
            ExecuteResult result = queue.submit(new TimeoutCommand(req.orderNo(), req.version()));
            return ResponseEntity.ok(result);
        } catch (TimeoutExecutionQueue.QueueFullException e) {
            log.warn("[PAY] timeout_executor_busy -- 503, caller should backoff and retry");
            // The unified error body is rendered by GlobalExceptionHandler; 503 triggers app-task backoff retry
            throw ApiException.serviceUnavailable("EXECUTOR_BUSY", "Executor queue is full, please retry later");
        }
    }
}
