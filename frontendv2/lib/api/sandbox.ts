/**
 * 沙箱 API - run_code 执行面板（docs/research-ui-api.md §7）.
 *
 * 后端契约：app-ts src/transport/http/routes/sandbox.ts（经 APISIX chat_ts →
 * app-ts，再由 app-ts 代理 app-sandbox /v1/executions*）。鉴权由网关注入
 * X-Uid，前端只带 bili_session 的 Bearer 头；错误体统一 { detail }（沿用
 * ./client 的 sanitizeError）。
 *
 * 本文件是唯一允许出现 /chat/sandbox 端点的地方：组件只 import sandboxApi
 * 与类型，不得自行 fetch（frontendv2 强制约束，见根 AGENTS.md §2.4）。
 */
import { getAuthHeaders, request } from "./client";

/** app-sandbox 执行状态机：queued → running → succeeded/failed/timeout/canceled。 */
export type SandboxExecutionStatus =
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "timeout"
    | "canceled";

/**
 * 产物元数据（沿用 app-sandbox executionPayload.artifacts 形状）。
 * url 是短时效预签名下载地址，可能缺失（对象存储未配置/签名失败）。
 */
export interface SandboxArtifact {
    name: string;
    size?: number;
    url?: string;
    sha256?: string;
    contentType?: string;
}

/**
 * 时间戳：app-sandbox 直接返回 Go time.Time（RFC3339 字符串），app-ts 目前
 * 原样透传；为兼容未来统一为毫秒数的改动，这里两种都接受。
 */
export type SandboxTimestamp = number | string;

/** 单条执行记录（GET /chat/sandbox/executions 的元素）。 */
export interface SandboxExecution {
    executionId: string;
    leaseId?: string;
    projectId?: string;
    purpose?: string;
    language: string;
    status: SandboxExecutionStatus;
    timeoutMs: number;
    stdoutPreview?: string;
    stderrPreview?: string;
    stdoutBytes?: number;
    stderrBytes?: number;
    errorCode?: string;
    createdAt: SandboxTimestamp;
    startedAt?: SandboxTimestamp;
    finishedAt?: SandboxTimestamp;
    durationMs?: number;
    exitCode?: number;
    /** 终态为 true；queued/running 为 false，前端据此决定是否轮询。 */
    done: boolean;
    artifacts?: SandboxArtifact[];
}

/** GET /chat/sandbox/executions 的响应；enabled=false 时 executions 恒为空。 */
export interface SandboxExecutionList {
    enabled: boolean;
    executions: SandboxExecution[];
}

/** GET /chat/sandbox/executions/:id 的响应。 */
export interface SandboxExecutionDetail {
    execution: SandboxExecution;
}

/** 路径段编码：executionId 由服务端生成，仍按不可信输入编码。 */
function seg(value: string): string {
    return encodeURIComponent(value);
}

export const sandboxApi = {
    /** 当前用户最近的执行记录（默认 20，服务端上限 50），新到旧。 */
    listExecutions: (limit = 20) => {
        const params = new URLSearchParams({ limit: String(limit) });
        return request<SandboxExecutionList>(`/chat/sandbox/executions?${params.toString()}`, {
            headers: getAuthHeaders(),
        });
    },

    /** 单条执行详情（面板展开时可选使用）。 */
    getExecution: (executionId: string) =>
        request<SandboxExecutionDetail>(`/chat/sandbox/executions/${seg(executionId)}`, {
            headers: getAuthHeaders(),
        }),

    /**
     * 取消排队中/运行中的执行。已终态时后端返回 { cancelled: false }（幂等）。
     * 空 JSON body 而非无 body：app-ts 的 POST 路由按 application/json 解析。
     */
    cancelExecution: (executionId: string) =>
        request<{ cancelled: boolean }>(`/chat/sandbox/executions/${seg(executionId)}/cancel`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...getAuthHeaders() },
            body: JSON.stringify({}),
        }),
};
