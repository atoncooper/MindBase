/**
 * Workspace API - Plan 0023 工作区（绑定收藏夹/文件，聚合成检索范围）.
 */
import { request } from "./client";

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
