/**
 * API 客户端
 */

import { sanitizeError } from "@/lib/error-utils";

export const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || (typeof window !== "undefined" ? "" : "http://backend:8000");

// 获取当前 session token 的 Authorization header
function getAuthHeaders(): Record<string, string> {
    if (typeof window === "undefined") return {};
    const token = localStorage.getItem("bili_session");
    if (!token) return {};
    return { Authorization: `Bearer ${token}` };
}

// 通用请求函数
async function request<T>(
    endpoint: string,
    options: RequestInit = {}
): Promise<T> {
    const url = `${API_BASE_URL}${endpoint}`;

    const response = await fetch(url, {
        ...options,
        headers: {
            "Content-Type": "application/json",
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

// ==================== 类型定义 ====================

export interface QRCodeResponse {
    qrcode_key: string;
    qrcode_url: string;
    qrcode_image_base64: string;
}

export interface LoginStatusResponse {
    status: "waiting" | "scanned" | "confirmed" | "expired";
    message: string;
    user_info?: UserInfo;
    /** @deprecated Use session_token instead */
    session_id?: string;
}

export interface TokenResponse {
    session_token: string;
    token_type: string;
    expires_at?: string;
    user_info: UserInfo;
}

export interface UserInfo {
    uid?: number;
    mid?: number;
    uname?: string;
    face?: string;
    level?: number;
    roles?: string[];
    session_token?: string;
    /** @deprecated Legacy compat */
    session_id?: string;
}

export interface FavoriteFolder {
    media_id: number;
    title: string;
    media_count: number;
    is_selected: boolean;
    is_default?: boolean;
}

export interface Video {
    bvid: string;
    title: string;
    cover?: string;
    duration?: number;
    owner?: string;
    play_count?: number;
    intro?: string;
    is_selected: boolean;
    page_count?: number;
}

export interface VideoPageInfo {
    cid: number;
    page: number;       // 1-based
    title: string;     // B站 part 字段
    duration: number;
}

export interface VideoPagesResponse {
    bvid: string;
    title: string;
    pages: VideoPageInfo[];
    page_count: number;
}

export interface FavoriteVideosResponse {
    folder_info: Record<string, unknown>;
    videos: Video[];
    has_more: boolean;
    page: number;
    page_size: number;
}

export interface OrganizePreviewItem {
    bvid: string;
    title: string;
    resource_id: number;
    resource_type: number;
    target_folder_id: number | null;
    target_folder_title: string;
    reason?: string;
}

export interface OrganizePreviewResponse {
    default_folder_id: number;
    default_folder_title: string;
    folders: FavoriteFolder[];
    items: OrganizePreviewItem[];
    stats: {
        total: number;
        matched: number;
        unmatched: number;
    };
}

export interface BuildRequest {
    folder_ids: number[];
    exclude_bvids?: string[];
}

export interface BuildStatus {
    task_id: string;
    status: "pending" | "running" | "completed" | "failed";
    progress: number;
    current_step: string;
    total_videos: number;
    processed_videos: number;
    message: string;
}

export interface FolderStatus {
    media_id: number;
    indexed_count: number;
    media_count?: number;
    last_sync_at?: string;
}

export interface SyncRequest {
    folder_ids?: number[];
}

export interface SyncResult {
    folder_id: number;
    total: number;
    added: number;
    removed: number;
    indexed: number;
    message: string;
    last_sync_at: string;
}

export interface KnowledgeStats {
    total_chunks: number;
    total_videos: number;
    collection_name: string;
}

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

export interface AgenticChatResponse {
    answer: string;
    sources: Array<{
        bvid: string;
        title: string;
        url: string;
    }>;
    reasoning_steps: ReasoningStep[];
    synthesis_method: string;
    hops_used: number;
    avg_recall_score: number;
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

// ==================== API 函数 ====================

// 认证相关
export const authApi = {
    // 获取登录二维码
    getQRCode: () => request<QRCodeResponse>("/auth/qrcode"),

    // 轮询登录状态
    pollQRCode: (qrcodeKey: string) =>
        request<LoginStatusResponse>(`/auth/qrcode/poll/${qrcodeKey}`),

    // 邮箱密码登录
    login: (email: string, password: string, device?: Record<string, string | undefined>) =>
        request<TokenResponse>("/auth/login", {
            method: "POST",
            body: JSON.stringify({ email, password, device }),
        }),

    /** @deprecated Use getMe with Bearer token */
    getSession: (sessionId: string) =>
        request<{ valid: boolean; user_info: UserInfo }>(`/auth/session/${sessionId}`),

    // Get current user via Bearer token
    getMe: (token: string) =>
        request<UserInfo>("/auth/me", {
            headers: { Authorization: `Bearer ${token}` },
        }),

    // Logout current device (Bearer token)
    logoutCurrent: (token: string) =>
        request("/auth/token", {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}` },
        }),

    // Logout all devices
    logoutAll: (token: string) =>
        request("/auth/tokens", {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}` },
        }),

    /** @deprecated Use logoutCurrent / logoutAll with Bearer token */
    logout: (sessionId: string) =>
        request(`/auth/session/${sessionId}`, { method: "DELETE" }),
};

// ══════════════════════════════════════════════════════════════
// 收藏夹 v2 (Bearer token, uid-based)
// ══════════════════════════════════════════════════════════════

export interface FavoriteFolderV2 {
    id: number;
    media_id: number;
    title: string;
    media_count: number;
    is_default: boolean;
    is_selected: boolean;
    last_sync_at: string | null;
}

export interface FavoriteVideoV2 {
    id: number;
    bvid: string;
    title: string;
    cover: string | null;
    duration: number | null;
    owner: string | null;
    cid: number | null;
    is_selected: boolean;
    synced_at: string | null;
}

export interface FavoriteVideoPageV2 {
    folder_id: number;
    media_id: number;
    folder_title: string;
    videos: FavoriteVideoV2[];
    total: number;
    page: number;
    page_size: number;
    has_more: boolean;
}

export interface VideoPageItemV2 {
    cid: number;
    page_index: number;
    page_title: string | null;
    is_processed: boolean;
    is_vectorized: string;
    vector_chunk_count: number;
}

export interface VideoPageListV2 {
    bvid: string;
    pages: VideoPageItemV2[];
    page_count: number;
    is_stored: boolean;
}

export const favoritesV2Api = {
    listFolders: () =>
        request<FavoriteFolderV2[]>("/favorites/v2/list", {
            headers: getAuthHeaders(),
        }),

    syncFolders: () =>
        request<{ folders: FavoriteFolderV2[]; total: number }>("/favorites/v2/sync", {
            method: "POST",
            headers: getAuthHeaders(),
        }),

    updateSelected: (folderId: number, isSelected: boolean) =>
        request<{ folder_id: number; is_selected: boolean }>(
            `/favorites/v2/${folderId}/selected?is_selected=${isSelected}`,
            { method: "PATCH", headers: getAuthHeaders() }
        ),

    deleteFolder: (folderId: number) =>
        request<{ message: string; folder_id: number }>(
            `/favorites/v2/${folderId}`,
            { method: "DELETE", headers: getAuthHeaders() }
        ),

    listVideos: (mediaId: number, page = 1, pageSize = 20) =>
        request<FavoriteVideoPageV2>(
            `/favorites/v2/media/${mediaId}/videos?page=${page}&page_size=${pageSize}`,
            { headers: getAuthHeaders() }
        ),

    listVideoPages: (bvid: string) =>
        request<VideoPageListV2>(
            `/favorites/v2/video/${bvid}/pages`,
            { headers: getAuthHeaders() }
        ),
};

// ══════════════════════════════════════════════════════════════
// 收藏夹 v1 (deprecated — use favoritesV2Api instead)
// ══════════════════════════════════════════════════════════════

/** @deprecated Use favoritesV2Api instead */
export const favoritesApi = {
    /** @deprecated Use favoritesV2Api.listFolders() */
    getList: (sessionId: string) =>
        request<FavoriteFolder[]>(`/favorites/list?session_id=${sessionId}`),

    // 获取收藏夹视频（分页）
    getVideos: (mediaId: number, sessionId: string, page = 1) =>
        request<FavoriteVideosResponse>(
            `/favorites/${mediaId}/videos?session_id=${sessionId}&page=${page}`
        ),

    // 获取收藏夹全部视频
    getAllVideos: (mediaId: number, sessionId: string) =>
        request<{ total: number; videos: Video[] }>(
            `/favorites/${mediaId}/all-videos?session_id=${sessionId}`
        ),

    // 预览整理
    organizePreview: (folderId: number, sessionId: string) =>
        request<OrganizePreviewResponse>(
            `/favorites/organize/preview?session_id=${sessionId}`,
            {
                method: "POST",
                body: JSON.stringify({ folder_id: folderId }),
            }
        ),

    // 执行整理
    organizeExecute: (
        data: {
            default_folder_id: number;
            moves: Array<{ resource_id: number; resource_type: number; target_folder_id: number }>;
        },
        sessionId: string
    ) =>
        request<{ message: string; moved: number; groups: number }>(
            `/favorites/organize/execute?session_id=${sessionId}`,
            {
                method: "POST",
                body: JSON.stringify(data),
            }
        ),

    // 清理失效内容
    cleanInvalid: (folderId: number, sessionId: string) =>
        request<{ message: string; data: Record<string, unknown> }>(
            `/favorites/organize/clean-invalid?session_id=${sessionId}`,
            {
                method: "POST",
                body: JSON.stringify({ folder_id: folderId }),
            }
        ),
};

export interface VectorizedPageItem {
    bvid: string;
    cid: number;
    page_index: number;
    page_title?: string;
    video_title?: string;
    vector_chunk_count: number;
    vectorized_at?: string;
}
export const knowledgeApi = {
    // 获取统计信息
    getStats: () => request<KnowledgeStats>("/knowledge/stats"),

    // 构建知识库
    build: (data: BuildRequest, sessionId: string) =>
        request<{ task_id: string; message: string }>(
            `/knowledge/build?session_id=${sessionId}`,
            {
                method: "POST",
                body: JSON.stringify(data),
            }
        ),

    // 获取构建状态
    getBuildStatus: (taskId: string) =>
        request<BuildStatus>(`/knowledge/build/status/${taskId}`),

    // 获取收藏夹入库状态 (v2: Bearer token auth)
    getFolderStatus: () =>
        request<FolderStatus[]>("/knowledge/folders/status", {
            headers: getAuthHeaders(),
        }),

    // 同步收藏夹到向量库
    syncFolders: (data: SyncRequest, sessionId: string) =>
        request<SyncResult[]>(
            `/knowledge/folders/sync?session_id=${sessionId}`,
            {
                method: "POST",
                body: JSON.stringify(data),
            }
        ),

    // 清空知识库
    clear: () =>
        request<{ message: string }>("/knowledge/clear", { method: "DELETE" }),

    // 删除视频
    deleteVideo: (bvid: string) =>
        request<{ message: string }>(`/knowledge/video/${bvid}`, { method: "DELETE" }),

    /** @deprecated Use favoritesV2Api.listVideoPages(bvid) */
    getVideoPages: (bvid: string) =>
        request<VideoPagesResponse>(`/knowledge/video/${bvid}/pages`),

    // 获取已向量化的分P列表 (v2: Bearer token auth)
    getVectorizedPages: () =>
        request<VectorizedPageItem[]>("/knowledge/pages/vectorized", {
            headers: getAuthHeaders(),
        }),
};

// 对话相关
export const chatApi = {
    // 提问（标准模式）
    ask: (payload: ChatRequestPayload) =>
        request<ChatResponse>("/chat/ask", {
            method: "POST",
            headers: getAuthHeaders(),
            body: JSON.stringify(payload),
        }),

    // 提问（Agentic RAG 模式）
    askAgentic: (payload: ChatRequestPayload) =>
        request<AgenticChatResponse>("/chat/ask/agentic", {
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
    askStream: async (payload: ChatRequestPayload): Promise<ReadableStream<Uint8Array>> => {
        const res = await fetch(`${API_BASE_URL}/chat/ask/stream`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...getAuthHeaders() },
            body: JSON.stringify(payload),
        });

        // 会话失效时自动清除登录状态并刷新页面（与 request() 保持一致）
        if (res.status === 401) {
            if (typeof window !== "undefined") {
                localStorage.removeItem("bili_session");
                localStorage.removeItem("bili_user");
                window.location.href = "/";
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

// ==================== 分P向量化相关 ====================

export interface VectorPageStatusResponse {
  exists: boolean;
  bvid?: string;
  cid?: number;
  page_index?: number;
  page_title?: string;
  is_processed: boolean;
  content_preview?: string;
  is_vectorized: "pending" | "processing" | "done" | "failed";
  vectorized_at?: string;
  vector_chunk_count: number;
  vector_error?: string;
  chroma_exists: boolean;
}

export interface VectorPageTaskStatus {
  task_id: string;
  status: "pending" | "processing" | "done" | "failed";
  progress: number;
  message: string;
  result?: { chunk_count?: number };
  error?: string;
}

export const vecPageApi = {
  // 查询向量状态
  getStatus: (bvid: string, cid: number) =>
    request<VectorPageStatusResponse>(
      `/vec/page/status?bvid=${bvid}&cid=${cid}`
    ),

  // 发起向量化（幂等）
  create: (params: { bvid: string; cid: number; page_index: number; page_title?: string }) =>
    request<{ task_id: string | null; message: string }>(
      "/vec/page/create",
      {
        method: "POST",
        body: JSON.stringify(params),
      }
    ),

  // 强制重新向量化
  revector: (params: { bvid: string; cid: number }) =>
    request<{ task_id: string; message: string }>(
      "/vec/page/revector",
      {
        method: "POST",
        body: JSON.stringify(params),
      }
    ),

  // 轮询任务状态
  getTaskStatus: (taskId: string) =>
    request<VectorPageTaskStatus>(`/vec/page/status/${taskId}`),
};

// ==================== ASR 分P相关 ====================

export interface ASRContentResponse {
    exists: boolean;
    bvid?: string;
    cid?: number;
    page_index?: number;
    page_title?: string;
    content?: string;
    content_source?: "asr" | "user_edit";
    version?: number;
    is_processed?: boolean;
}

export interface ASRTaskStatus {
    task_id: string;
    status: "pending" | "processing" | "done" | "failed";
    progress: number;
    message: string;
}

export interface VideoPageVersionInfo {
    version: number;
    content_source: string;
    content_preview: string;
    is_latest: boolean;
    created_at: string;
}

// ASR 分P相关
export const asrApi = {
    // 查询 ASR 内容
    getContent: (bvid: string, cid: number) =>
        request<ASRContentResponse>(`/asr/content?bvid=${bvid}&cid=${cid}`),

    // 发起 ASR（幂等）
    create: (params: { bvid: string; cid: number; page_index: number; page_title?: string }) =>
        request<{ task_id: string | null; message: string; version?: number }>(
            "/asr/create",
            {
                method: "POST",
                body: JSON.stringify(params),
            }
        ),

    // 手动编辑更新
    update: (params: { bvid: string; cid: number; page_index: number; content: string }) =>
        request<{ success: boolean; message: string }>(
            "/asr/update",
            {
                method: "POST",
                body: JSON.stringify(params),
            }
        ),

    // 强制重新 ASR
    reasr: (params: { bvid: string; cid: number; page_index: number }) =>
        request<{ task_id: string; message: string }>(
            "/asr/reasr",
            {
                method: "POST",
                body: JSON.stringify(params),
            }
        ),

    // 轮询任务状态
    getStatus: (taskId: string) =>
        request<ASRTaskStatus>(`/asr/status/${taskId}`),

    // 查询版本历史
    getVersions: (bvid: string, cid: number) =>
        request<VideoPageVersionInfo[]>(`/asr/versions?bvid=${bvid}&cid=${cid}`),
};

// ==================== 通用配置项类型 ====================

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

// ==================== Embedding 配置 API ====================

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

// ==================== ASR 配置 API ====================

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

// ==================== 兼容旧 Settings API ====================

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

// ==================== 多 Provider Credential 管理 ====================

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

// ==================== 计费/用量 ====================

export interface ProviderUsage {
    provider: string;
    total_tokens: number;
    api_calls: number;
    cost_estimate: number;
}

export interface CredentialUsageItem {
    credential_id: number | null;
    name: string;
    provider: string;
    total_tokens: number;
    api_calls: number;
    cost_estimate: number;
}

export interface UsageSummary {
    total_tokens: number;
    total_api_calls: number;
    by_provider: ProviderUsage[];
    by_credential: CredentialUsageItem[];
}

export const billingApi = {
    getSummary: (days = 30) =>
        request<UsageSummary>(`/billing/summary?days=${days}`, {
            headers: getAuthHeaders(),
        }),
};

// ==================== Quiz 题目训练系统 ====================

export interface QuizGenerateParams {
    folder_ids?: number[];
    pages?: Array<{ bvid: string; cid: number; page_index: number; page_title?: string }>;
    question_count?: number;
    difficulty?: string;
    title?: string;
}

export interface QuizGenerateResponse {
    quiz_uuid: string;
    question_count: number;
    estimated_cost_tokens: number;
}

export interface QuizQuestion {
    question_uuid: string;
    question_type: string;
    difficulty: string;
    question_text: string;
    options?: string[];
    correct_answer?: string | string[];
    explanation?: string;
    keywords?: string[];
}

export interface QuizSetData {
    quiz_uuid: string;
    title: string;
    status: string;
    question_count: number;
    type_distribution?: Record<string, number>;
    difficulty: string;
    total_score: number;
    passing_score: number;
    source_type?: string;
    source_pages?: Array<{ bvid: string; cid: number; page_index: number; page_title?: string }>;
    created_at: string;
    questions: QuizQuestion[];
}

export interface QuizAnswerItem {
    question_uuid: string;
    answer: string | string[];
}

export interface QuizAnswerResult {
    question_uuid: string;
    is_correct: boolean | null;
    auto_score: number | null;
    correct_answer: string | string[];
    grading_note?: string;
}

export interface QuizSubmissionResult {
    submission_uuid: string;
    score: number | null;
    passed: boolean | null;
    correct_count: number;
    total_count: number;
    results: QuizAnswerResult[];
}

export interface QuizHistoryItem {
    submission_uuid: string | null;
    quiz_uuid: string;
    title: string;
    status?: string;
    question_count?: number;
    difficulty?: string;
    source_type?: string;
    score: number | null;
    passed: boolean | null;
    correct_count: number;
    total_question_count: number;
    time_spent_seconds: number | null;
    submitted_at: string | null;
    created_at?: string;
}

export interface QuizHistoryResponse {
    submissions: QuizHistoryItem[];
    total: number;
    page: number;
    page_size: number;
    has_more: boolean;
}

export interface WrongAnswerItem {
    question_uuid: string;
    quiz_uuid: string;
    question_type: string;
    question_text: string;
    options?: string[];
    user_answer: string | string[];
    correct_answer: string | string[];
    explanation?: string;
    times_wrong: number;
    last_attempt_at: string;
}

export interface WrongAnswerResponse {
    wrong_answers: WrongAnswerItem[];
    total: number;
}

export const quizApi = {
    generate: (params: Omit<QuizGenerateParams, "session_id">) => {
        const sp = new URLSearchParams();
        if (params.folder_ids?.length) sp.set("folder_ids", params.folder_ids.join(","));
        if (params.question_count) sp.set("question_count", String(params.question_count));
        if (params.difficulty) sp.set("difficulty", params.difficulty);
        if (params.title) sp.set("title", params.title);
        const body = params.pages?.length ? JSON.stringify(params.pages) : undefined;
        return request<QuizGenerateResponse>(`/quiz/generate?${sp.toString()}`, {
            method: "POST",
            headers: { ...getAuthHeaders(), ...(body ? { "Content-Type": "application/json" } : {}) as Record<string,string> },
            ...(body ? { body } : {}),
        });
    },

    getQuiz: (quizUuid: string, includeAnswers = false) =>
        request<QuizSetData>(`/quiz/${quizUuid}${includeAnswers ? "?include_answers=true" : ""}`),

    submit: (params: {
        quiz_uuid: string;
        answers: QuizAnswerItem[];
        time_spent_seconds?: number;
    }) =>
        request<QuizSubmissionResult>("/quiz/submit", {
            method: "POST",
            headers: getAuthHeaders(),
            body: JSON.stringify(params),
        }),

    getHistory: (page = 1, pageSize = 10) =>
        request<QuizHistoryResponse>(`/quiz/history?page=${page}&page_size=${pageSize}`, {
            headers: getAuthHeaders(),
        }),

    getWrongAnswers: (folderIds?: number[]) =>
        request<WrongAnswerResponse>(
            `/quiz/wrong-answers${folderIds?.length ? `?folder_ids=${folderIds.join(",")}` : ""}`,
            { headers: getAuthHeaders() }
        ),

    exportData: async (format: "jsonl" | "csv" | "sft" = "jsonl", folderIds?: number[]) => {
        const sp = new URLSearchParams();
        sp.set("format", format);
        if (folderIds?.length) sp.set("folder_ids", folderIds.join(","));
        const res = await fetch(`${API_BASE_URL}/quiz/export?${sp.toString()}`, {
            headers: getAuthHeaders(),
        });
        if (!res.ok) throw new Error("导出失败");
        return res.blob();
    },
};

// ==================== 用户信息修改 ====================

export interface ProfileData {
    uid: number;
    email: string | null;
    email_verified: boolean;
    phone: string | null;
    phone_verified: boolean;
    nickname: string | null;
    avatar: string | null;
    bio: string | null;
    birthday: string | null;
    gender: string | null;
    location: string | null;
    timezone: string | null;
    language: string | null;
    status: string;
    created_at: string | null;
}

export interface SecurityOverview {
    email: string | null;
    email_verified: boolean;
    phone: string | null;
    phone_verified: boolean;
    has_password: boolean;
    oauth_bindings: Array<{
        provider: string;
        email: string | null;
        is_primary: boolean;
    }>;
}

export interface ProfileUpdateParams {
    nickname?: string;
    avatar?: string;
    bio?: string;
    birthday?: string;
    gender?: string;
    location?: string;
    timezone?: string;
    language?: string;
}

export interface PasswordSetParams {
    password: string;
}

export interface PasswordChangeParams {
    old_password: string;
    new_password: string;
}

export interface EmailBindParams {
    email: string;
}

export interface PhoneBindParams {
    phone: string;
}

export const userApi = {
    getProfile: () =>
        request<ProfileData>("/auth/profile", { headers: getAuthHeaders() }),

    updateProfile: (data: ProfileUpdateParams) =>
        request<ProfileData>("/auth/profile", {
            method: "PATCH",
            headers: getAuthHeaders(),
            body: JSON.stringify(data),
        }),

    setPassword: (data: PasswordSetParams) =>
        request<{ message: string }>("/auth/password/set", {
            method: "POST",
            headers: getAuthHeaders(),
            body: JSON.stringify(data),
        }),

    changePassword: (data: PasswordChangeParams) =>
        request<{ message: string }>("/auth/password", {
            method: "PATCH",
            headers: getAuthHeaders(),
            body: JSON.stringify(data),
        }),

    bindEmail: (data: EmailBindParams) =>
        request<{ message: string; email: string }>("/auth/email", {
            method: "PUT",
            headers: getAuthHeaders(),
            body: JSON.stringify(data),
        }),

    unbindEmail: () =>
        request<{ message: string }>("/auth/email", {
            method: "DELETE",
            headers: getAuthHeaders(),
        }),

    bindPhone: (data: PhoneBindParams) =>
        request<{ message: string; phone: string }>("/auth/phone", {
            method: "PUT",
            headers: getAuthHeaders(),
            body: JSON.stringify(data),
        }),

    unbindPhone: () =>
        request<{ message: string }>("/auth/phone", {
            method: "DELETE",
            headers: getAuthHeaders(),
        }),

    getSecurity: () =>
        request<SecurityOverview>("/auth/security", { headers: getAuthHeaders() }),
};

// ==================== 异步任务 ====================

export interface TaskStep {
    name: string;
    status: string;
    progress: number;
}

export interface TaskData {
    task_id: string;
    uid: number;
    task_type: string;       // vec_page / asr / arc_meta_extract / build
    target: unknown;
    status: string;           // pending / processing / done / failed
    progress: number;         // 0-100
    steps: TaskStep[] | null;
    result: unknown;
    error: string | null;
    created_at: string | null;
    updated_at: string | null;
    completed_at: string | null;
}

export interface WsTaskMessage {
    type: "tasks" | "task_detail" | "task_update" | "error";
    count?: number;
    tasks?: TaskData[];
    task?: TaskData;
    message?: string;
    timestamp?: number;
}

const TASK_TYPE_LABELS: Record<string, string> = {
    vec_page: "向量化",
    asr: "语音转文本",
    arc_meta_extract: "元数据提取",
    build: "知识库构建",
};

export function getTaskTypeLabel(type: string): string {
    return TASK_TYPE_LABELS[type] ?? type;
}

export function getTaskStatusLabel(status: string): string {
    return { pending: "等待中", processing: "处理中", done: "已完成", failed: "失败" }[status] ?? status;
}

// ==================== 云盘 (Cloud Drive) ====================

export interface CloudFolderTreeItem {
    id: number;
    parentId: number | null;
    name: string;
    videoCount: number;
    children: CloudFolderTreeItem[];
}

export interface CloudFolderTreeResponse {
    folders: CloudFolderTreeItem[];
}

export interface CloudFolderResponse {
    id: number;
    parentId: number | null;
    name: string;
    videoCount: number;
}

export interface CloudFolderCreateParams {
    parentId?: number | null;
    name: string;
}

export interface CloudFolderUpdateParams {
    name?: string;
    parentId?: number | null;
}

export interface CloudFolderDeleteResponse {
    deleted: boolean;
    affectedFiles: number;
}

export interface CloudVideoItem {
    uploadUuid: string;
    originalName: string;
    fileSize: number;
    duration: number | null;
    asrStatus: string;
    vectorStatus: string;
    vectorChunkCount: number | null;
    title: string | null;
    coverUrl: string | null;
    createdAt: string;
}

export interface CloudVideoListResponse {
    videos: CloudVideoItem[];
    total: number;
    page: number;
    pageSize: number;
    hasMore: boolean;
}

export interface CloudVideoDetailResponse {
    uploadUuid: string;
    originalName: string;
    fileSize: number;
    duration: number | null;
    asrStatus: string;
    vectorStatus: string;
    title: string | null;
    coverUrl: string | null;
    createdAt: string;
    description: string | null;
    tags: string[] | null;
    folderId: number | null;
    folderName: string | null;
    asrPreview: string | null;
    vectorChunkCount: number;
}

export interface CloudVideoUpdateParams {
    title?: string;
    description?: string;
    tags?: string[];
    folderId?: number | null;
}

export interface CloudUploadPart {
    PartNumber: number;
    ETag: string;
}

export interface CloudUploadInitParams {
    filename: string;
    fileSize: number;
    mimeType: string;
    folderId?: number | null;
}

export interface CloudPresignedUrlItem {
    chunkIndex: number;
    chunkSize: number;
    url: string;
}

export interface CloudUploadInitResponse {
    uploadUuid: string;
    sessionUuid: string;
    minioUploadId: string;
    chunkCount: number;
    chunkSize: number;
    presignedUrls: CloudPresignedUrlItem[];
}

export interface CloudUploadCompleteResponse {
    uploadUuid: string;
    etag: string;
    status: string;
}

export interface CloudResumeChunk {
    chunkIndex: number;
    chunkSize: number;
    url: string;
}

export interface CloudResumeResponse {
    uploadUuid: string;
    minioUploadId: string;
    pendingChunks: CloudResumeChunk[];
}

export interface CloudVideoProcessResponse {
    uploadUuid: string;
    asrTaskId?: string | null;
    vectorTaskId?: string | null;
}

export interface CloudVideoStatusResponse {
    asrStatus: string;
    asrProgress: number;
    vectorStatus: string;
    vectorChunkCount: number;
}

function formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

export { formatBytes };

const CHUNK_SIZE = 8 * 1024 * 1024; // 8 MiB per chunk

export const cloudApi = {
    // ── Folders ──
    listFolders: () =>
        request<CloudFolderTreeResponse>("/cloud/folders", {
            headers: getAuthHeaders(),
        }),

    createFolder: (data: CloudFolderCreateParams) =>
        request<CloudFolderResponse>("/cloud/folders", {
            method: "POST",
            headers: getAuthHeaders(),
            body: JSON.stringify(data),
        }),

    updateFolder: (id: number, data: CloudFolderUpdateParams) =>
        request<CloudFolderResponse>(`/cloud/folders/${id}`, {
            method: "PATCH",
            headers: getAuthHeaders(),
            body: JSON.stringify(data),
        }),

    deleteFolder: (id: number, force = false) =>
        request<CloudFolderDeleteResponse>(`/cloud/folders/${id}?force=${force}`, {
            method: "DELETE",
            headers: getAuthHeaders(),
        }),

    // ── Videos ──
    listVideos: (folderId?: number | null, page = 1, pageSize = 50, sort = "created_at", order = "desc") => {
        let url = `/cloud/videos?page=${page}&pageSize=${pageSize}&sort=${sort}&order=${order}`;
        if (folderId != null) url += `&folderId=${folderId}`;
        return request<CloudVideoListResponse>(url, { headers: getAuthHeaders() });
    },

    getVideoDetail: (uploadUuid: string) =>
        request<CloudVideoDetailResponse>(`/cloud/video/${uploadUuid}`, {
            headers: getAuthHeaders(),
        }),

    updateVideo: (uploadUuid: string, data: CloudVideoUpdateParams) =>
        request<CloudVideoDetailResponse>(`/cloud/video/${uploadUuid}`, {
            method: "PATCH",
            headers: getAuthHeaders(),
            body: JSON.stringify(data),
        }),

    deleteVideo: (uploadUuid: string) =>
        request<{ deleted: boolean; uploadUuid: string }>(`/cloud/video/${uploadUuid}`, {
            method: "DELETE",
            headers: getAuthHeaders(),
        }),

    // ── Upload ──
    initUpload: (data: CloudUploadInitParams) =>
        request<CloudUploadInitResponse>("/cloud/upload/init", {
            method: "POST",
            headers: getAuthHeaders(),
            body: JSON.stringify(data),
        }),

    completeUpload: (uploadUuid: string, parts: CloudUploadPart[]) =>
        request<CloudUploadCompleteResponse>(`/cloud/upload/${uploadUuid}/complete`, {
            method: "POST",
            headers: getAuthHeaders(),
            body: JSON.stringify({ parts }),
        }),

    heartbeat: (sessionUuid: string) =>
        request<{ ack: boolean }>("/cloud/upload/heartbeat", {
            method: "POST",
            headers: getAuthHeaders(),
            body: JSON.stringify({ sessionUuid }),
        }),

    resumeUpload: (uploadUuid: string) =>
        request<CloudResumeResponse>(`/cloud/upload/${uploadUuid}/resume`, {
            method: "POST",
            headers: getAuthHeaders(),
        }),

    // ── Processing ──
    triggerProcess: (uploadUuid: string) =>
        request<CloudVideoProcessResponse>(`/cloud/video/${uploadUuid}/process`, {
            method: "POST",
            headers: getAuthHeaders(),
        }),

    getVideoStatus: (uploadUuid: string) =>
        request<CloudVideoStatusResponse>(`/cloud/video/${uploadUuid}/status`, {
            headers: getAuthHeaders(),
        }),

    // ── Helper: chunked upload ──
    /** Upload a file to the cloud drive with chunked multipart upload */
    uploadFile: async (
        file: File,
        folderId: number | null,
        onProgress?: (pct: number) => void,
    ): Promise<CloudUploadCompleteResponse> => {
        // 1. Init
        const init = await cloudApi.initUpload({
            filename: file.name,
            fileSize: file.size,
            mimeType: file.type || "application/octet-stream",
            folderId,
        });

        // 2. Upload each chunk with presigned URLs
        const parts: CloudUploadPart[] = [];
        const heartbeatInterval = setInterval(() => {
            cloudApi.heartbeat(init.sessionUuid).catch(() => {});
        }, 60_000);

        try {
            for (const chunk of init.presignedUrls) {
                const start = chunk.chunkIndex * init.chunkSize;
                const end = Math.min(start + chunk.chunkSize, file.size);
                const blob = file.slice(start, end);

                const res = await fetch(chunk.url, {
                    method: "PUT",
                    body: blob,
                });

                if (!res.ok) {
                    throw new Error(`Chunk ${chunk.chunkIndex} upload failed: ${res.status}`);
                }

                const etag = res.headers.get("ETag") ?? "";
                parts.push({ PartNumber: chunk.chunkIndex + 1, ETag: etag });

                const pct = Math.round(((chunk.chunkIndex + 1) / init.presignedUrls.length) * 100);
                onProgress?.(pct);
            }
        } finally {
            clearInterval(heartbeatInterval);
        }

        // 3. Complete
        return cloudApi.completeUpload(init.uploadUuid, parts);
    },
};

// ==================== Plan 0023: Workspace API ====================

export interface WorkspaceBinding {
    id: number;
    bindType: "folder" | "file";
    folderId?: number;
    folderName?: string;
    uploadUuid?: string;
    fileName?: string;
    includeSubfolders: boolean;
}

export interface WorkspaceItem {
    id: number;
    name: string;
    description?: string;
    icon?: string;
    color?: string;
    fileCount: number;
    chunkCount: number;
    bindings: WorkspaceBinding[];
    createdAt: string;
    updatedAt: string;
}

export interface WorkspaceCreateParams {
    name: string;
    description?: string;
    icon?: string;
    color?: string;
}

export interface BindingCreateParams {
    bindType: "folder" | "file";
    folderId?: number;
    uploadUuid?: string;
    includeSubfolders?: boolean;
}

export const workspaceApi = {
    list: () => request<WorkspaceItem[]>("/workspaces"),
    create: (data: WorkspaceCreateParams) =>
        request<WorkspaceItem>("/workspaces", { method: "POST", body: JSON.stringify(data) }),
    get: (id: number) => request<WorkspaceItem>(`/workspaces/${id}`),
    update: (id: number, data: Partial<WorkspaceCreateParams>) =>
        request<WorkspaceItem>(`/workspaces/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    delete: (id: number) => request<{ deleted: boolean }>(`/workspaces/${id}`, { method: "DELETE" }),
    addBinding: (id: number, data: BindingCreateParams) =>
        request<WorkspaceItem>(`/workspaces/${id}/bindings`, { method: "POST", body: JSON.stringify(data) }),
    removeBinding: (workspaceId: number, bindingId: number) =>
        request<{ deleted: boolean }>(`/workspaces/${workspaceId}/bindings/${bindingId}`, { method: "DELETE" }),
    listFiles: (id: number) =>
        request<{ uploadUuid: string; originalName: string; mimeType: string; vectorizable: boolean; vectorStatus: string; vectorChunkCount: number }[]>(`/workspaces/${id}/files`),
};
