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

export const API_BASE_URL =
    process.env.NEXT_PUBLIC_API_URL ||
    (typeof window !== "undefined" ? "" : "http://backend:8000");

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
