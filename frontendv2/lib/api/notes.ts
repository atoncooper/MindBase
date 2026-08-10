/**
 * Notes API - 笔记 CRUD / 锚点 / 修订 / 分享（camelCase 响应）.
 */
import { request, requestCamel, getAuthHeaders, API_BASE_URL, snakeToCamel } from "./client";
import { sanitizeError } from "@/lib/error-utils";

export interface NoteMeta {
    uuid: string;
    title: string;
    targetType: "video" | "cloud_file";
    targetId: string;
    contentLength: number;
    isPinned: boolean;
    revisionCount: number;
    createdAt: string;
    updatedAt: string;
}

export interface NoteAnchor {
    id: number;
    blockId: string;
    position: number;
    label?: string;
    createdAt: string;
}

export interface NoteDetail extends NoteMeta {
    contentMd: string;
    anchors: NoteAnchor[];
    shareToken: string | null;
    shareExpiresAt: string | null;
}

export interface NoteCreateParams {
    title?: string;
    targetType: "video" | "cloud_file";
    targetId: string;
    contentMd?: string;
}

export interface NoteUpdateParams {
    title?: string;
    contentMd?: string;
    isPinned?: boolean;
}

export interface NoteShareInfo {
    shareToken: string;
    shareUrl: string;
    expiresAt: string | null;
}

export interface NoteSharedView {
    title: string;
    contentMd: string;
    targetType: string;
    targetId: string;
    sharedAt: string;
    viewCount: number;
}

export interface NoteRevision {
    revisionId: string;
    revisionNote: string | null;
    createdAt: string;
}

export interface NoteListResult {
    items: NoteMeta[];
    total: number;
}

async function fetchNotesList(
    params?: { targetType?: string; targetId?: string; page?: number; pageSize?: number },
): Promise<NoteListResult> {
    const qs = new URLSearchParams();
    if (params?.targetType) qs.set("target_type", params.targetType);
    if (params?.targetId) qs.set("target_id", params.targetId);
    if (params?.page) qs.set("page", String(params.page));
    if (params?.pageSize) qs.set("page_size", String(params.pageSize));
    const q = qs.toString();
    const url = `${API_BASE_URL}/notes${q ? `?${q}` : ""}`;
    const response = await fetch(url, {
        headers: {
            "Content-Type": "application/json",
            // Same dev-proxy signal as request() - lets beforeFiles route
            // GET /notes to the backend instead of the /notes page route.
            "X-Requested-With": "XMLHttpRequest",
            ...getAuthHeaders(),
        },
    });
    if (response.status === 401) {
        if (typeof window !== "undefined") {
            const token = localStorage.getItem("bili_session");
            if (token) {
                localStorage.removeItem("bili_session");
                localStorage.removeItem("bili_user");
                window.dispatchEvent(new Event("auth:unauthorized"));
                throw new Error(sanitizeError({ status: 401 }));
            }
        }
    }
    if (!response.ok) {
        let rawDetail = "";
        try {
            const text = await response.text();
            const parsed = JSON.parse(text);
            rawDetail = typeof parsed.detail === "string" ? parsed.detail : "";
        } catch {}
        throw new Error(sanitizeError({ status: response.status, detail: rawDetail }));
    }
    const items = snakeToCamel<NoteMeta[]>(await response.json());
    const total = Number(response.headers.get("X-Total-Count") ?? "0");
    return { items, total: Number.isFinite(total) ? total : 0 };
}

export const notesApi = {
    list: async (params?: { targetType?: string; targetId?: string; page?: number; pageSize?: number }): Promise<NoteMeta[]> => {
        const r = await fetchNotesList(params);
        return r.items;
    },
    listWithTotal: (params?: { targetType?: string; targetId?: string; page?: number; pageSize?: number }) => {
        return fetchNotesList(params);
    },
    create: (data: NoteCreateParams) =>
        requestCamel<NoteDetail>("/notes", {
            method: "POST",
            body: JSON.stringify({
                title: data.title,
                target_type: data.targetType,
                target_id: data.targetId,
                content_md: data.contentMd,
            }),
        }),
    get: (uuid: string) =>
        requestCamel<NoteDetail>(`/notes/${uuid}`),
    update: (uuid: string, data: NoteUpdateParams, ifMatch?: string) =>
        requestCamel<NoteDetail>(`/notes/${uuid}`, {
            method: "PATCH",
            body: JSON.stringify({
                title: data.title,
                content_md: data.contentMd,
                is_pinned: data.isPinned,
            }),
            headers: ifMatch ? { "If-Match": ifMatch } : undefined,
        }),
    delete: (uuid: string) =>
        request<void>(`/notes/${uuid}`, { method: "DELETE" }),
    addAnchor: (uuid: string, data: { blockId: string; position: number; label?: string }) =>
        requestCamel<NoteAnchor>(`/notes/${uuid}/anchors`, {
            method: "POST",
            body: JSON.stringify({
                block_id: data.blockId,
                position: data.position,
                label: data.label,
            }),
        }),
    deleteAnchor: (uuid: string, anchorId: number) =>
        request<void>(`/notes/${uuid}/anchors/${anchorId}`, { method: "DELETE" }),
    listRevisions: (uuid: string) =>
        requestCamel<NoteRevision[]>(`/notes/${uuid}/revisions`),
    restoreRevision: (uuid: string, revisionId: string) =>
        requestCamel<NoteDetail>(`/notes/${uuid}/revisions/restore/${revisionId}`, { method: "POST" }),
    createShare: (uuid: string, expiresInDays?: number) =>
        requestCamel<NoteShareInfo>(`/notes/${uuid}/share`, {
            method: "POST",
            body: JSON.stringify({ expires_in_days: expiresInDays ?? null }),
        }),
    revokeShare: (uuid: string) =>
        request<void>(`/notes/${uuid}/share`, { method: "DELETE" }),
    getShared: (token: string) =>
        requestCamel<NoteSharedView>(`/notes/shared/${token}`),
};
