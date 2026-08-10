/**
 * Credentials API - 多 Provider LLM 凭证管理（CRUD / 设默认 / 测试）.
 */
import { request, getAuthHeaders } from "./client";
import type { TestResultResponse } from "./embedding-config";

export interface CredentialItem {
    id: number;
    name: string;
    provider: string;
    masked_key: string;
    base_url: string | null;
    default_model: string | null;
    is_default: boolean;
    created_at: string;
    updated_at: string;
    last_test_status: string | null;
    last_test_error: string | null;
    last_test_at: string | null;
}

export interface CredentialCreateParams {
    name: string;
    provider: string;
    api_key: string;
    base_url?: string;
    default_model?: string;
    is_default?: boolean;
}

export interface CredentialUpdateParams {
    name?: string;
    api_key?: string;
    base_url?: string;
    default_model?: string;
    is_default?: boolean;
}

export const credentialsApi = {
    list: () =>
        request<CredentialItem[]>("/credentials", {
            headers: getAuthHeaders(),
        }),

    create: (data: CredentialCreateParams) =>
        request<CredentialItem>("/credentials", {
            method: "POST",
            headers: getAuthHeaders(),
            body: JSON.stringify(data),
        }),

    update: (id: number, data: CredentialUpdateParams) =>
        request<CredentialItem>(`/credentials/${id}`, {
            method: "PATCH",
            headers: getAuthHeaders(),
            body: JSON.stringify(data),
        }),

    delete: (id: number) =>
        request(`/credentials/${id}`, {
            method: "DELETE",
            headers: getAuthHeaders(),
        }),

    setDefault: (id: number) =>
        request(`/credentials/${id}/default`, {
            method: "POST",
            headers: getAuthHeaders(),
        }),

    test: (id: number) =>
        request<TestResultResponse>(`/credentials/${id}/test`, {
            method: "POST",
            headers: getAuthHeaders(),
        }),
};
