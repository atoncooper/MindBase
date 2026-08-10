/**
 * Favorites API - 收藏夹 v2 (Bearer token, uid-based) + deprecated v1.
 */
import { request, getAuthHeaders } from "./client";

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
// 收藏夹 v1 (deprecated - use favoritesV2Api instead)
// ══════════════════════════════════════════════════════════════

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
