/**
 * Coding Plan API - 用户自带的第三方编程套餐（站内 Code Agent 使用）。
 *
 * Backend: app-user /settings/coding-plans (VIP/SVIP only). Responses are
 * snake_case; the API key is write-only — list/detail only ever expose
 * api_key_masked. Identity comes from the session_token Bearer token, so every
 * request carries Authorization explicitly (the shared client also injects it).
 */

import { getAuthHeaders, request } from "./client";

/** 服务商标识（后端为 varchar(32) slug；支持列表见 coding-plan 卡） */
export type CodingPlanProvider = string;
export type CodingPlanProtocol = "openai" | "anthropic";

export interface CodingPlan {
    id: number;
    provider: CodingPlanProvider;
    protocol: CodingPlanProtocol;
    label: string;
    base_url: string;
    model: string;
    /** 掩码形式（如 sk-****abcd），明文永不返回 */
    api_key_masked: string;
    enabled: boolean;
    /** 是否被用户设为默认套餐（每个用户最多一个） */
    is_default: boolean;
    created_at: string | null;
    updated_at: string | null;
}

export interface CodingPlanInput {
    provider: CodingPlanProvider;
    protocol: CodingPlanProtocol;
    label: string;
    base_url: string;
    model: string;
    api_key: string;
    enabled?: boolean;
}

/** PATCH 任意字段；api_key 省略或空串 = 不修改已存密钥。 */
export type CodingPlanPatch = Partial<Omit<CodingPlanInput, "api_key">> & {
    api_key?: string;
};

export interface CodingPlanModels {
    plan_id: number;
    provider: string;
    protocol: CodingPlanProtocol;
    models: string[];
}

export interface CodingPlanTestResult {
    ok: boolean;
    message: string;
    models?: string[];
}

/** Operator-owned provider catalog entry (default.yaml settings.coding_plan). */
export interface CodingPlanProviderInfo {
    name: string;
    label: string;
    openai_base_url: string;
    anthropic_base_url: string;
    models_url?: string;
    model_hint?: string;
}

/** GET /settings/coding-plans response: plans + the YAML provider catalog. */
export interface CodingPlanListResponse {
    plans: CodingPlan[];
    providers: CodingPlanProviderInfo[];
}

/** Settings-domain base path (migrated from /auth/coding-plans). */
const BASE = "/settings/coding-plans";

function planPath(id: number): string {
    return `${BASE}/${encodeURIComponent(String(id))}`;
}

export const codingPlanApi = {
    async list(): Promise<CodingPlanListResponse> {
        const res = await request<CodingPlanListResponse>(BASE, {
            headers: getAuthHeaders(),
        });
        return {
            plans: res.plans ?? [],
            providers: res.providers ?? [],
        };
    },

    async create(body: CodingPlanInput): Promise<CodingPlan> {
        const res = await request<{ plan: CodingPlan }>(BASE, {
            method: "POST",
            headers: getAuthHeaders(),
            body: JSON.stringify(body),
        });
        return res.plan;
    },

    async update(id: number, body: CodingPlanPatch): Promise<CodingPlan> {
        const res = await request<{ plan: CodingPlan }>(planPath(id), {
            method: "PATCH",
            headers: getAuthHeaders(),
            body: JSON.stringify(body),
        });
        return res.plan;
    },

    async remove(id: number): Promise<{ message: string }> {
        return request<{ message: string }>(planPath(id), {
            method: "DELETE",
            headers: getAuthHeaders(),
        });
    },

    /**
     * 该套餐可用的模型。默认读 Redis 缓存；refresh=true 强制回源探测并重写缓存
     * （账户页「刷新模型」按钮）。
     */
    async models(id: number, refresh = false): Promise<CodingPlanModels> {
        return request<CodingPlanModels>(`${planPath(id)}/models${refresh ? "?refresh=1" : ""}`, {
            headers: getAuthHeaders(),
        });
    },

    /** 设为默认套餐（聊天未显式选模型时使用该套餐）。 */
    async setDefault(id: number): Promise<{ message: string }> {
        return request<{ message: string }>(`${planPath(id)}/default`, {
            method: "PUT",
            headers: getAuthHeaders(),
        });
    },

    /** 取消默认（聊天回落到平台网关默认模型）。 */
    async clearDefault(): Promise<{ message: string }> {
        return request<{ message: string }>(`${BASE}/default`, {
            method: "DELETE",
            headers: getAuthHeaders(),
        });
    },

    async test(id: number): Promise<CodingPlanTestResult> {
        return request<CodingPlanTestResult>(`${planPath(id)}/test`, {
            method: "POST",
            headers: getAuthHeaders(),
        });
    },
};
