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

// SSR base URL: Next.js server-side fetches (SSR/RSC) have no origin, so they
// always need an absolute internal URL. Route them through nginx (NOT direct
// backend:8000) so SSR traffic stays behind the nginx -> apisix -> backend
// chain and benefits from load balancing.
// NEXT_PUBLIC_APISIX_HOST is inlined at build time: docker-compose sets it to
// "nginx:80"; local dev falls back to "localhost:9080" (apisix on host/VM).
const INTERNAL_API_HOST = process.env.NEXT_PUBLIC_APISIX_HOST || "localhost:9080";

// Browser base URL: NEXT_PUBLIC_API_URL (set at build time) points the browser
// straight at the gateway (e.g. http://localhost -> nginx:80), bypassing the
// Next.js server entirely - its rewrites proxy buffers SSE, collapsing
// token-by-token streaming into one bulk delivery. Unset = "" (same-origin).
// It must NOT be used for SSR: inside the frontend container "localhost" is
// the Next server itself, not the gateway.
export const API_BASE_URL =
    typeof window !== "undefined"
        ? process.env.NEXT_PUBLIC_API_URL || ""
        : `http://${INTERNAL_API_HOST}`;

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
            "Content-Type": "application/json",
            // Marks the request as AJAX so dev-proxy beforeFiles rewrites can
            // route API calls (e.g. GET /notes) to the backend ahead of the
            // matching page route. Page navigation never sends this header.
            "X-Requested-With": "XMLHttpRequest",
            ...getAuthHeaders(),
            ...options.headers,
        },
    });

    // 会话失效时清除登录状态（不立即跳转，让调用方决定处理方式）
    if (response.status === 401) {
        if (typeof window !== "undefined") {
            const token = localStorage.getItem("bili_session");
            if (token) {
                localStorage.removeItem("bili_session");
                localStorage.removeItem("bili_user");
                window.dispatchEvent(new Event("auth:unauthorized"));
                throw new Error(sanitizeError({ status: 401 }));
            }
        }
    }

    if (!response.ok) {
        // Consume body so the connection can be reused
        let rawDetail = "";
        try {
            const text = await response.text();
            const parsed = JSON.parse(text);
            rawDetail = typeof parsed.detail === "string" ? parsed.detail : "";
        } catch {}
        throw new Error(sanitizeError({ status: response.status, detail: rawDetail }));
    }

    return response.json();
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
