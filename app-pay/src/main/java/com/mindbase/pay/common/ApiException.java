package com.mindbase.pay.common;

import lombok.Getter;

/**
 * 业务异常：携带 HTTP 状态与稳定错误码，由 {@link GlobalExceptionHandler} 统一渲染为 {code,message}。
 *
 * <p>约定：
 * <ul>
 *   <li>code 是对外稳定的 API 契约（前端/app-task 按码分支），改码视为破坏性变更；</li>
 *   <li>静态工厂覆盖常用状态码，特殊场景用 {@link #of}；</li>
 *   <li>业务异常是控制流而非程序缺陷：不采集堆栈（fillInStackTrace 置空）——
 *       代价是抛点不可回溯，收益是高频 4xx 场景（IDOR 探测、幂等重试等）零开销且日志无噪音堆栈；
 *       定位靠 code + message + MDC（traceId/uid），5xx 由 handler 以 ERROR 级记录。</li>
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

    /** 任意状态码入口（非枚举化，避免工厂清单与实际需求脱节）。 */
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

    /** 预留：APISIX/应用层限流命中（plan/1.0.7-Pay §12 限流项）时使用。 */
    public static ApiException tooManyRequests(String code, String message) {
        return of(429, code, message);
    }

    public static ApiException internalServerError(String code, String message) {
        return of(500, code, message);
    }

    /** 队列满/依赖不可用等瞬态故障：调用方（app-task）应退避重试。 */
    public static ApiException serviceUnavailable(String code, String message) {
        return of(503, code, message);
    }

    /**
     * 控制流异常不采集堆栈：代价是抛点不可回溯（由 code+message+traceId 定位），
     * 收益是热路径零堆栈开销。若排障确需抛点，临时移除本覆盖即可。
     */
    @Override
    public synchronized Throwable fillInStackTrace() {
        return this;
    }
}
