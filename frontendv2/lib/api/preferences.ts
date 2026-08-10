/**
 * Preferences / wallpaper API - 用户偏好与壁纸（预设 / 自定义上传）.
 */
import { request, getAuthHeaders, API_BASE_URL } from "./client";
import { sanitizeError } from "@/lib/error-utils";

export interface WallpaperPref {
    source: "preset" | "custom";
    key: string; // preset id, or MinIO object_key for custom
    version: number;
    type?: "image" | "video";
}

export interface PresetWallpaper {
    id: string;
    name: string;
    type?: "image" | "video";
}

export interface Preferences {
    [key: string]: unknown;
    wallpaper?: WallpaperPref;
}

export const preferencesApi = {
    get: () => request<{ preferences: Preferences }>("/preferences"),
    update: (prefs: Record<string, unknown>) =>
        request<{ preferences: Preferences }>("/preferences", {
            method: "PATCH",
            body: JSON.stringify({ preferences: prefs }),
        }),
};

export const wallpaperApi = {
    presets: () => request<{ presets: PresetWallpaper[] }>("/wallpaper/presets"),
    selectPreset: (presetId: string) =>
        request<{ wallpaper: WallpaperPref }>("/wallpaper/preset", {
            method: "POST",
            body: JSON.stringify({ preset_id: presetId }),
        }),
    upload: async (file: File): Promise<{ wallpaper: WallpaperPref }> => {
        const form = new FormData();
        form.append("file", file);
        const resp = await fetch(`${API_BASE_URL}/wallpaper/upload`, {
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
};
