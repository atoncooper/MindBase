/**
 * Error classification and user-safe message sanitization.
 *
 * NEVER expose raw backend error messages to the user — they may contain
 * stack traces, SQL queries, file paths, or other internal details.
 */

const STATUS_MESSAGES: Record<number, string> = {
  400: "请求参数有误",
  401: "登录已过期，请重新登录",
  403: "没有权限执行此操作",
  404: "请求的资源不存在",
  408: "请求超时，请重试",
  409: "操作冲突，请刷新后重试",
  413: "文件过大",
  422: "输入数据格式错误",
  429: "请求过于频繁，请稍后重试",
  500: "服务器繁忙，请稍后重试",
  502: "服务暂时不可用，请稍后重试",
  503: "服务暂时不可用，请稍后重试",
  504: "网关超时，请稍后重试",
};

const NETWORK_PATTERNS = [
  "Failed to fetch",
  "NetworkError",
  "Network request failed",
  "Load failed",
  "fetch failed",
  "ERR_CONNECTION_REFUSED",
  "ERR_INTERNET_DISCONNECTED",
  "net::ERR_",
];

function isNetworkError(message: string): boolean {
  return NETWORK_PATTERNS.some((p) => message.includes(p));
}

function isTimeoutError(message: string): boolean {
  return (
    message.includes("timeout") ||
    message.includes("Timeout") ||
    message.includes("ETIMEDOUT") ||
    message.includes("AbortError") ||
    message.includes("aborted")
  );
}

export function sanitizeError(err: unknown): string {
  if (!err) return "操作失败，请重试";

  // Already a safe user-facing string (not from backend)
  if (typeof err === "string") {
    // If it looks like a raw backend message (long, contains tech details), sanitize
    if (err.length > 100 || err.includes("traceback") || err.includes("Error:")) {
      return "服务器繁忙，请稍后重试";
    }
    return err;
  }

  // Extract status and message from error-like objects
  let status: number | undefined;
  let message = "";

  if (err instanceof Error) {
    message = err.message;
    // Try to extract HTTP status from the message (our api.ts embeds it)
    const statusMatch = message.match(/请求失败:\s*(\d+)/);
    if (statusMatch) status = parseInt(statusMatch[1], 10);
  } else if (typeof err === "object" && err !== null) {
    const obj = err as Record<string, unknown>;
    if (typeof obj.status === "number") status = obj.status;
    if (typeof obj.message === "string") message = obj.message;
    if (typeof obj.detail === "string") message = obj.detail;
  }

  // Classify by HTTP status
  if (status && STATUS_MESSAGES[status]) {
    return STATUS_MESSAGES[status];
  }

  // Classify network errors
  if (message && isNetworkError(message)) {
    return "网络连接失败，请检查网络";
  }

  // Classify timeouts
  if (message && isTimeoutError(message)) {
    return "请求超时，请重试";
  }

  // Fallback: never expose the raw message
  return "操作失败，请重试";
}

/**
 * Extract HTTP status code from an error if possible.
 */
export function extractStatus(err: unknown): number | undefined {
  if (err instanceof Error) {
    const m = err.message.match(/请求失败:\s*(\d+)/);
    if (m) return parseInt(m[1], 10);
  }
  if (typeof err === "object" && err !== null) {
    const s = (err as Record<string, unknown>).status;
    if (typeof s === "number") return s;
  }
  return undefined;
}
