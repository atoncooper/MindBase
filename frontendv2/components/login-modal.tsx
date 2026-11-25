"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";
import { authApi, attestDevice, type QRCodeResponse, type CaptchaValue, type UserInfo, type WeChatQRConfig, type AuthFeatures } from "@/lib/api";
import { CaptchaField } from "@/components/captcha-field";

type Tab = "qr" | "wechat" | "password";
type AccountMode = "password" | "sms";
/** 账号 tab 的三个视图：密码登录 / 短信登录 / 注册 */
type AccountView = AccountMode | "register";
type QRStatus = "loading" | "ready" | "scanned" | "success" | "error";

interface LoginModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (sessionToken: string, user: UserInfo) => void;
  /** 打开时定位到哪个 tab（默认 qr） */
  initialTab?: Tab;
  /** 账号 tab 的初始视图（password / sms / register） */
  initialMode?: AccountView;
}

declare global {
  interface Window {
    WxLogin?: (options: {
      id: string;
      appid: string;
      scope: string;
      redirect_uri: string;
      state: string;
      style?: string;
      href?: string;
      self_redirect?: boolean;
    }) => void;
  }
}

// WeChat official QR-embed script (renders the qrconnect iframe). Loaded
// lazily only when the WeChat tab is opened; cached across modal re-opens.
const WECHAT_QR_CONTAINER_ID = "wechat-login-qr-container";
const WX_LOGIN_JS_URL = "https://res.wx.qq.com/connect/zh_CN/htmledition/js/wxLogin.js";

let wxLoginScriptPromise: Promise<void> | null = null;

function loadWxLoginScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("SSR"));
  if (window.WxLogin) return Promise.resolve();
  if (!wxLoginScriptPromise) {
    wxLoginScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = WX_LOGIN_JS_URL;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        wxLoginScriptPromise = null;
        reject(new Error("wxLogin.js 加载失败"));
      };
      document.head.appendChild(script);
    });
  }
  return wxLoginScriptPromise;
}

const isEmail = (v: string) => v.includes("@");

export function LoginModal({ isOpen, onClose, onSuccess, initialTab, initialMode }: LoginModalProps) {
  const [tab, setTab] = useState<Tab>("qr");
  const [accountView, setAccountView] = useState<AccountView>("password");

  // QR state
  const [qr, setQr] = useState<QRCodeResponse | null>(null);
  const [qrStatus, setQrStatus] = useState<QRStatus>("loading");
  const [polling, setPolling] = useState(false);
  /** real failure reason for the QR panel (load error vs expired) */
  const [qrError, setQrError] = useState("");

  // Account-tab shared state
  const [pwLoading, setPwLoading] = useState(false);
  const [pwError, setPwError] = useState("");
  const [features, setFeatures] = useState<AuthFeatures | null>(null);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [googleError, setGoogleError] = useState("");

  // 密码登录（邮箱或手机号）
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");

  // 短信登录
  const [phone, setPhone] = useState("");
  const [smsCode, setSmsCode] = useState("");
  const [smsSending, setSmsSending] = useState(false);
  const [smsCooldown, setSmsCooldown] = useState(0);

  // 注册（邮箱）
  const [regEmail, setRegEmail] = useState("");
  const [regPassword, setRegPassword] = useState("");
  const [regCode, setRegCode] = useState("");
  const [regSending, setRegSending] = useState(false);
  const [regCooldown, setRegCooldown] = useState(0);

  // Captcha state — bumping captchaKey remounts CaptchaField, fetching a
  // fresh image (each attempt consumes the captcha server-side).
  const [captcha, setCaptcha] = useState<CaptchaValue>({ captcha_id: "", captcha_code: "" });
  const [captchaKey, setCaptchaKey] = useState(0);

  // WeChat state — cfg doubles as the tab-visibility flag (enabled=false →
  // no WeChat tab). Each cfg carries a fresh one-time OAuth state.
  const [wechatCfg, setWechatCfg] = useState<WeChatQRConfig | null>(null);
  const [wxError, setWxError] = useState("");
  const wxCompleting = useRef(false);

  const refreshWeChatCfg = useCallback(async () => {
    try {
      const cfg = await authApi.getWeChatQR();
      setWechatCfg(cfg);
    } catch {
      /* WeChat unavailable — tab stays hidden */
    }
  }, []);

  // Probe WeChat config + feature flags on modal open (any tab) so the
  // tab bar and account sub-modes render once, correctly.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const [cfg, feats] = await Promise.all([
          authApi.getWeChatQR().catch(() => null),
          authApi.getFeatures().catch(() => null),
        ]);
        if (!cancelled) {
          if (cfg) setWechatCfg(cfg);
          if (feats) setFeatures(feats);
        }
      } catch {
        /* probes are best-effort */
      }
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [isOpen]);

  // Apply requested entry view each time the modal opens.
  useEffect(() => {
    if (!isOpen) return;
    const t = setTimeout(() => {
      setTab(initialTab ?? "qr");
      setAccountView(initialMode ?? "password");
    }, 0);
    return () => clearTimeout(t);
  }, [isOpen, initialTab, initialMode]);

  // Verification-code send cooldowns (sms login + email register).
  useEffect(() => {
    if (smsCooldown <= 0 && regCooldown <= 0) return;
    const t = setInterval(() => {
      setSmsCooldown((v) => Math.max(0, v - 1));
      setRegCooldown((v) => Math.max(0, v - 1));
    }, 1000);
    return () => clearInterval(t);
  }, [smsCooldown, regCooldown]);

  const getQR = useCallback(async () => {
    setQrStatus("loading");
    setQrError("");
    try {
      const data = await authApi.getQRCode();
      setQr(data);
      setQrStatus("ready");
      setPolling(true);
    } catch (err) {
      // Show the real reason instead of the misleading "二维码已失效" —
      // the QR never expired; it failed to load (e.g. backend egress down).
      setQrError(err instanceof Error ? err.message : "二维码加载失败，请稍后重试");
      setQrStatus("error");
    }
  }, []);

  useEffect(() => {
    if (!isOpen || tab !== "qr") return;
    const t = setTimeout(getQR, 0);
    return () => clearTimeout(t);
  }, [isOpen, tab, getQR]);

  useEffect(() => {
    if (!isOpen || tab !== "qr" || !polling || !qr) return;
    const timer = setInterval(async () => {
      try {
        const res = await authApi.pollQRCode(qr.qrcode_key);
        if (res.status === "scanned") setQrStatus("scanned");
        else if (res.status === "confirmed") {
          setPolling(false);
          setQrStatus("success");
          const token = res.user_info?.session_token || res.session_id || "";
          setTimeout(() => onSuccess(token, res.user_info!), 500);
        } else if (res.status === "expired") {
          setPolling(false);
          setQrError("二维码已过期，请重新获取");
          setQrStatus("error");
        }
      } catch {
        /* keep polling on transient network errors */
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [isOpen, tab, polling, qr, onSuccess]);

  // Reset on close. The modal stays mounted (returns null when closed), so we
  // clear stale QR/polling state here rather than on each open trigger.
  useEffect(() => {
    if (!isOpen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset transient form state when the modal closes; no cascading renders
      setPolling(false);
      setQr(null);
      setQrStatus("loading");
      setQrError("");
      setPwError("");
      setCaptcha({ captcha_id: "", captcha_code: "" });
      setCaptchaKey((k) => k + 1);
      setWechatCfg(null);
      setWxError("");
      setIdentifier("");
      setPassword("");
      setPhone("");
      setSmsCode("");
      setSmsCooldown(0);
      setRegEmail("");
      setRegPassword("");
      setRegCode("");
      setRegCooldown(0);
    }
  }, [isOpen]);

  // ── 密码登录（邮箱或手机号） ────────────────────────────────────

  const handlePasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwError("");
    setPwLoading(true);
    try {
      const email = isEmail(identifier.trim()) ? identifier.trim() : undefined;
      const res = await authApi.login(
        email,
        password,
        undefined,
        captcha,
        email ? undefined : identifier.trim(),
      );
      onSuccess(res.session_token, res.user_info);
    } catch (err) {
      setPwError(err instanceof Error ? err.message : "登录失败，请重试");
      // Captcha is consumed by every attempt — fetch a fresh one.
      setCaptchaKey((k) => k + 1);
    } finally {
      setPwLoading(false);
    }
  };

  // ── 短信验证码登录（注册登录一体） ──────────────────────────────

  const sendSmsCode = async () => {
    if (!phone.trim() || smsCooldown > 0) return;
    setPwError("");
    setSmsSending(true);
    try {
      // 设备证明（防脚本刷短信）：挑战 → 指纹 → 票据，人类无感
      const attest = await attestDevice("phone_send");
      await authApi.phoneSendCode(
        {
          phone: phone.trim(),
          purpose: "login",
          captcha_id: captcha.captcha_id,
          captcha_code: captcha.captcha_code,
        },
        attest,
      );
      setSmsCooldown(60);
    } catch (err) {
      setPwError(err instanceof Error ? err.message : "发送失败");
      // The captcha was consumed regardless of outcome.
      setCaptchaKey((k) => k + 1);
    } finally {
      setSmsSending(false);
    }
  };

  const handleSmsLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwError("");
    setPwLoading(true);
    try {
      const res = await authApi.phoneLogin({
        phone: phone.trim(),
        code: smsCode.trim(),
        captcha_id: captcha.captcha_id,
        captcha_code: captcha.captcha_code,
      });
      onSuccess(res.session_token, res.user_info);
    } catch (err) {
      setPwError(err instanceof Error ? err.message : "登录失败，请重试");
      setCaptchaKey((k) => k + 1);
    } finally {
      setPwLoading(false);
    }
  };

  // ── 邮箱注册 ────────────────────────────────────────────────────

  const sendRegisterCode = async () => {
    if (!regEmail.trim() || regCooldown > 0) return;
    setPwError("");
    setRegSending(true);
    try {
      // 设备证明（防脚本刷邮件）：挑战 → 指纹 → 票据，人类无感
      const attest = await attestDevice("register_send");
      await authApi.registerSendEmailCode(regEmail.trim(), captcha, attest);
      setRegCooldown(60);
    } catch (err) {
      setPwError(err instanceof Error ? err.message : "发送失败");
      setCaptchaKey((k) => k + 1);
    } finally {
      setRegSending(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwError("");
    setPwLoading(true);
    try {
      const res = await authApi.registerEmail({
        email: regEmail.trim(),
        password: regPassword,
        code: regCode.trim(),
        captcha_id: captcha.captcha_id,
        captcha_code: captcha.captcha_code,
      });
      onSuccess(res.session_token, res.user_info);
    } catch (err) {
      setPwError(err instanceof Error ? err.message : "注册失败，请重试");
      setCaptchaKey((k) => k + 1);
    } finally {
      setPwLoading(false);
    }
  };

  // ── WeChat ─────────────────────────────────────────────────────

  // Render the embedded WeChat QR (iframe) once the tab is active.
  useEffect(() => {
    if (!isOpen || tab !== "wechat" || !wechatCfg?.enabled || wxError) return;
    let cancelled = false;
    void (async () => {
      try {
        await loadWxLoginScript();
        if (cancelled || !wechatCfg || !window.WxLogin) return;
        window.WxLogin({
          self_redirect: true,
          id: WECHAT_QR_CONTAINER_ID,
          appid: wechatCfg.app_id,
          scope: "snsapi_login",
          redirect_uri: wechatCfg.redirect_uri,
          state: wechatCfg.state,
        });
      } catch {
        setWxError("微信登录组件加载失败");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, tab, wechatCfg, wxError]);

  const completeWeChatLogin = useCallback(
    async (code: string, state: string) => {
      if (wxCompleting.current) return;
      wxCompleting.current = true;
      setWxError("");
      try {
        const res = await authApi.wechatLogin(code, state);
        onSuccess(res.session_token, res.user_info);
      } catch (err) {
        setWxError(err instanceof Error ? err.message : "微信登录失败，请重试");
        // The state was consumed — re-issue config (fresh state) so the QR
        // re-renders for another attempt.
        await refreshWeChatCfg();
      } finally {
        wxCompleting.current = false;
      }
    },
    [onSuccess, refreshWeChatCfg],
  );

  // The WxLogin iframe (self_redirect) lands on /oauth/wechat/callback,
  // which postMessages the code/state up to this window.
  useEffect(() => {
    if (!isOpen || tab !== "wechat") return;
    const handler = (ev: MessageEvent) => {
      if (ev.origin !== window.location.origin) return;
      const data = ev.data as { source?: string; code?: string; state?: string } | null;
      if (!data || data.source !== "wechat-callback" || !data.code || !data.state) return;
      void completeWeChatLogin(data.code, data.state);
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [isOpen, tab, completeWeChatLogin]);

  // Google OAuth popup: the callback page posts the resulting session token
  // back to this window. No token is ever placed in the parent URL.
  useEffect(() => {
    if (!isOpen) return;
    const handler = (ev: MessageEvent) => {
      if (ev.origin !== window.location.origin) return;
      const data = ev.data as {
        source?: string;
        sessionToken?: string;
        user?: UserInfo;
        error?: string;
      } | null;
      if (!data || data.source !== "google-callback") return;
      setGoogleLoading(false);
      if (data.error) {
        setGoogleError(data.error);
        return;
      }
      if (data.sessionToken && data.user) {
        onSuccess(data.sessionToken, data.user);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [isOpen, onSuccess]);

  const startGoogleLogin = useCallback(async () => {
    setGoogleError("");
    setGoogleLoading(true);
    try {
      const options = await authApi.googleOptions("login");
      if (!options.enabled || !options.url) {
        setGoogleError("Google 登录尚未配置");
        return;
      }
      const popup = window.open(
        options.url,
        "mindbase-google-oauth",
        "popup=yes,width=520,height=680,resizable=yes,scrollbars=yes",
      );
      if (!popup) {
        setGoogleError("浏览器阻止了登录弹窗，请允许弹窗后重试");
        setGoogleLoading(false);
      }
    } catch (err) {
      setGoogleError(err instanceof Error ? err.message : "Google 登录启动失败");
      setGoogleLoading(false);
    }
  }, []);

  if (!isOpen || typeof document === "undefined") return null;

  const smsEnabled = features?.sms_enabled === true;
  const registerEnabled = features?.email_register_enabled === true;
  /** 密码找回走邮件通道，邮件服务未配置时不显示入口 */
  const emailEnabled = features?.email_register_enabled === true;

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="fixed inset-0 z-[100] flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <div
            className="absolute inset-0 bg-[#202124]/40 backdrop-blur-[3px]"
            onClick={onClose}
          />
          <motion.div
            initial={{ opacity: 0, y: 14, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 14, scale: 0.985 }}
            transition={{ duration: 0.2, ease: [0.28, 0.11, 0.32, 1] }}
            className="g-account relative max-h-[92vh] w-full max-w-[672px] overflow-y-auto rounded-xl border border-[#dadce0] bg-white px-6 py-7 shadow-[0_24px_80px_rgba(32,33,36,0.22)] sm:px-10 sm:py-10"
            style={{ backgroundColor: "#ffffff" }}
          >
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭登录"
              className="absolute right-4 top-4 grid h-8 w-8 place-items-center rounded-full text-[#5f6368] transition-colors hover:bg-[#f1f3f4] hover:text-[#202124] sm:right-5 sm:top-5"
            >
              <X className="h-4 w-4" />
            </button>

            <div className="flex items-center gap-2.5">
              <span className="grid h-8 w-8 place-items-center rounded-full bg-[#0b57d0] text-[15px] font-semibold text-white">
                M
              </span>
              <span className="text-[14px] font-medium text-[#5f6368]">MindBase</span>
            </div>

            <h2 className="mt-6 text-[24px] font-normal leading-8 tracking-[-0.01em] text-[#202124]">
              登录
            </h2>
            <p className="mt-1.5 text-[14px] leading-6 text-[#5f6368]">
              使用您的 MindBase 账号继续
            </p>

            {features?.google_enabled && (
              <>
                <button
                  type="button"
                  onClick={() => void startGoogleLogin()}
                  disabled={googleLoading}
                  className="mt-6 flex h-10 w-full items-center justify-center gap-2.5 rounded-md border border-[#dadce0] bg-white text-[13px] font-medium text-[#3c4043] transition-colors hover:bg-[#f8f9fa] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <GoogleGlyph />
                  <span>{googleLoading ? "正在打开 Google…" : "使用 Google 账号登录"}</span>
                </button>
                {googleError && (
                  <p className="mt-2 text-[12px] leading-5 text-[#d93025]">{googleError}</p>
                )}
                <div className="my-5 flex items-center gap-3">
                  <span className="h-px flex-1 bg-[#e8eaed]" />
                  <span className="text-[11px] text-[#80868b]">或使用其他方式</span>
                  <span className="h-px flex-1 bg-[#e8eaed]" />
                </div>
              </>
            )}

            {/* Google-style tabs: text + active underline, no pill background. */}
            <div className="mt-6 flex gap-6 border-b border-[#e8eaed]">
              {(wechatCfg?.enabled ? (["qr", "wechat", "password"] as const) : (["qr", "password"] as const)).map((t) => {
                const active = tab === t;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTab(t)}
                    className={`relative pb-2.5 text-[13px] transition-colors ${
                      active
                        ? "font-medium text-[#0b57d0] after:absolute after:inset-x-0 after:bottom-[-1px] after:h-[2px] after:rounded-full after:bg-[#0b57d0]"
                        : "text-[#5f6368] hover:text-[#202124]"
                    }`}
                  >
                    {t === "qr" ? "扫码登录" : t === "wechat" ? "微信登录" : "账号登录"}
                  </button>
                );
              })}
            </div>

            {/* QR panel */}
            {tab === "qr" && (
              <div className="mt-7 flex flex-col items-center">
                <div className="grid h-52 w-52 place-items-center overflow-hidden rounded-xl border border-[#dadce0] bg-[#f8f9fa]">
                  {qrStatus === "loading" && (
                    <span className="text-[13px] text-[#5f6368]">加载二维码…</span>
                  )}
                  {qrStatus === "error" && (
                    <div className="flex flex-col items-center gap-3 px-3">
                      <span className="text-center text-[12px] leading-5 text-[#d93025]">
                        {qrError || "二维码已失效"}
                      </span>
                      <button
                        type="button"
                        onClick={getQR}
                        className="h-8 rounded-md border border-[#dadce0] px-3 text-[12px] text-[#0b57d0] transition-colors hover:bg-[#f1f3f4]"
                      >
                        重新获取
                      </button>
                    </div>
                  )}
                  {qr && (qrStatus === "ready" || qrStatus === "scanned" || qrStatus === "success") && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={qr.qrcode_image_base64}
                      alt="登录二维码"
                      className={`h-full w-full object-contain transition-opacity ${
                        qrStatus === "scanned" || qrStatus === "success" ? "opacity-40" : "opacity-100"
                      }`}
                    />
                  )}
                </div>
                <p className="mt-5 text-center text-[13px] leading-5 text-[#5f6368]">
                  {qrStatus === "scanned" && "已扫描，请在手机上确认"}
                  {qrStatus === "success" && "登录成功，正在进入…"}
                  {(qrStatus === "ready" || qrStatus === "loading") && "使用哔哩哔哩 APP 扫描二维码"}
                </p>
              </div>
            )}

            {/* WeChat panel */}
            {tab === "wechat" && (
              <div className="mt-7 flex flex-col items-center">
                <div className="grid h-[220px] w-[220px] place-items-center overflow-hidden rounded-xl border border-[#dadce0] bg-white">
                  {wxError ? (
                    <div className="flex flex-col items-center gap-3 px-4">
                      <span className="text-center text-[12px] leading-5 text-[#d93025]">{wxError}</span>
                      <button
                        type="button"
                        onClick={() => {
                          setWxError("");
                          setWechatCfg(null);
                          void refreshWeChatCfg();
                        }}
                        className="h-8 rounded-md border border-[#dadce0] px-3 text-[12px] text-[#0b57d0] transition-colors hover:bg-[#f1f3f4]"
                      >
                        重新加载
                      </button>
                    </div>
                  ) : (
                    <div id={WECHAT_QR_CONTAINER_ID} className="h-full w-full" />
                  )}
                </div>
                <p className="mt-5 text-center text-[13px] text-[#5f6368]">请使用微信扫一扫</p>
              </div>
            )}

            {/* Account panel */}
            {tab === "password" && accountView !== "register" && (
              <>
                <div className="mt-5 flex gap-5 text-[12px]">
                  <button
                    type="button"
                    onClick={() => setAccountView("password")}
                    className={
                      accountView === "password"
                        ? "font-medium text-[#0b57d0]"
                        : "text-[#5f6368] hover:text-[#202124]"
                    }
                  >
                    密码登录
                  </button>
                  {smsEnabled && (
                    <button
                      type="button"
                      onClick={() => setAccountView("sms")}
                      className={
                        accountView === "sms"
                          ? "font-medium text-[#0b57d0]"
                          : "text-[#5f6368] hover:text-[#202124]"
                      }
                    >
                      短信登录
                    </button>
                  )}
                </div>

                {accountView === "password" ? (
                  <form onSubmit={handlePasswordLogin} className="mt-5 flex flex-col gap-4">
                    <label className="block text-[12px] font-medium text-[#3c4043]">
                      邮箱或手机号
                      <input
                        type="text"
                        className="field mt-1.5 w-full"
                        placeholder="name@example.com"
                        value={identifier}
                        onChange={(e) => setIdentifier(e.target.value)}
                        required
                        autoFocus
                      />
                    </label>
                    <label className="block text-[12px] font-medium text-[#3c4043]">
                      密码
                      <input
                        type="password"
                        className="field mt-1.5 w-full"
                        placeholder="输入密码"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                      />
                    </label>
                    <CaptchaField key={`pwd-${captchaKey}`} onChange={setCaptcha} />
                    {pwError && <p className="text-[12px] leading-5 text-[#d93025]">{pwError}</p>}
                    <button
                      type="submit"
                      disabled={pwLoading}
                      className="mt-1 h-10 w-full rounded-md bg-[#0b57d0] text-[14px] font-medium text-white transition-colors hover:bg-[#0a4cb5] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {pwLoading ? "登录中…" : "登录"}
                    </button>
                  </form>
                ) : (
                  <form onSubmit={handleSmsLogin} className="mt-5 flex flex-col gap-4">
                    <label className="block text-[12px] font-medium text-[#3c4043]">
                      手机号
                      <input
                        type="tel"
                        className="field mt-1.5 w-full"
                        placeholder="+86 138 0000 0000"
                        value={phone}
                        onChange={(e) => setPhone(e.target.value.replace(/[^\d+]/g, ""))}
                        maxLength={14}
                        required
                        autoFocus
                      />
                    </label>
                    <label className="block text-[12px] font-medium text-[#3c4043]">
                      短信验证码
                      <div className="mt-1.5 flex gap-2">
                        <input
                          type="text"
                          className="field min-w-0 flex-1"
                          placeholder="6 位验证码"
                          value={smsCode}
                          onChange={(e) => setSmsCode(e.target.value.replace(/\D/g, ""))}
                          maxLength={6}
                          required
                        />
                        <button
                          type="button"
                          onClick={sendSmsCode}
                          disabled={smsSending || smsCooldown > 0 || !phone.trim()}
                          className="h-10 shrink-0 rounded-md border border-[#dadce0] px-3 text-[12px] text-[#0b57d0] transition-colors hover:bg-[#f1f3f4] disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {smsCooldown > 0 ? `${smsCooldown}s` : smsSending ? "发送中…" : "发送验证码"}
                        </button>
                      </div>
                    </label>
                    <CaptchaField key={`sms-${captchaKey}`} onChange={setCaptcha} />
                    {pwError && <p className="text-[12px] leading-5 text-[#d93025]">{pwError}</p>}
                    <button
                      type="submit"
                      disabled={pwLoading}
                      className="mt-1 h-10 w-full rounded-md bg-[#0b57d0] text-[14px] font-medium text-white transition-colors hover:bg-[#0a4cb5] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {pwLoading ? "登录中…" : "登录 / 注册"}
                    </button>
                  </form>
                )}

                <div className="mt-5 flex flex-col gap-2 text-[12px]">
                  {accountView === "password" && emailEnabled && (
                    <Link
                      href="/forgot-password"
                      className="text-[#0b57d0] hover:underline"
                    >
                      忘记密码？
                    </Link>
                  )}
                  {registerEnabled && (
                    <p className="text-[#5f6368]">
                      没有账号？{" "}
                      <button
                        type="button"
                        onClick={() => {
                          setPwError("");
                          setAccountView("register");
                        }}
                        className="font-medium text-[#0b57d0] hover:underline"
                      >
                        创建账号
                      </button>
                    </p>
                  )}
                </div>
              </>
            )}

            {/* Register view */}
            {tab === "password" && accountView === "register" && (
              <form onSubmit={handleRegister} className="mt-6 flex flex-col gap-4">
                <h3 className="text-[20px] font-normal leading-7 text-[#202124]">创建账号</h3>
                <label className="block text-[12px] font-medium text-[#3c4043]">
                  邮箱
                  <input
                    type="email"
                    className="field mt-1.5 w-full"
                    placeholder="name@example.com"
                    value={regEmail}
                    onChange={(e) => setRegEmail(e.target.value)}
                    required
                    autoFocus
                  />
                </label>
                <label className="block text-[12px] font-medium text-[#3c4043]">
                  密码
                  <input
                    type="password"
                    className="field mt-1.5 w-full"
                    placeholder="8 位以上，含字母和数字"
                    value={regPassword}
                    onChange={(e) => setRegPassword(e.target.value)}
                    required
                  />
                </label>
                <label className="block text-[12px] font-medium text-[#3c4043]">
                  邮箱验证码
                  <div className="mt-1.5 flex gap-2">
                    <input
                      type="text"
                      className="field min-w-0 flex-1"
                      placeholder="6 位验证码"
                      value={regCode}
                      onChange={(e) => setRegCode(e.target.value.replace(/\D/g, ""))}
                      maxLength={6}
                      required
                    />
                    <button
                      type="button"
                      onClick={sendRegisterCode}
                      disabled={regSending || regCooldown > 0 || !regEmail.trim()}
                      className="h-10 shrink-0 rounded-md border border-[#dadce0] px-3 text-[12px] text-[#0b57d0] transition-colors hover:bg-[#f1f3f4] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {regCooldown > 0 ? `${regCooldown}s` : regSending ? "发送中…" : "发送验证码"}
                    </button>
                  </div>
                </label>
                <CaptchaField key={`reg-${captchaKey}`} onChange={setCaptcha} />
                {pwError && <p className="text-[12px] leading-5 text-[#d93025]">{pwError}</p>}
                <button
                  type="submit"
                  disabled={pwLoading}
                  className="mt-1 h-10 w-full rounded-md bg-[#0b57d0] text-[14px] font-medium text-white transition-colors hover:bg-[#0a4cb5] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {pwLoading ? "注册中…" : "创建账号并登录"}
                </button>
                <p className="text-center text-[12px] text-[#5f6368]">
                  已有账号？{" "}
                  <button
                    type="button"
                    onClick={() => {
                      setPwError("");
                      setAccountView("password");
                    }}
                    className="font-medium text-[#0b57d0] hover:underline"
                  >
                    返回登录
                  </button>
                </p>
              </form>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}


/** Google G mark used by the OAuth entry button. */
function GoogleGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8.1 3.2l5.7-5.7C34.1 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20c11 0 19.5-8 19.5-20 0-1.3-.1-2.3-.4-3.5z"/>
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 18.9 12 24 12c3.1 0 5.9 1.2 8.1 3.2l5.7-5.7C34.1 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/>
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.3 35.5 26.8 36 24 36c-5.3 0-9.7-3.3-11.3-8l-6.5 5C9.7 39.7 16.3 44 24 44z"/>
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34.5 44 24c0-1.3-.1-2.3-.4-3.5z"/>
    </svg>
  );
}
