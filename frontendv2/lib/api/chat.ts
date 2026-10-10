/**
 * Chat API - 问答 / 流式 / 会话管理 / 历史消息.
 */
import { request, getAuthHeaders, API_BASE_URL } from "./client";
import type { ChatArtifact } from "@/lib/chat-stream";

// 工作区页面（用户选中的已向量化分P）
export interface WorkspacePage {
    bvid: string;
    cid: number;
    page_index: number;
    page_title?: string;
}

// Chat session（app-ts mind_base_ts 会话；唯一身份是 chat_session_id 字符串）
export interface ChatSession {
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
    /** attached images: presigned MinIO URLs (durable) or legacy inline data URLs */
    images?: string[];
    // Binary outputs (e.g. run_code images) persisted with the message;
    // url is a freshly presigned link refreshed by the history endpoint.
    artifacts?: ChatArtifact[];
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

// 会话文档（app-ts /chat/documents）：pdf/docx/pptx/txt/md/html，解析切块后
// 只在当前会话内检索（不进全局向量库）。
export interface SessionDocument {
    id: string;
    session_id: string;
    filename: string;
    size_bytes: number;
    chunk_count: number;
    created_at: number;
    /** 原始文件下载(相对预签名 URL,经 nginx /minio-proxy/);旧数据/未存时缺省 */
    download_url?: string;
}

export interface SessionDocumentListResponse {
    documents: SessionDocument[];
}

export interface SessionDocumentDeleteResponse {
    success: boolean;
    deleted: boolean;
}

// 对话请求载荷（统一构造方式）
export interface ChatRequestPayload {
    question: string;
    session_id?: string;
    chat_session_id?: string;  // 新增：聊天会话 ID
    folder_ids?: number[];
    workspace_pages?: WorkspacePage[];
    workspace_id?: number;  // Plan 0023: cloud drive workspace
    skill_ids?: string[];  // 强制注入本次对话的已安装技能（全文进 system prompt）
    images?: string[];  // 多模态：随消息附带的图片（data URL；需当前模型 vision=true）
    board_uuid?: string;  // 板聊：请求限定在某块板子上（后端直路由 board agent）
    board_anchor_text?: string;  // 板聊：画布当前选中节点纯文本（作为建议锚点上下文）
}

export const chatApi = {
    // === 流式接口（唯一问答入口）===
    // askStream: hit the gateway directly instead of going through Next.js dev
    // rewrites - the dev proxy buffers SSE, collapsing token-by-token streaming
    // into one bulk delivery. In the browser we resolve the direct target from
    // NEXT_PUBLIC_APISIX_HOST (dev) or NEXT_PUBLIC_API_URL (prod, nginx). On the
    // server (SSR) we fall back to the docker service name.
    askStream: async (
        payload: ChatRequestPayload,
        signal?: AbortSignal
    ): Promise<ReadableStream<Uint8Array>> => {
        // Use API_BASE_URL directly: in the browser it's "" (relative) so fetch
        // hits the current origin (nginx in prod, which has proxy_buffering off
        // for /chat); SSR gets the internal absolute URL (http://nginx:80). Do
        // NOT fall back to NEXT_PUBLIC_APISIX_HOST - in docker prod it's the
        // container name "nginx:80" which the browser can't DNS-resolve, which
        // was the root cause of "生成失败". Dev: set NEXT_PUBLIC_API_URL to an
        // absolute apisix URL to bypass dev-proxy SSE buffering.
        const streamBase = API_BASE_URL;
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
            // 透传后端的业务 detail（如「当前模型 X 不支持视觉，无法识别图片」），
            // 不要用含糊的"流式接口不可用"吞掉明确原因。
            let detail = "";
            try {
                const parsed = (await res.json()) as { detail?: unknown };
                if (typeof parsed.detail === "string") detail = parsed.detail;
            } catch {
                // 非 JSON 响应体（网关层 HTML 错误页）
            }
            throw new Error(detail || "流式接口不可用");
        }
        return res.body;
    },

    // === 会话管理 ===
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

    // === 历史消息 ===
    getHistory: (chatSessionId: string, page = 1, pageSize = 50) =>
        request<ChatHistoryResponse>(
            `/chat/history?chat_session_id=${chatSessionId}&page=${page}&page_size=${pageSize}`
        ),

    clearHistory: (chatSessionId: string) =>
        request(`/chat/history?chat_session_id=${chatSessionId}`, { method: "DELETE" }),

    // Delete msg_id and all later messages of the session (per-turn regenerate:
    // the target turn is truncated server-side, then re-asked).
    truncateHistoryFrom: (chatSessionId: string, msgId: string) =>
        request<{ success: boolean; deleted: number }>(
            `/chat/history/from/${msgId}?chat_session_id=${chatSessionId}`,
            { method: "DELETE" }
        ),

    // === 会话文件（当前会话上传的文档，服务端解析切块、随会话检索）===
    uploadDocument: (file: File, sessionId: string) => {
        const form = new FormData();
        form.append("file", file);
        form.append("session_id", sessionId);
        // FormData 走 request()：client 对 FormData 不注入 Content-Type，由浏览器
        // 自带 multipart 边界（见 lib/api/client.ts）。
        return request<SessionDocument>("/chat/documents", {
            method: "POST",
            body: form,
        });
    },

    listDocuments: (sessionId: string) =>
        request<SessionDocumentListResponse>(
            `/chat/documents?session_id=${encodeURIComponent(sessionId)}`
        ),

    deleteDocument: (sessionId: string, docId: string) =>
        request<SessionDocumentDeleteResponse>(
            `/chat/documents?session_id=${encodeURIComponent(sessionId)}&id=${encodeURIComponent(docId)}`,
            { method: "DELETE" }
        ),
};
