package com.mindbase.pay.controller;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.context.request.async.DeferredResult;

import com.mindbase.pay.common.ApiException;
import com.mindbase.pay.config.PayProperties;
import com.mindbase.pay.dto.PayDtos;
import com.mindbase.pay.service.timer.ExecuteResult;
import com.mindbase.pay.service.timer.TimeoutCommand;
import com.mindbase.pay.service.timer.TimeoutExecutionQueue;

import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;


/**
 * Timeout delegation executor (plan/1.0.8): app-task POSTs the raw payload here when a deadline fires.
 *
 * <p>Trust boundary: at registration executor_url carries the token query string (app-task POSTs it
 * verbatim, no changes needed); when pay.internal.executor-token is configured it is enforced. The SQL
 * side also guards on expires_at, so even if the token is missing/bypassed only genuinely expired orders
 * can be closed. In docker profile the startup self-check requires the token to be non-blank.
 *
 * <p><b>并发自限（P1 修复）</b>：入队由 {@link TimeoutExecutionQueue} 的队列 + 在途信号量钳制，
 * 超限立即 503。控制器返回 {@link DeferredResult} 异步结果，**不再用 Tomcat 线程同步等待 30s**：
 * 否则 200 个 executor 请求就能占满 Web 线程池，连带 /health 与支付接口一起不可用。
 *
 * <p>Responses are always 200 (a business skip is still a successful handling); only 5xx triggers an app-task retry.
 */
@Slf4j
@RestController
@RequestMapping("/internal/pay/timeout")
@RequiredArgsConstructor
public class PayTimeoutExecutionController {

    /** 异步等待预算：大于队列内单命令的最坏执行时间，小于 app-task 的请求超时。 */
    private static final long EXECUTOR_WAIT_MS = 25_000L;

    private final TimeoutExecutionQueue queue;
    private final PayProperties payProperties;

    @PostMapping("/execute")
    public DeferredResult<ResponseEntity<ExecuteResult>> execute(
            @Valid @RequestBody PayDtos.TimeoutExecutionRequest req,
            @RequestParam(value = "token", required = false) String token) {
        String expected = payProperties.internal() == null ? null : payProperties.internal().executorToken();
        if (expected != null && !expected.isBlank() && !constantTimeEquals(expected, token)) {
            log.warn("[PAY] timeout_executor_unauthorized order_no={}", req.orderNo());
            throw ApiException.unauthorized("UNAUTHORIZED", "Invalid executor token");
        }
        DeferredResult<ResponseEntity<ExecuteResult>> deferred = new DeferredResult<>(EXECUTOR_WAIT_MS);
        deferred.onTimeout(() -> {
            log.warn("[PAY] timeout_executor_wait_timeout order_no={} -- 503, caller should backoff", req.orderNo());
            deferred.setErrorResult(ApiException.serviceUnavailable("EXECUTOR_BUSY",
                    "Executor wait timed out, please retry later"));
        });
        try {
            queue.submitAsync(new TimeoutCommand(req.orderNo(), req.version()))
                    .whenComplete((result, error) -> {
                        if (error != null) {
                            Throwable cause = unwrap(error);
                            log.warn("[PAY] timeout_executor_failed order_no={} err={}",
                                    req.orderNo(), cause.toString());
                            deferred.setErrorResult(cause);
                        } else {
                            deferred.setResult(ResponseEntity.ok(result));
                        }
                    });
        } catch (TimeoutExecutionQueue.QueueFullException e) {
            log.warn("[PAY] timeout_executor_busy -- 503, caller should backoff and retry");
            throw ApiException.serviceUnavailable("EXECUTOR_BUSY", "Executor queue is full, please retry later");
        }
        return deferred;
    }

    /** 常量时间比较，避免 token 计时侧信道（token 走 query string，网络抖动大，但资金服务保持惯例）。 */
    private static boolean constantTimeEquals(String expected, String actual) {
        if (actual == null) {
            return false;
        }
        return MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8),
                actual.trim().getBytes(StandardCharsets.UTF_8));
    }

    private static Throwable unwrap(Throwable error) {
        Throwable current = error;
        while ((current instanceof java.util.concurrent.CompletionException
                || current instanceof java.util.concurrent.ExecutionException)
                && current.getCause() != null) {
            current = current.getCause();
        }
        return current;
    }
}
