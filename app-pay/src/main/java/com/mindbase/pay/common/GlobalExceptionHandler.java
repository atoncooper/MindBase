package com.mindbase.pay.common;

import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

import java.util.LinkedHashMap;
import java.util.Map;

/** 统一错误体 {code,message}；对外不泄露堆栈/SQL 等内部细节。 */
@Slf4j
@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(ApiException.class)
    public ResponseEntity<Map<String, String>> handleApiException(ApiException e) {
        // 业务异常不采集堆栈（见 ApiException），此处按级别留一行结构化日志：
        // 4xx = 客户端行为（含探测/重试），5xx = 瞬态故障需关注；traceId/uid 由 MDC 自动附带
        if (e.getStatus() >= 500) {
            log.error("[PAY] business_error status={} code={} msg={}",
                    e.getStatus(), e.getCode(), e.getMessage());
        } else {
            log.warn("[PAY] business_rejected status={} code={} msg={}",
                    e.getStatus(), e.getCode(), e.getMessage());
        }
        return ResponseEntity.status(e.getStatus())
                .body(Map.of("code", e.getCode(), "message", e.getMessage()));
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<Map<String, String>> handleValidation(MethodArgumentNotValidException e) {
        String detail = e.getBindingResult().getFieldErrors().stream()
                .map(err -> err.getField() + ": " + err.getDefaultMessage())
                .findFirst()
                .orElse("invalid request");
        return ResponseEntity.badRequest()
                .body(error("VALIDATION_ERROR", detail));
    }

    // 框架异常显式分类：没有这几个 handler 时会被下方 Exception 兜底误判为 500，
    // 监控被假 500 污染（如乱码请求体、访问不存在的路径）
    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Map<String, String>> handleNotReadable(HttpMessageNotReadableException e) {
        return ResponseEntity.badRequest().body(error("MALFORMED_BODY", "Malformed request body"));
    }

    @ExceptionHandler(MissingServletRequestParameterException.class)
    public ResponseEntity<Map<String, String>> handleMissingParam(MissingServletRequestParameterException e) {
        return ResponseEntity.badRequest()
                .body(error("MISSING_PARAM", "Missing required parameter: " + e.getParameterName()));
    }

    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<Map<String, String>> handleTypeMismatch(MethodArgumentTypeMismatchException e) {
        return ResponseEntity.badRequest()
                .body(error("TYPE_MISMATCH", "Invalid parameter type: " + e.getName()));
    }

    @ExceptionHandler(HttpRequestMethodNotSupportedException.class)
    public ResponseEntity<Map<String, String>> handleMethodNotSupported(HttpRequestMethodNotSupportedException e) {
        return ResponseEntity.status(HttpStatus.METHOD_NOT_ALLOWED)
                .body(error("METHOD_NOT_SUPPORTED", "HTTP method not supported"));
    }

    @ExceptionHandler(NoResourceFoundException.class)
    public ResponseEntity<Map<String, String>> handleNoResource(NoResourceFoundException e) {
        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(error("NOT_FOUND", "Resource not found"));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<Map<String, String>> handleUnexpected(Exception e) {
        log.error("[PAY] unexpected_error err={}", e.toString(), e);
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(Map.of("code", "INTERNAL", "message", "Internal server error, please retry later"));
    }

    /** 供需要多个字段的响应使用（当前错误体为两字段 Map）。 */
    static Map<String, String> error(String code, String message) {
        Map<String, String> body = new LinkedHashMap<>();
        body.put("code", code);
        body.put("message", message);
        return body;
    }
}
