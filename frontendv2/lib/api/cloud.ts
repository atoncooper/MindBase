/**
 * Cloud drive API - 文件夹 / 视频 / 分块上传 / 处理 / 文档预览.
 */
import { request, getAuthHeaders, snakeToCamel } from "./client";

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
    mimeType: string;
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
    mimeType: string;
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

export interface CloudDocumentPreviewResponse {
    uploadUuid: string;
    fileName: string;
    mimeType: string;
    vectorizable: boolean;
    preview: string;
    docMeta: Record<string, unknown> | null;
    offset: number;
    limit: number;
    totalChars: number;
    hasMore: boolean;
    nextOffset: number | null;
}

export type CloudViewMode =
    | "video"
    | "audio"
    | "image"
    | "pdf"
    | "html"
    | "markdown"
    | "text"
    | "unsupported";

export interface CloudRawFileResponse {
    url: string;
    content: string | null;
    mimeType: string;
    fileName: string;
    fileSize: number;
    viewMode: CloudViewMode;
}

// ── New (app-cloud Go service): quota / search / trash / share ──

export interface CloudQuotaResponse {
    used: number;
    quota: number;
    tier: string;
    /** in-flight upload bytes (registered at init, consumed on complete) */
    pending: number;
    error?: string;
}

export interface CloudTrashItem {
    uploadUuid: string;
    originalName: string;
    fileSize: number;
    mimeType: string;
    deletedAt: string | null;
    purgeAt: string | null;
}

export interface CloudTrashResponse {
    items: CloudTrashItem[];
    total: number;
}

export interface CloudShareCreateParams {
    code?: string;
    expiresInDays?: number;
    maxDownloads?: number | null;
    /** 合规警告已确认（app-cloud 强制 true，缺省/拒绝 → 422） */
    legalAck?: boolean;
    /**
     * 内容审核告知单独确认（app-cloud 强制 true，缺省/拒绝 → 422）。
     * 确认后管理员可依法审核该分享的文件内容（受控预览，不提供下载）。
     */
    contentReviewAck?: boolean;
}

export interface CloudShareView {
    id: number;
    fileId: number;
    hasCode: boolean;
    /** 属主可见的明文提取码（legacy 哈希行为空 —— 用重设提取码换新码） */
    extractionCode?: string;
    expiresAt: string | null;
    maxDownloads: number | null;
    viewCount: number;
    downloadCount: number;
    isRevoked: boolean;
    createdAt: string | null;
    shareToken?: string;
    shareUrl?: string;
    /** 分享目标类型（文件夹分享支持新增后） */
    targetType?: "file" | "folder";
    /** target_type='folder' 时指向共享的 cloud_folders.id */
    folderId?: number | null;
    /** 合规警告已确认 */
    legalAck?: boolean;
    /** 内容审核告知单独确认（true 后管理员可受控预览该分享内容） */
    contentReviewAck?: boolean;
    /** 内容审核告知文案版本（确认留档） */
    contentReviewPolicyVersion?: string | null;
    moderationStatus?: "active" | "approved" | "banned";
    moderationReason?: string | null;
    moderationTime?: string | null;
    moderationBy?: string | null;
}

export interface CloudShareInfoResponse {
    fileName: string;
    fileSize: number;
    mimeType: string;
    requiresCode: boolean;
    createdAt: string | null;
    expiresAt: string | null;
    /** 浏览器设备证明挑战（签名 + token 绑定 + 10 分钟时效） */
    challenge?: string;
    /** "file" | "folder"（文件夹分享公开面，plan/1.0.16 §4） */
    targetType?: "file" | "folder";
    /** folder 分享：共享文件夹名 */
    folderName?: string;
    /** folder 分享：递归全部存活文件（上限 2000） */
    files?: CloudSharePublicFile[];
    /** files 超过 2000 条时截断 */
    truncated?: boolean;
}

/** folder 分享公开面的单文件元数据（fileId=cloud_files.id，access 时携带） */
export interface CloudSharePublicFile {
    fileId: number;
    name: string;
    size: number;
    mimeType: string;
    /** 相对共享文件夹的路径，如 "a/b" */
    path: string;
}

export interface CloudAttestation {
    fp: string;
    ticket: string;
}

export interface CloudShareAccessResponse {
    url: string;
    viewMode: CloudViewMode;
    mimeType: string;
    fileName: string;
    fileSize: number;
    expiresIn: number;
}

// ── cloud_refs 引用（保存到我的云盘，非复制；plan/1.0.16 §4 引用面） ──

export interface RefItem {
    id: number;
    name: string;
    size: number;
    mimeType: string;
    folderId: number | null;
    /** 'alive' | 'dead'（dead = 原文件删除 / 来源分享被封禁等，不可预览） */
    status: "alive" | "dead";
    shareId: number;
    sourceUploadUuid: string;
    /** 实时原文件名（快照兜底） */
    sourceName: string | null;
    createdAt: string | null;
    isRef: true;
}

export interface RefListResponse {
    refs: RefItem[];
    total: number;
}

export interface SaveShareToDriveParams {
    token: string;
    /** 分享设置了提取码时必带（错 → 401/403 同既有语义） */
    code?: string;
    /** 保存进的目标文件夹，缺省 = 根目录 */
    targetFolderId?: number | null;
}

export interface SaveShareToDriveResponse {
    saved: number;
    /** folder 分享镜像建立的顶层文件夹 id */
    rootFolderId?: number | null;
}

/** GET /cloud/refs/:id/raw（经原对象 presign；失效 → 404「引用已失效」） */
export interface CloudRefRawResponse {
    url: string;
    viewMode: CloudViewMode;
    mimeType: string;
    fileName: string;
    fileSize: number;
    expiresIn: number;
}

/** 解析 app-cloud 公开端点的 {detail} 错误消息（401=需要/提取码错误 等） */
async function publicShareError(res: Response, fallback: string): Promise<string> {
    try {
        const parsed = JSON.parse(await res.text()) as { detail?: unknown };
        if (typeof parsed.detail === "string" && parsed.detail) return parsed.detail;
    } catch {}
    return fallback;
}

export function formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    if (!Number.isFinite(bytes) || bytes < 0) return "-";
    const k = 1024;
    // TB 必须在表内：SVIP 配额 1 TiB 级别，缺 TB 会显示 "1 undefined"
    const sizes = ["B", "KB", "MB", "GB", "TB", "PB"];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

export const cloudApi = {
    // ── Folders ──
    listFolders: async () => {
        const raw = await request<CloudFolderTreeResponse>("/cloud/folders", {
            headers: getAuthHeaders(),
        });
        return snakeToCamel<CloudFolderTreeResponse>(raw);
    },

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
    listVideos: async (folderId?: number | null, page = 1, pageSize = 50, sort = "created_at", order = "desc") => {
        let url = `/cloud/videos?page=${page}&pageSize=${pageSize}&sort=${sort}&order=${order}`;
        if (folderId != null) url += `&folderId=${folderId}`;
        const raw = await request<CloudVideoListResponse>(url, { headers: getAuthHeaders() });
        return snakeToCamel<CloudVideoListResponse>(raw);
    },

    getVideoDetail: async (uploadUuid: string) => {
        const raw = await request<CloudVideoDetailResponse>(`/cloud/video/${uploadUuid}`, {
            headers: getAuthHeaders(),
        });
        return snakeToCamel<CloudVideoDetailResponse>(raw);
    },

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

    getDocumentPreview: async (
        uploadUuid: string,
        offset: number = 0,
        limit: number = 5000,
    ) => {
        const params = new URLSearchParams({
            offset: String(offset),
            limit: String(limit),
        });
        const raw = await request<CloudDocumentPreviewResponse>(
            `/cloud/video/${uploadUuid}/preview?${params}`,
            { headers: getAuthHeaders() },
        );
        return snakeToCamel<CloudDocumentPreviewResponse>(raw);
    },

    // ── Original file (raw) ──
    getRawFile: async (uploadUuid: string) => {
        const raw = await request<CloudRawFileResponse>(
            `/cloud/video/${uploadUuid}/raw`,
            { headers: getAuthHeaders() },
        );
        return snakeToCamel<CloudRawFileResponse>(raw);
    },

    // ── Quota / Search / Trash / Share (app-cloud) ──
    getQuota: async () => {
        const raw = await request<CloudQuotaResponse>("/cloud/quota", { headers: getAuthHeaders() });
        return snakeToCamel<CloudQuotaResponse>(raw);
    },

    searchFiles: async (q: string) => {
        const raw = await request<{ results: CloudVideoItem[]; total: number }>(
            `/cloud/search?q=${encodeURIComponent(q)}`,
            { headers: getAuthHeaders() },
        );
        return snakeToCamel<{ results: CloudVideoItem[]; total: number }>(raw);
    },

    listTrash: async () => {
        const raw = await request<CloudTrashResponse>("/cloud/trash", { headers: getAuthHeaders() });
        return snakeToCamel<CloudTrashResponse>(raw);
    },

    restoreTrash: (uploadUuid: string) =>
        request<{ restored: boolean }>(`/cloud/trash/${uploadUuid}/restore`, {
            method: "POST",
            headers: getAuthHeaders(),
        }),

    purgeTrashItem: (uploadUuid: string) =>
        request<{ purged: boolean }>(`/cloud/trash/${uploadUuid}`, {
            method: "DELETE",
            headers: getAuthHeaders(),
        }),

    emptyTrash: () =>
        request<{ purged: number }>("/cloud/trash", {
            method: "DELETE",
            headers: getAuthHeaders(),
        }),

    createShare: async (uploadUuid: string, data: CloudShareCreateParams) => {
        // app-cloud 返回 snake_case（share_url/share_token），必须转换，
        // 否则 share-dialog 拿到 undefined 生成无 token 的 /cloud/s/ 链接
        // （已导致 301 循环 + 限流 503）。
        const raw = await request<Record<string, unknown>>(`/cloud/video/${uploadUuid}/share`, {
            method: "POST",
            headers: getAuthHeaders(),
            body: JSON.stringify(data),
        });
        return snakeToCamel<CloudShareView>(raw);
    },

    listShares: async (uploadUuid: string) => {
        const raw = await request<{ shares: CloudShareView[]; total: number }>(
            `/cloud/video/${uploadUuid}/shares`,
            { headers: getAuthHeaders() },
        );
        return snakeToCamel<{ shares: CloudShareView[]; total: number }>(raw);
    },

    revokeShare: (shareId: number) =>
        request<{ revoked: boolean }>(`/cloud/shares/${shareId}`, {
            method: "DELETE",
            headers: getAuthHeaders(),
        }),

    /** 重设提取码（链接与 token 不变，仅换码）—— 解决"忘记提取码" */
    updateShareCode: (shareId: number, code: string) =>
        request<{ updated: boolean }>(`/cloud/shares/${shareId}/code`, {
            method: "PATCH",
            headers: getAuthHeaders(),
            body: JSON.stringify({ code }),
        }),

    // ── Folder share（plan/1.0.16 §4 Owner 面）──
    /** 对文件夹创建分享（合规警告前置：data.legalAck 必须 true，否则 422） */
    createFolderShare: async (folderId: number, data: CloudShareCreateParams) => {
        const raw = await request<Record<string, unknown>>(`/cloud/folders/${folderId}/share`, {
            method: "POST",
            headers: getAuthHeaders(),
            body: JSON.stringify(data),
        });
        return snakeToCamel<CloudShareView>(raw);
    },

    listFolderShares: async (folderId: number) => {
        const raw = await request<{ shares: CloudShareView[]; total: number }>(
            `/cloud/folders/${folderId}/shares`,
            { headers: getAuthHeaders() },
        );
        return snakeToCamel<{ shares: CloudShareView[]; total: number }>(raw);
    },

    // ── cloud_refs 引用面（保存到我的云盘 = 引用，非复制）──
    /** 把公开分享保存为引用（未复制对象、不计配额）。folder 分享 → 镜像建文件夹 + 每文件一行。 */
    saveShareToDrive: async (data: SaveShareToDriveParams) => {
        const raw = await request<SaveShareToDriveResponse>("/cloud/refs", {
            method: "POST",
            headers: getAuthHeaders(),
            body: JSON.stringify(data),
        });
        return snakeToCamel<SaveShareToDriveResponse>(raw);
    },

    /** 当前用户在指定文件夹下的引用列表（folderId 缺省 = 根目录） */
    listRefs: async (folderId?: number | null) => {
        const url = folderId != null ? `/cloud/refs?folderId=${folderId}` : "/cloud/refs";
        const raw = await request<RefListResponse>(url, { headers: getAuthHeaders() });
        return snakeToCamel<RefListResponse>(raw);
    },

    /** 删除引用（uid 校验软删；只动引用，原文件/原文件夹不受影响） */
    deleteRef: (id: number) =>
        request<{ deleted: boolean }>(`/cloud/refs/${id}`, {
            method: "DELETE",
            headers: getAuthHeaders(),
        }),

    /** 引用原对象 presign URL（失效 → 404「引用已失效」；download=1 触发下载 disposition） */
    rawRefFile: async (id: number, download = false) => {
        const raw = await request<CloudRefRawResponse>(
            `/cloud/refs/${id}/raw${download ? "?download=1" : ""}`,
            { headers: getAuthHeaders() },
        );
        return snakeToCamel<CloudRefRawResponse>(raw);
    },

    // ── Public share endpoints（/cloud/s/*，匿名访客）──
    // 必须同源相对路径：分享页访客来自任意域名/IP（链接用 SHARE_DOMAIN 生成），
    // request() 的 API_BASE_URL 是构建期固化的部署地址，远程访客会打到自己
    // 的 localhost。X-Requested-With 让 nginx 把 XHR 分发到 app-cloud。
    getSharedInfo: async (token: string) => {
        const res = await fetch(`/cloud/s/${encodeURIComponent(token)}`, {
            headers: { "X-Requested-With": "XMLHttpRequest" },
        });
        if (!res.ok) {
            throw new Error(await publicShareError(res, "分享不存在或已失效"));
        }
        return (await res.json()) as CloudShareInfoResponse;
    },

    attestShared: async (token: string, body: { challenge: string; fingerprint: string }) => {
        const res = await fetch(`/cloud/s/${encodeURIComponent(token)}/attest`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Requested-With": "XMLHttpRequest",
            },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            throw new Error(await publicShareError(res, "设备证明失败"));
        }
        return (await res.json()) as { ticket: string; expiresIn: number };
    },

    accessShared: async (
        token: string,
        body: { code?: string; download?: boolean },
        attest?: CloudAttestation,
    ) => {
        const res = await fetch(`/cloud/s/${encodeURIComponent(token)}/access`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Requested-With": "XMLHttpRequest",
                // 设备证明票据（attest 签发，绑定 token + 指纹，15 分钟时效）
                ...(attest ? { "X-Fp": attest.fp, "X-Ticket": attest.ticket } : {}),
            },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            throw new Error(await publicShareError(res, "请求失败"));
        }
        return (await res.json()) as CloudShareAccessResponse;
    },

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

        // 2. Upload each chunk to MinIO with real-time byte progress via XHR
        const parts: CloudUploadPart[] = [];
        const heartbeatInterval = setInterval(() => {
            cloudApi.heartbeat(init.sessionUuid).catch(() => {});
        }, 60_000);

        try {
            let totalUploaded = 0;
            for (const chunk of init.presignedUrls) {
                const start = chunk.chunkIndex * init.chunkSize;
                const end = Math.min(start + chunk.chunkSize, file.size);
                const blob = file.slice(start, end);

                await new Promise<void>((resolve, reject) => {
                    const xhr = new XMLHttpRequest();
                    xhr.open("PUT", chunk.url);
                    // Track real-time bytes uploaded within this chunk
                    xhr.upload.onprogress = (e) => {
                        if (e.lengthComputable) {
                            const uploaded = totalUploaded + e.loaded;
                            const pct = Math.round((uploaded / file.size) * 100);
                            onProgress?.(pct);
                        }
                    };
                    xhr.onload = () => {
                        if (xhr.status >= 200 && xhr.status < 300) {
                            const etag = xhr.getResponseHeader("ETag") ?? "";
                            parts.push({ PartNumber: chunk.chunkIndex + 1, ETag: etag });
                            totalUploaded += blob.size;
                            resolve();
                        } else {
                            reject(new Error(`Chunk ${chunk.chunkIndex} upload failed: ${xhr.status}`));
                        }
                    };
                    xhr.onerror = () => reject(new Error(`Chunk ${chunk.chunkIndex} network error`));
                    xhr.ontimeout = () => reject(new Error(`Chunk ${chunk.chunkIndex} timeout`));
                    xhr.send(blob);
                });
            }
        } finally {
            clearInterval(heartbeatInterval);
        }

        // 3. Complete
        return cloudApi.completeUpload(init.uploadUuid, parts);
    },
};
