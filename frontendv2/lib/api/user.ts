/**
 * User API - 个人资料 / 安全概览 / 密码 / 邮箱 / 手机 / 找回密码.
 */
import { request, getAuthHeaders } from "./client";

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

export interface BilibiliBindingStatus {
    bound: boolean;
    valid: boolean;
    mid: number | null;
    nickname: string | null;
    avatar: string | null;
    message: string;
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
    bilibili: BilibiliBindingStatus;
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
    /** 首次设置密码强制二次验证：已验证邮箱时必填 */
    email_code?: string;
    /** 仅有已验证手机时必填 */
    sms_code?: string;
}

export interface PasswordChangeParams {
    old_password: string;
    new_password: string;
    email_code?: string;
}

export interface EmailBindParams {
    email: string;
}

export interface EmailSendCodeParams {
    email: string;
    purpose: "bind_email" | "twofa";
    captcha_id?: string;
    captcha_code?: string;
}

export interface EmailVerifyParams {
    email: string;
    code: string;
    purpose: "bind_email" | "twofa";
}

export interface PasswordResetRequestParams {
    email: string;
    captcha_id?: string;
    captcha_code?: string;
}

export interface PasswordResetConfirmParams {
    reset_token: string;
    new_password: string;
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

    sendEmailCode: (data: EmailSendCodeParams) =>
        request<{ message: string }>("/auth/email/send-code", {
            method: "POST",
            headers: getAuthHeaders(),
            body: JSON.stringify(data),
        }),

    verifyEmail: (data: EmailVerifyParams) =>
        request<{ message: string; email: string; purpose: string }>("/auth/email/verify", {
            method: "POST",
            headers: getAuthHeaders(),
            body: JSON.stringify(data),
        }),

    requestPasswordReset: (data: PasswordResetRequestParams) =>
        request<{ message: string }>("/auth/password/reset-request", {
            method: "POST",
            body: JSON.stringify(data),
        }),

    confirmPasswordReset: (data: PasswordResetConfirmParams) =>
        request<{ message: string }>("/auth/password/reset", {
            method: "POST",
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

    // 短信验证码验证并绑定手机号（需先 phoneSendCode purpose=bind 发码）
    verifyPhone: (data: { phone: string; code: string }) =>
        request<{ message: string; phone: string }>("/auth/phone/verify", {
            method: "POST",
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
