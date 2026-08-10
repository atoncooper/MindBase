/**
 * Embedding config API - 多 Provider embedding 凭证管理（CRUD / 设默认 / 测试）.
 *
 * Shared Config* types live here and are imported by asr-config.ts.
 */
import { request, getAuthHeaders } from "./client";

export interface ConfigItem {
    id: number;
    name: string;
    provider: string;
    masked_key: string;
    base_url: string | null;
    model: string | null;
    is_default: boolean;
    created_at: string;
    updated_at: string;
    last_test_status: string | null;
    last_test_error: string | null;
    last_test_at: string | null;
}

export interface TestResultResponse {
    status: "ok" | "error";
    error?: string;
    latency_ms?: number;
}

export interface ConfigCreateParams {
    name: string;
    provider: string;
    api_key: string;
    base_url?: string;
    model?: string;
    is_default?: boolean;
}

export interface ConfigUpdateParams {
    name?: string;
    api_key?: string;
    base_url?: string;
    model?: string;
    is_default?: boolean;
}

export const embeddingConfigApi = {
    list: () =>
        request<ConfigItem[]>("/settings/embedding-configs", {
            headers: getAuthHeaders(),
        }),

    create: (data: ConfigCreateParams) =>
        request<ConfigItem>("/settings/embedding-configs", {
            method: "POST",
            headers: getAuthHeaders(),
            body: JSON.stringify(data),
        }),

    update: (id: number, data: ConfigUpdateParams) =>
        request<ConfigItem>(`/settings/embedding-configs/${id}`, {
            method: "PATCH",
            headers: getAuthHeaders(),
            body: JSON.stringify(data),
        }),

    delete: (id: number) =>
        request(`/settings/embedding-configs/${id}`, {
            method: "DELETE",
            headers: getAuthHeaders(),
        }),

    setDefault: (id: number) =>
        request(`/settings/embedding-configs/${id}/default`, {
            method: "POST",
            headers: getAuthHeaders(),
        }),

    test: (id: number) =>
        request<TestResultResponse>(`/settings/embedding-configs/${id}/test`, {
            method: "POST",
            headers: getAuthHeaders(),
        }),
};
