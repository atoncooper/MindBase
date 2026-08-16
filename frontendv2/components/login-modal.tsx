"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";
import { authApi, type QRCodeResponse, type CaptchaValue, type UserInfo, type WeChatQRConfig, type AuthFeatures } from "@/lib/api";
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

  // Account-tab shared state
  const [pwLoading, setPwLoading] = useState(false);
  const [pwError, setPwError] = useState("");
  const [features, setFeatures] = useState<AuthFeatures | null>(null);

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
    try {
      const data = await authApi.getQRCode();
      setQr(data);
      setQrStatus("ready");
      setPolling(true);
    } catch {
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
      await authApi.phoneSendCode({
        phone: phone.trim(),
        purpose: "login",
        captcha_id: captcha.captcha_id,
        captcha_code: captcha.captcha_code,
      });
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
      await authApi.registerSendEmailCode(regEmail.trim(), captcha);
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

  if (!isOpen || typeof document === "undefined") return null;

  const smsEnabled = features?.sms_enabled === true;
  const registerEnabled = features?.email_register_enabled === true;

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
            className="absolute inset-0 bg-black/30 backdrop-blur-sm"
            onClick={onClose}
          />
          <motion.div
            initial={{ opacity: 0, y: 16, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.97 }}
            transition={{ duration: 0.22, ease: [0.28, 0.11, 0.32, 1] }}
            className="relative max-h-[92vh] w-full max-w-[400px] overflow-y-auto rounded-[18px] border border-border bg-surface p-7 shadow-[0_20px_60px_rgba(0,0,0,0.18)]"
          >
            <button
              onClick={onClose}
              className="absolute right-4 top-4 grid h-7 w-7 place-items-center rounded-full text-secondary transition-colors hover:bg-border-subtle hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>

            <h2 className="text-[22px] font-semibold tracking-tight text-foreground">登录 MindBase</h2>
            <p className="mt-1 text-[13px] text-secondary">把收藏变成可对话的知识</p>

            {/* Tabs */}
            <div className="mt-6 flex gap-1 rounded-full bg-border-subtle p-1">
              {(wechatCfg?.enabled ? (["qr", "wechat", "password"] as const) : (["qr", "password"] as const)).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`flex-1 rounded-full py-1.5 text-[13px] font-medium transition-colors ${
                    tab === t ? "bg-surface text-foreground shadow-sm" : "text-secondary hover:text-foreground"
                  }`}
                >
                  {t === "qr" ? "扫码登录" : t === "wechat" ? "微信登录" : "账号登录"}
                </button>
              ))}
            </div>

            {/* QR panel */}
            {tab === "qr" && (
              <div className="mt-6 flex flex-col items-center">
                <div className="grid h-44 w-44 place-items-center overflow-hidden rounded-2xl border border-border bg-background">
                  {qrStatus === "loading" && (
                    <span className="text-[13px] text-secondary">加载二维码…</span>
                  )}
                  {qrStatus === "error" && (
                    <div className="flex flex-col items-center gap-3">
                      <span className="text-[13px] text-danger">二维码已失效</span>
                      <button onClick={getQR} className="btn-pill btn-ghost h-8 px-4 text-[12px]">
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
                <p className="mt-4 text-[13px] text-secondary">
                  {qrStatus === "scanned" && "已扫描，请在手机上确认"}
                  {qrStatus === "success" && "登录成功，正在进入…"}
                  {(qrStatus === "ready" || qrStatus === "loading") && "使用哔哩哔哩 APP 扫描二维码"}
                </p>
              </div>
            )}

            {/* WeChat panel — qrconnect iframe via official wxLogin.js */}
            {tab === "wechat" && (
              <div className="mt-6 flex flex-col items-center">
                <div className="grid h-[220px] w-[220px] place-items-center overflow-hidden rounded-2xl border border-border bg-white">
                  {wxError ? (
                    <div className="flex flex-col items-center gap-3">
                      <span className="px-4 text-center text-[13px] text-danger">{wxError}</span>
                      <button
                        onClick={() => {
                          setWxError("");
                          setWechatCfg(null);
                          void refreshWeChatCfg();
                        }}
                        className="btn-pill btn-ghost h-8 px-4 text-[12px]"
                      >
                        重新加载
                      </button>
                    </div>
                  ) : (
                    <div id={WECHAT_QR_CONTAINER_ID} className="h-full w-full" />
                  )}
                </div>
                <p className="mt-4 text-[13px] text-secondary">请使用微信扫一扫</p>
              </div>
            )}

            {/* Account panel — 密码 / 短信 / 注册 */}
            {tab === "password" && accountView !== "register" && (
              <>
                {/* Sub-mode toggle */}
                <div className="mt-6 flex gap-1 rounded-full bg-border-subtle p-1">
                  <button
                    onClick={() => setAccountView("password")}
                    className={`flex-1 rounded-full py-1.5 text-[13px] font-medium transition-colors ${
                      accountView === "password"
                        ? "bg-surface text-foreground shadow-sm"
                        : "text-secondary hover:text-foreground"
                    }`}
                  >
                    密码登录
                  </button>
                  {smsEnabled && (
                    <button
                      onClick={() => setAccountView("sms")}
                      className={`flex-1 rounded-full py-1.5 text-[13px] font-medium transition-colors ${
                        accountView === "sms"
                          ? "bg-surface text-foreground shadow-sm"
                          : "text-secondary hover:text-foreground"
                      }`}
                    >
                      短信登录
                    </button>
                  )}
                </div>

                {accountView === "password" ? (
                  <form onSubmit={handlePasswordLogin} className="mt-4 flex flex-col gap-3">
                    <input
                      type="text"
                      className="field"
                      placeholder="邮箱或手机号"
                      value={identifier}
                      onChange={(e) => setIdentifier(e.target.value)}
                      required
                      autoFocus
                    />
                    <input
                      type="password"
                      className="field"
                      placeholder="密码"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                    />
                    <CaptchaField key={`pwd-${captchaKey}`} onChange={setCaptcha} />
                    {pwError && <p className="text-[12px] text-danger">{pwError}</p>}
                    <button
                      type="submit"
                      disabled={pwLoading}
                      className="btn-pill btn-primary mt-1 h-10 text-[14px]"
                    >
                      {pwLoading ? "登录中…" : "登录"}
                    </button>
                  </form>
                ) : (
                  <form onSubmit={handleSmsLogin} className="mt-4 flex flex-col gap-3">
                    <input
                      type="tel"
                      className="field"
                      placeholder="手机号"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value.replace(/[^\d+]/g, ""))}
                      maxLength={14}
                      required
                      autoFocus
                    />
                    <div className="flex gap-2">
                      <input
                        type="text"
                        className="field"
                        placeholder="短信验证码"
                        value={smsCode}
                        onChange={(e) => setSmsCode(e.target.value.replace(/\D/g, ""))}
                        maxLength={6}
                        required
                      />
                      <button
                        type="button"
                        onClick={sendSmsCode}
                        disabled={smsSending || smsCooldown > 0 || !phone.trim()}
                        className="inline-flex h-12 shrink-0 items-center rounded-[var(--radius)] border border-border px-3 text-[12px] text-secondary transition-colors hover:bg-border-subtle disabled:opacity-40"
                      >
                        {smsCooldown > 0 ? `${smsCooldown}s` : smsSending ? "发送中…" : "发送验证码"}
                      </button>
                    </div>
                    <CaptchaField key={`sms-${captchaKey}`} onChange={setCaptcha} />
                    {pwError && <p className="text-[12px] text-danger">{pwError}</p>}
                    <button
                      type="submit"
                      disabled={pwLoading}
                      className="btn-pill btn-primary mt-1 h-10 text-[14px]"
                    >
                      {pwLoading ? "登录中…" : "登录 / 注册"}
                    </button>
                  </form>
                )}

                {registerEnabled && (
                  <p className="mt-3 text-center text-[12px] text-tertiary">
                    没有账号？{" "}
                    <button
                      type="button"
                      onClick={() => {
                        setPwError("");
                        setAccountView("register");
                      }}
                      className="text-foreground underline underline-offset-2 hover:text-primary"
                    >
                      邮箱注册
                    </button>
                  </p>
                )}
              </>
            )}

            {/* Register view */}
            {tab === "password" && accountView === "register" && (
              <form onSubmit={handleRegister} className="mt-6 flex flex-col gap-3">
                <input
                  type="email"
                  className="field"
                  placeholder="邮箱"
                  value={regEmail}
                  onChange={(e) => setRegEmail(e.target.value)}
                  required
                  autoFocus
                />
                <input
                  type="password"
                  className="field"
                  placeholder="设置密码（8 位以上，含字母和数字）"
                  value={regPassword}
                  onChange={(e) => setRegPassword(e.target.value)}
                  required
                />
                <div className="flex gap-2">
                  <input
                    type="text"
                    className="field"
                    placeholder="邮箱验证码"
                    value={regCode}
                    onChange={(e) => setRegCode(e.target.value.replace(/\D/g, ""))}
                    maxLength={6}
                    required
                  />
                  <button
                    type="button"
                    onClick={sendRegisterCode}
                    disabled={regSending || regCooldown > 0 || !regEmail.trim()}
                    className="inline-flex h-12 shrink-0 items-center rounded-[var(--radius)] border border-border px-3 text-[12px] text-secondary transition-colors hover:bg-border-subtle disabled:opacity-40"
                  >
                    {regCooldown > 0 ? `${regCooldown}s` : regSending ? "发送中…" : "发送验证码"}
                  </button>
                </div>
                <CaptchaField key={`reg-${captchaKey}`} onChange={setCaptcha} />
                {pwError && <p className="text-[12px] text-danger">{pwError}</p>}
                <button
                  type="submit"
                  disabled={pwLoading}
                  className="btn-pill btn-primary mt-1 h-10 text-[14px]"
                >
                  {pwLoading ? "注册中…" : "注册并登录"}
                </button>
                <p className="text-center text-[12px] text-tertiary">
                  已有账号？{" "}
                  <button
                    type="button"
                    onClick={() => {
                      setPwError("");
                      setAccountView("password");
                    }}
                    className="text-foreground underline underline-offset-2 hover:text-primary"
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
