package com.mindbase.pay.controller;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.mindbase.pay.common.ApiException;
import com.mindbase.pay.dto.PayDtos;
import com.mindbase.pay.service.timer.ExecuteResult;
import com.mindbase.pay.service.timer.TimeoutCommand;
import com.mindbase.pay.service.timer.TimeoutExecutionQueue;

import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;


/**
 * 超时委托 executor（plan/1.0.8）：app-task 到点把 payload 原文 POST 到此。
 * 并发自守（§5.3）：入队由 {@link TimeoutExecutionQueue} 钳制，队列满 503 → 调用方退避重试。
 * 响应恒 200（业务跳过也是处理成功）；仅 5xx 触发 app-task 重试。
 */
@Slf4j
@RestController
@RequestMapping("/internal/pay/timeout")
@RequiredArgsConstructor
public class PayTimeoutExecutionController {

    private final TimeoutExecutionQueue queue;

    @PostMapping("/execute")
    public ResponseEntity<ExecuteResult> execute(@Valid @RequestBody PayDtos.TimeoutExecutionRequest req) {
        try {
            ExecuteResult result = queue.submit(new TimeoutCommand(req.orderNo(), req.version()));
            return ResponseEntity.ok(result);
        } catch (TimeoutExecutionQueue.QueueFullException e) {
            log.warn("[PAY] timeout_executor_busy -- 503, caller should backoff and retry");
            // 统一错误体经 GlobalExceptionHandler 渲染；503 触发 app-task 退避重试
            throw ApiException.serviceUnavailable("EXECUTOR_BUSY", "Executor queue is full, please retry later");
        }
    }
}
