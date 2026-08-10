/**
 * Skills API - 技能商店：已装技能 / 上传安装 / 卸载 / 商店列表 / 预览.
 */
import { request, getAuthHeaders, API_BASE_URL } from "./client";
import { sanitizeError } from "@/lib/error-utils";

export interface InstalledSkill {
    skill_id: string;
    name: string;
    description: string | null;
    version: string | null;
    source_store: string | null;
    has_code_tools: boolean;
    enabled: boolean;
}

export interface StoreRepo {
    full_name: string;
    description: string;
    stargazers_count: number;
    default_branch: string;
    html_url: string;
}

export interface RepoEntry {
    name: string;
    type: string; // "dir" | "file"
    path: string;
    size: number;
}

export interface RepoContents {
    type: "dir" | "file";
    entries?: RepoEntry[];
    name?: string;
    path?: string;
    content?: string;
}

export interface SkillPreviewFile {
    name: string;
    path: string;
    size: number;
}

export interface SkillPreview {
    skill_id: string;
    name: string;
    description: string | null;
    version: string | null;
    has_code_tools: boolean;
    body: string;
    manifest: Record<string, unknown>;
    files: SkillPreviewFile[];
}

export const skillsApi = {
    listInstalled: () =>
        request<InstalledSkill[]>("/skills/installed", {
            headers: getAuthHeaders(),
        }),
    uploadInstall: async (file: File): Promise<InstalledSkill> => {
        const form = new FormData();
        form.append("file", file);
        const resp = await fetch(`${API_BASE_URL}/skills/install`, {
            method: "POST",
            headers: getAuthHeaders(),
            body: form,
        });
        if (!resp.ok) {
            let detail = "";
            try {
                detail = (await resp.json()).detail ?? "";
            } catch {}
            throw new Error(sanitizeError({ status: resp.status, detail }));
        }
        return resp.json();
    },
    uninstall: (skillId: string) =>
        request<{ deleted: string }>(`/skills/${encodeURIComponent(skillId)}`, {
            method: "DELETE",
            headers: getAuthHeaders(),
        }),
    storeList: (q?: string) =>
        request<StoreRepo[]>(
            `/skills/store/list${q ? `?q=${encodeURIComponent(q)}` : ""}`,
            { headers: getAuthHeaders() },
        ),
    storeInstall: (repo: string, branch: string = "main") =>
        request<InstalledSkill>("/skills/store/install", {
            method: "POST",
            headers: getAuthHeaders(),
            body: JSON.stringify({ repo, branch }),
        }),
    storeContents: (repo: string, path: string = "", branch: string = "main") =>
        request<RepoContents>(
            `/skills/store/contents?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}&branch=${encodeURIComponent(branch)}`,
            { headers: getAuthHeaders() },
        ),
    preview: (skillId: string) =>
        request<SkillPreview>(`/skills/${encodeURIComponent(skillId)}/preview`, {
            headers: getAuthHeaders(),
        }),
};
