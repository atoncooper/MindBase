import type { FastifyError } from "fastify";

/**
 * Typed application error: carries an HTTP status, a stable machine code and whether
 * the message may be exposed to clients. Route/service layers throw these; the global
 * error handler maps everything through toErrorPayload (unknown errors are sanitized).
 */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    /** false → client receives a generic message (internal details stay in logs) */
    readonly expose = true,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (message: string) => new AppError(400, "bad_request", message);
export const notFound = (message: string) => new AppError(404, "not_found", message);
export const unsupportedMedia = (message: string) => new AppError(415, "unsupported_media_type", message);
export const payloadTooLarge = (message: string) => new AppError(413, "payload_too_large", message);
export const internal = (message = "内部错误") => new AppError(500, "internal_error", message, false);

export interface ErrorPayload {
  status: number;
  body: { detail: string; code: string; error_id?: string };
}

/**
 * Single mapping rule for every error reaching the HTTP layer:
 * - AppError            → its status/code; message only when expose
 * - framework 4xx       → status + message (validation, malformed body …)
 * - anything else       → 500 generic body; the original error is logged by the caller
 * error_id (= request id) lets clients correlate a 5xx body with the server log line.
 */
export function toErrorPayload(err: unknown, requestId: string): ErrorPayload {
  if (err instanceof AppError) {
    return {
      status: err.statusCode,
      body: {
        detail: err.expose ? err.message : "内部错误",
        code: err.code,
        ...(err.statusCode >= 500 ? { error_id: requestId } : {}),
      },
    };
  }
  const status = (err as Partial<FastifyError>).statusCode;
  if (typeof status === "number" && status < 500) {
    const e = err as FastifyError;
    return { status, body: { detail: e.message, code: e.code ?? `http_${status}` } };
  }
  // upstream connectivity problems (gateway/Milvus down) get an actionable, sanitized message
  if (err instanceof Error && (err.name === "AI_RetryError" || /ECONNREFUSED|ENOTFOUND|fetch failed|No connection established/i.test(err.message))) {
    return { status: 503, body: { detail: "上游服务暂不可用，请稍后重试", code: "upstream_unavailable", error_id: requestId } };
  }
  return { status: 500, body: { detail: "内部错误", code: "internal_error", error_id: requestId } };
}
