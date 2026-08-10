/**
 * Settings API (legacy) - 兼容旧的单组 LLM/Embedding/ASR 凭证读写.
 */
import { request, getAuthHeaders } from "./client";

export interface CredentialsStatus {
    llm_is_configured: boolean;
    llm_masked_key: string | null;
    llm_base_url: string | null;
    llm_model: string | null;
    embedding_is_configured: boolean;
    embedding_masked_key: string | null;
    embedding_base_url: string | null;
    embedding_model: string | null;
    asr_is_configured: boolean;
    asr_masked_key: string | null;
    asr_base_url: string | null;
    asr_model: string | null;
    updated_at: string | null;
}

export interface SetCredentialsParams {
    llm_api_key?: string;
    llm_base_url?: string;
    llm_model?: string;
    embedding_api_key?: string;
    embedding_base_url?: string;
    embedding_model?: string;
    asr_api_key?: string;
    asr_base_url?: string;
    asr_model?: string;
}

export const settingsApi = {
    getCredentialsStatus: () =>
        request<CredentialsStatus>("/settings/credentials/status", {
            headers: getAuthHeaders(),
        }),

    setCredentials: (params: SetCredentialsParams) =>
        request<{ message: string }>("/settings/credentials", {
            method: "POST",
            headers: getAuthHeaders(),
            body: JSON.stringify(params),
        }),

    deleteCredentials: () =>
        request<{ message: string }>("/settings/credentials", {
            method: "DELETE",
            headers: getAuthHeaders(),
        }),
};
