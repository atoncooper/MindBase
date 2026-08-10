/**
 * Auth API - B站扫码 / 邮箱密码登录 / token 管理.
 */
import { request, requireAuthHeaders } from "./client";

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
    nickname?: string | null;
    face?: string;
    avatar?: string | null;
    level?: number;
    roles?: string[];
    session_token?: string;
    /** @deprecated Legacy compat */
    session_id?: string;
}

export const authApi = {
    // 获取登录二维码
    getQRCode: () => request<QRCodeResponse>("/auth/qrcode"),

    // 轮询登录状态
    pollQRCode: (qrcodeKey: string) =>
        request<LoginStatusResponse>(`/auth/qrcode/poll/${qrcodeKey}`),

    // 已登录用户扫码绑定/刷新 B站授权
    pollQRCodeForBinding: (qrcodeKey: string) =>
        request<LoginStatusResponse>(`/auth/qrcode/poll/${qrcodeKey}?purpose=bind`, {
            headers: requireAuthHeaders(),
        }),

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
