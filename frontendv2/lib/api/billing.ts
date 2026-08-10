/**
 * Billing API - 用量 / 计费汇总（按 provider / credential / model / 时序）.
 */
import { request, getAuthHeaders } from "./client";

export interface ProviderUsage {
    provider: string;
    total_tokens: number;
    prompt_tokens: number;
    completion_tokens: number;
    api_calls: number;
    cost_estimate: number;
}

export interface CredentialUsageItem {
    credential_id: number | null;
    name: string;
    provider: string;
    total_tokens: number;
    prompt_tokens: number;
    completion_tokens: number;
    api_calls: number;
    cost_estimate: number;
}

export interface ModelUsage {
    model: string;
    provider: string;
    total_tokens: number;
    prompt_tokens: number;
    completion_tokens: number;
    api_calls: number;
    cost_estimate: number;
}

export interface UsageTimeseriesPoint {
    date: string;
    total_tokens: number;
    prompt_tokens: number;
    completion_tokens: number;
    api_calls: number;
    cost_estimate: number;
}

export interface UsageSummary {
    total_tokens: number;
    total_prompt_tokens: number;
    total_completion_tokens: number;
    total_api_calls: number;
    total_cost: number;
    avg_cost_per_call: number;
    by_provider: ProviderUsage[];
    by_credential: CredentialUsageItem[];
    by_model: ModelUsage[];
}

export const billingApi = {
    getSummary: (days = 30) =>
        request<UsageSummary>(`/billing/summary?days=${days}`, {
            headers: getAuthHeaders(),
        }),
    getByModel: (days = 30) =>
        request<ModelUsage[]>(`/billing/by-model?days=${days}`, {
            headers: getAuthHeaders(),
        }),
    getTimeseries: (days = 30) =>
        request<UsageTimeseriesPoint[]>(`/billing/timeseries?days=${days}`, {
            headers: getAuthHeaders(),
        }),
};
