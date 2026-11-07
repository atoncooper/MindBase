/**
 * Preferences API - 用户偏好 KV.
 */
import { request } from "./client";

export interface Preferences {
    [key: string]: unknown;
}

export const preferencesApi = {
    get: () => request<{ preferences: Preferences }>("/preferences"),
    update: (prefs: Record<string, unknown>) =>
        request<{ preferences: Preferences }>("/preferences", {
            method: "PATCH",
            body: JSON.stringify({ preferences: prefs }),
        }),
};
