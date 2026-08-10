/**
 * ASR config API - 多 Provider ASR 凭证管理（CRUD / 设默认 / 测试）.
 * Reuses the shared Config* types from embedding-config.ts.
 */
import { request, getAuthHeaders } from "./client";
import type { ConfigItem, TestResultResponse, ConfigCreateParams, ConfigUpdateParams } from "./embedding-config";

export const asrConfigApi = {
    list: () =>
        request<ConfigItem[]>("/settings/asr-configs", {
            headers: getAuthHeaders(),
        }),

    create: (data: ConfigCreateParams) =>
        request<ConfigItem>("/settings/asr-configs", {
            method: "POST",
            headers: getAuthHeaders(),
            body: JSON.stringify(data),
        }),

    update: (id: number, data: ConfigUpdateParams) =>
        request<ConfigItem>(`/settings/asr-configs/${id}`, {
            method: "PATCH",
            headers: getAuthHeaders(),
            body: JSON.stringify(data),
        }),

    delete: (id: number) =>
        request(`/settings/asr-configs/${id}`, {
            method: "DELETE",
            headers: getAuthHeaders(),
        }),

    setDefault: (id: number) =>
        request(`/settings/asr-configs/${id}/default`, {
            method: "POST",
            headers: getAuthHeaders(),
        }),

    test: (id: number) =>
        request<TestResultResponse>(`/settings/asr-configs/${id}/test`, {
            method: "POST",
            headers: getAuthHeaders(),
        }),
};
