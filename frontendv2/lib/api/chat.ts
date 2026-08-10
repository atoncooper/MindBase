/**
 * Chat API - 问答 / 流式 / 会话管理 / 历史消息.
 */
import { request, getAuthHeaders, API_BASE_URL } from "./client";

export interface ChatResponse {
    answer: string;
    sources: Array<{
        bvid: string;
        title: string;
        url: string;
    }>;
}

export interface ReasoningStep {
    step: number;
    action: string;
    query: string;
    reasoning: string;
    verdict?: string | null;
    recall_score?: number | null;
    sources: Array<{
        bvid: string;
        title: string;
        url: string;
    }>;
    content_preview: string;
}

// 工作区页面（用户选中的已向量化分P）
export interface WorkspacePage {
    bvid: string;
    cid: number;
    page_index: number;
    page_title?: string;
}

// Chat session (v2: uid-based auth)
export interface ChatSession {
    id: number;
    chat_session_id: string;
    uid?: number;
    title?: string;
    status: string;
    created_at: string;
    updated_at: string;
    last_message_at?: string;
}

// 聊天消息 (v2: MongoDB-backed, msg_id is str)
export interface ChatMessage {
    msg_id: string;
    chat_session_id: string;
    role: "user" | "assistant" | "system";
    content: string;
    status: "pending" | "completed" | "failed";
    sources?: Array<{ bvid: string; title: string; url?: string }>;
    tokens_used?: number;
    model?: string;
    latency_ms?: number;
    error?: string;
    created_at: string;
}

// 聊天历史响应
export interface ChatHistoryResponse {
    messages: ChatMessage[];
    total: number;
    page: number;
    page_size: number;
    has_more: boolean;
    next_cursor?: string | null;
}

// 会话列表响应
export interface ChatSessionListResponse {
    sessions: ChatSession[];
}

export interface ChatSessionUpdatePayload {
    title: string;
}

// 对话请求载荷（统一构造方式）
export interface ChatRequestPayload {
    question: string;
    session_id?: string;
    chat_session_id?: string;  // 新增：聊天会话 ID
    folder_ids?: number[];
    workspace_pages?: WorkspacePage[];
    workspace_id?: number;  // Plan 0023: cloud drive workspace
}

export const chatApi = {
    // 提问（标准模式）
    ask: (payload: ChatRequestPayload) =>
        request<ChatResponse>("/chat/ask", {
            method: "POST",
            headers: getAuthHeaders(),
            body: JSON.stringify(payload),
        }),

    // 搜索
    search: (query: string, k = 5) =>
        request<{ results: Array<{ bvid: string; title: string; url: string; content_preview: string }> }>(
            `/chat/search?query=${encodeURIComponent(query)}&k=${k}`,
            { method: "POST" }
        ),

    // === 新增：流式接口（替代裸调 fetch）===
    // askStream: hit the backend directly instead of going through Next.js dev
    // rewrites - the dev proxy buffers SSE, collapsing token-by-token streaming
    // into one bulk delivery. In the browser we resolve the direct target from
    // NEXT_PUBLIC_APISIX_HOST (dev) or NEXT_PUBLIC_API_URL (prod, nginx). On the
    // server (SSR) we fall back to the docker service name.
    askStream: async (
        payload: ChatRequestPayload,
        signal?: AbortSignal
    ): Promise<ReadableStream<Uint8Array>> => {
        const streamBase =
            API_BASE_URL ||
            (typeof window !== "undefined"
                ? process.env.NEXT_PUBLIC_APISIX_HOST
                    ? `http://${process.env.NEXT_PUBLIC_APISIX_HOST}`
                    : "http://localhost:8000"
                : "http://backend:8000");
        const res = await fetch(`${streamBase}/chat/ask/agent/stream`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...getAuthHeaders() },
            body: JSON.stringify(payload),
            signal,
        });

        // 会话失效：清本地登录态并通知 AuthProvider 统一跳转（替代硬刷新）
        if (res.status === 401) {
            if (typeof window !== "undefined") {
                localStorage.removeItem("bili_session");
                localStorage.removeItem("bili_user");
                window.dispatchEvent(new Event("auth:unauthorized"));
            }
            throw new Error("会话已过期，请重新登录");
        }

        if (!res.ok || !res.body) {
            throw new Error("流式接口不可用");
        }
        return res.body;
    },

    // === 新增：会话管理 (v2: Bearer token auth) ===
    createSession: (title?: string) =>
        request<ChatSession>("/chat/sessions", {
            method: "POST",
            headers: getAuthHeaders(),
            body: JSON.stringify({ title }),
        }),

    listSessions: () =>
        request<ChatSessionListResponse>("/chat/sessions", {
            headers: getAuthHeaders(),
        }),

    updateSession: (chatSessionId: string, payload: ChatSessionUpdatePayload) =>
        request<ChatSession>(`/chat/sessions/${chatSessionId}`, {
            method: "PATCH",
            body: JSON.stringify(payload),
        }),

    deleteSession: (chatSessionId: string) =>
        request(`/chat/sessions/${chatSessionId}`, { method: "DELETE" }),

    // === 新增：历史消息 ===
    getHistory: (chatSessionId: string, page = 1, pageSize = 50) =>
        request<ChatHistoryResponse>(
            `/chat/history?chat_session_id=${chatSessionId}&page=${page}&page_size=${pageSize}`
        ),

    clearHistory: (chatSessionId: string) =>
        request(`/chat/history?chat_session_id=${chatSessionId}`, { method: "DELETE" }),
};
