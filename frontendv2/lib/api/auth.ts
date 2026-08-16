/**
 * Auth API - B站扫码 / 邮箱密码登录 / token 管理.
 */
import { request, requireAuthHeaders } from "./client";

export interface QRCodeResponse {
    qrcode_key: string;
    qrcode_url: string;
    qrcode_image_base64: string;
}

export interface CaptchaResponse {
    captcha_id: string;
    /** data URL ("data:image/png;base64,..."), direct <img src> use */
    image_base64: string;
    /** seconds until the captcha expires */
    expires_in: number;
    /** false → captcha gate degraded (feature off / Redis down), hide the input */
    required: boolean;
}

export interface CaptchaValue {
    captcha_id: string;
    captcha_code: string;
}

export interface WeChatQRConfig {
    /** false → WeChat login not configured (frontend hides the tab) */
    enabled: boolean;
    app_id: string;
    redirect_uri: string;
    /** one-time OAuth state (CSRF guard), consumed by POST /auth/wechat/login */
    state: string;
}

export interface AuthFeatures {
    /** email self-registration available (email service configured) */
    email_register_enabled: boolean;
    /** phone SMS-code login/register available (SMS provider configured) */
    sms_enabled: boolean;
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

    // 获取图形验证码（登录 / 发送邮箱验证码前的人机校验）
    getCaptcha: () => request<CaptchaResponse>("/auth/captcha"),

    // 邮箱密码登录（captcha 为图形验证码，服务端一次性消费）
    // 登录/注册能力探测（未配置渠道的入口据此隐藏）
    getFeatures: () => request<AuthFeatures>("/auth/features"),

    // 邮箱或手机号 + 密码登录（email/phone 二选一）
    login: (
        email: string | undefined,
        password: string,
        device?: Record<string, string | undefined>,
        captcha?: CaptchaValue,
        phone?: string,
    ) =>
        request<TokenResponse>("/auth/login", {
            method: "POST",
            body: JSON.stringify({
                email,
                phone,
                password,
                device,
                captcha_id: captcha?.captcha_id,
                captcha_code: captcha?.captcha_code,
            }),
        }),

    // 发送邮箱注册验证码（图形验证码门禁）
    registerSendEmailCode: (email: string, captcha: CaptchaValue) =>
        request<{ message: string }>("/auth/register/email/send-code", {
            method: "POST",
            body: JSON.stringify({
                email,
                captcha_id: captcha.captcha_id,
                captcha_code: captcha.captcha_code,
            }),
        }),

    // 邮箱注册（验证码验证所有权）→ 注册即登录
    registerEmail: (data: { email: string; password: string; code: string } & CaptchaValue) =>
        request<TokenResponse>("/auth/register/email", {
            method: "POST",
            body: JSON.stringify(data),
        }),

    // 发送短信验证码（login 公开 / bind、twofa 需登录态，图形验证码门禁）
    phoneSendCode: (
        data: { phone: string; purpose: "login" | "bind" | "twofa" } & CaptchaValue,
    ) =>
        request<{ message: string }>("/auth/phone/send-code", {
            method: "POST",
            body: JSON.stringify(data),
        }),

    // 手机号验证码登录（首次自动注册，注册登录一体）
    phoneLogin: (data: { phone: string; code: string } & CaptchaValue) =>
        request<TokenResponse>("/auth/phone/login", {
            method: "POST",
            body: JSON.stringify(data),
        }),

    // 获取微信扫码登录参数（wxLogin.js 初始化 + 一次性 state）
    // enabled=false 时前端隐藏微信登录 tab
    getWeChatQR: (purpose?: "bind") =>
        request<WeChatQRConfig>(`/auth/wechat/qrcode${purpose ? "?purpose=bind" : ""}`),

    // 微信扫码登录（注册）：code+state 换会话 token（state 一次性消费）
    wechatLogin: (code: string, state: string) =>
        request<TokenResponse>("/auth/wechat/login", {
            method: "POST",
            body: JSON.stringify({ code, state }),
        }),

    // 将微信账号绑定到当前登录用户（设置页预留，当前未接线）
    wechatBind: (code: string, state: string) =>
        request<{ message: string }>("/auth/wechat/bind", {
            method: "POST",
            headers: requireAuthHeaders(),
            body: JSON.stringify({ code, state }),
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
