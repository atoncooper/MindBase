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

export function formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
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
