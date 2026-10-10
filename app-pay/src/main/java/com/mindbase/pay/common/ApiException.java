package com.mindbase.pay.common;

import lombok.Getter;

/**
 * Business exception: carries an HTTP status and a stable error code, rendered uniformly as
 * {code,message} by {@link GlobalExceptionHandler}.
 *
 * <p>Conventions:
 * <ul>
 *   <li>code is the externally stable API contract (the frontend/app-task branches on it); changing a code is a breaking change;</li>
 *   <li>static factories cover the common status codes; use {@link #of} for special cases;</li>
 *   <li>business exceptions are control flow, not program defects: no stack trace is captured (fillInStackTrace is a no-op) --
 *       the cost is that throw sites cannot be traced back, while the benefit is zero overhead and no noisy stack traces in logs
 *       for high-frequency 4xx scenarios (IDOR probing, idempotent retries, etc.);
 *       diagnosis relies on code + message + MDC (traceId/uid), and 5xx is logged at ERROR level by the handler.</li>
 * </ul>
 */
@Getter
public class ApiException extends RuntimeException {

    private static final long serialVersionUID = 1L;

    private final int status;
    private final String code;

    private ApiException(int status, String code, String message) {
        super(message);
        this.status = status;
        this.code = code;
    }

    /** Entry point for an arbitrary status code (not enumerated, so the factory list does not drift from actual needs). */
    public static ApiException of(int status, String code, String message) {
        return new ApiException(status, code, message);
    }

    public static ApiException badRequest(String code, String message) {
        return of(400, code, message);
    }

    public static ApiException unauthorized(String code, String message) {
        return of(401, code, message);
    }

    public static ApiException forbidden(String code, String message) {
        return of(403, code, message);
    }

    public static ApiException notFound(String code, String message) {
        return of(404, code, message);
    }

    public static ApiException conflict(String code, String message) {
        return of(409, code, message);
    }

    /** Reserved: used when APISIX/application-layer rate limiting is hit (plan/1.0.7-Pay §12 rate limiting item). */
    public static ApiException tooManyRequests(String code, String message) {
        return of(429, code, message);
    }

    public static ApiException internalServerError(String code, String message) {
        return of(500, code, message);
    }

    /** Transient failures such as a full queue or unavailable dependency: the caller (app-task) should retry with backoff. */
    public static ApiException serviceUnavailable(String code, String message) {
        return of(503, code, message);
    }

    /**
     * Control-flow exceptions do not capture a stack trace: the cost is that the throw site is not
     * traceable (locate it via code+message+traceId), and the benefit is zero stack overhead on the hot path.
     * If troubleshooting truly requires the throw site, temporarily remove this override.
     */
    @Override
    public synchronized Throwable fillInStackTrace() {
        return this;
    }
}
