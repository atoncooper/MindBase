/**
 * API client - shared infrastructure.
 *
 * This directory (lib/api/) holds one file per feature domain. This file only
 * provides the request plumbing shared by every feature: base url, auth header,
 * generic request / requestCamel, and snake_case -> camelCase conversion.
 *
 * Feature files import what they need from "./client". User-facing code imports
 * from "@/lib/api" (the barrel index.ts), never from here directly.
 */

import { sanitizeError } from "@/lib/error-utils";
import { emitAppToast } from "@/lib/app-toast";
import { readCachedBase, resolveApiBase, writeCachedBase } from "./deployment";

// SSR base URL: Next.js server-side fetches (SSR/RSC) have no origin, so they
// always need an absolute internal URL. Route them through nginx (never a
// specific backend service) so SSR traffic stays behind the
// nginx -> apisix -> service chain and benefits from load balancing.
// NEXT_PUBLIC_APISIX_HOST is inlined at build time: docker-compose sets it to
// "nginx:80"; local dev falls back to "localhost:9080" (apisix on host/VM).
const INTERNAL_API_HOST = process.env.NEXT_PUBLIC_APISIX_HOST || "localhost:9080";

// Browser base URL: 运行时按部署链解析（域名 SHARE_DOMAIN → 公网 IP → 本机
// 地址）。初始值为构建期 NEXT_PUBLIC_API_URL（保持与旧版一致的行为），模块
// 加载后由 resolveApiBase 异步覆盖；请求都在调用时读取该变量，解析完成前的
// 请求沿用旧值（与历史行为相同，无回归）。缓存见 lib/api/deployment.ts。
// It must NOT be used for SSR: inside the frontend container "localhost" is
// the Next server itself, not the gateway - SSR 请求永远走内网 nginx。
export let API_BASE_URL =
    typeof window !== "undefined"
        ? process.env.NEXT_PUBLIC_API_URL || ""
        : `http://${INTERNAL_API_HOST}`;

if (typeof window !== "undefined") {
    // 上一轮解析结果立即生效（避免每次首屏请求打旧地址），后台再校准。
    const cached = readCachedBase();
    if (cached !== null) API_BASE_URL = cached;
    void resolveApiBase(process.env.NEXT_PUBLIC_API_URL || "").then((base) => {
        API_BASE_URL = base;
        writeCachedBase(base);
    });
}

// Authorization header built from the bili_session token in localStorage.
export function getAuthHeaders(): Record<string, string> {
    if (typeof window === "undefined") return {};
    const token = localStorage.getItem("bili_session");
    if (!token) return {};
    return { Authorization: `Bearer ${token}` };
}

// Like getAuthHeaders, but throws when no token is present (for endpoints that
// MUST be authenticated - fails fast with a 401-style message instead of a
// later backend 401).
export function requireAuthHeaders(): Record<string, string> {
    const headers = getAuthHeaders();
    if (!headers.Authorization) {
        throw new Error(sanitizeError({ status: 401 }));
    }
    return headers;
}

// Attach the HTTP status to a thrown request error so callers can branch on
// it (e.g. 409 from /favorites/v2 = bilibili not bound → show bind prompt,
// not a logout). Message text alone is not a stable discriminator.
function withStatus(err: Error, status: number): Error {
    (err as Error & { status?: number }).status = status;
    return err;
}

/** HTTP status carried on an error thrown by request(), if any. */
export function requestErrorStatus(e: unknown): number | undefined {
    if (e instanceof Error && typeof (e as Error & { status?: number }).status === "number") {
        return (e as Error & { status?: number }).status;
    }
    return undefined;
}

// Generic request helper. Injects JSON content-type + auth headers, normalizes
// 401 (clears local auth + dispatches auth:unauthorized) and sanitizes errors.
export async function request<T>(
    endpoint: string,
    options: RequestInit = {}
): Promise<T> {
    const url = `${API_BASE_URL}${endpoint}`;

    const response = await fetch(url, {
        ...options,
        headers: {
            // Content-Type only with an actual body: Fastify rejects bodiless
            // requests that declare application/json ("Body cannot be empty when
            // content-type is set") — that 400 surfaced as「请求参数有误」and broke
            // the bodiless DELETE /chat/history/from/{id} (per-turn regenerate).
            // FormData bodies are excluded so fetch can set its multipart boundary.
            ...(options.body !== undefined && !(options.body instanceof FormData)
                ? { "Content-Type": "application/json" }
                : {}),
            // Marks the request as AJAX so dev-proxy beforeFiles rewrites can
            // route API calls (e.g. GET /notes) to the API gateway ahead of the
            // matching page route. Page navigation never sends this header.
            "X-Requested-With": "XMLHttpRequest",
            ...getAuthHeaders(),
            ...options.headers,
        },
    });

    // 会话失效时清除登录状态并全局弹窗提示（RouteGuard 统一跳转到首页）。
    if (response.status === 401) {
        if (typeof window !== "undefined") {
            const token = localStorage.getItem("bili_session");
            if (token) {
                localStorage.removeItem("bili_session");
                localStorage.removeItem("bili_user");
                emitAppToast("error", "登录已过期，请重新登录");
                window.dispatchEvent(new Event("auth:unauthorized"));
                throw new Error(sanitizeError({ status: 401 }));
            }
        }
    }

    if (!response.ok) {
        // Consume body so the connection can be reused
        let rawDetail = "";
        let bodyIsHtml = false;
        try {
            const text = await response.text();
            const parsed = JSON.parse(text);
            rawDetail = typeof parsed.detail === "string" ? parsed.detail : "";
        } catch {
            // 非 JSON 响应体（如 APISIX/openresty 的 403 HTML 错误页）说明
            // 请求死在网关层，而不是业务层拒绝——按服务不可用提示，避免被
            // 误读成"没有权限"。
            bodyIsHtml = true;
        }
        if (bodyIsHtml && (response.status === 403 || response.status >= 500)) {
            emitAppToast("warning", "服务暂时不可用，请稍后重试");
            throw withStatus(new Error("服务暂时不可用，请稍后重试"), response.status);
        }
        throw withStatus(
            new Error(sanitizeError({ status: response.status, detail: rawDetail })),
            response.status,
        );
    }

    // 204/空响应体没有 JSON 可解析（DELETE 等操作端点）：直接返回 undefined，
    // 不能走 response.json()——空串 JSON.parse 会抛 "Unexpected end of JSON
    // input"，把成功的删除误报成错误。
    if (response.status === 204) {
        return undefined as T;
    }
    const text = await response.text();
    if (text === "") {
        return undefined as T;
    }
    return JSON.parse(text) as T;
}

// Like `request`, but recursively converts snake_case response keys to
// camelCase. Use for endpoints whose Pydantic models serialize with snake_case
// field names (notes, etc.) so callers can consume camelCase directly.
export async function requestCamel<T>(
    endpoint: string,
    options: RequestInit = {}
): Promise<T> {
    const raw = await request<T>(endpoint, options);
    return snakeToCamel<T>(raw);
}

/** Recursively convert snake_case keys to camelCase */
export function snakeToCamel<T>(obj: unknown): T {
    if (Array.isArray(obj)) return obj.map(snakeToCamel) as T;
    if (obj !== null && typeof obj === "object" && obj.constructor === Object) {
        const result: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
            const camelKey = key.replace(/_([a-z])/g, (_, c) => (c as string).toUpperCase());
            result[camelKey] = snakeToCamel(value);
        }
        return result as T;
    }
    return obj as T;
}
