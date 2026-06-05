"use client";

import { useState } from "react";
import { authApi } from "@/lib/api";
import type { UserInfo } from "@/lib/api";
import { collectDeviceInfo } from "@/lib/device";

/* ───────────────────────────────────────────────────────────────
   Sub-components
   ─────────────────────────────────────────────────────────────── */

function FloatingInput({
  label,
  type,
  value,
  onChange,
  icon,
  autoComplete,
  autoFocus,
  suffix,
}: {
  label: string;
  type: string;
  value: string;
  onChange: (v: string) => void;
  icon: React.ReactNode;
  autoComplete?: string;
  autoFocus?: boolean;
  suffix?: React.ReactNode;
}) {
  const [focused, setFocused] = useState(false);
  const active = focused || !!value;

  return (
    <div className="relative group">
      {/* Track */}
      <div
        className={`absolute inset-0 rounded-xl border-2 pointer-events-none transition-all duration-300
          ${active ? "border-[var(--accent)] shadow-[0_0_0_4px_var(--accent-alpha)]" : "border-[var(--border)] group-hover:border-[var(--border-hover)]"}
        `}
      />

      {/* Icon — pinned top-left when active, centered otherwise */}
      <div
        className={`absolute left-3.5 transition-all duration-300 z-10
          ${active ? "top-2.5 w-3.5 h-3.5 text-[var(--accent)]" : "top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--muted-foreground)]"}
        `}
      >
        {icon}
      </div>

      {/* Label — float on active */}
      <span
        className={`absolute left-10 transition-all duration-300 pointer-events-none select-none z-10
          ${active
            ? "top-1.5 text-[10px] font-semibold tracking-wider uppercase text-[var(--accent)]"
            : "top-1/2 -translate-y-1/2 text-sm text-[var(--muted-foreground)]"
          }`}
      >
        {label}
      </span>

      {/* Input */}
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder=" "
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        className="relative w-full pl-10 pr-12 pt-5 pb-2 bg-transparent text-sm text-[var(--foreground)]
                   outline-none rounded-xl z-20"
      />

      {/* Suffix (e.g. show/hide password) */}
      {suffix && (
        <div className={`absolute right-3 z-10 transition-all duration-300
          ${active ? "top-2.5" : "top-1/2 -translate-y-1/2"}`}
        >
          {suffix}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────────────────────────────────────────────
   Icons (extracted for reuse / readability)
   ─────────────────────────────────────────────────────────────── */

function MailIcon() {
  return (
    <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" className="w-full h-full">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
        d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" className="w-full h-full">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
        d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
    </svg>
  );
}

function EyeIcon({ open }: { open: boolean }) {
  if (open) {
    return (
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
          d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
          d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    );
  }
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
        d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" />
    </svg>
  );
}

/* ───────────────────────────────────────────────────────────────
   Props
   ─────────────────────────────────────────────────────────────── */

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (sessionToken: string, user: UserInfo) => void;
  onSwitchToQR: () => void;
}

/* ───────────────────────────────────────────────────────────────
   Main component
   ─────────────────────────────────────────────────────────────── */

export default function PasswordLoginModal({ isOpen, onClose, onSuccess, onSwitchToQR }: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [error, setError] = useState("");

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!email.trim()) { setError("请输入邮箱地址"); return; }
    if (!password.trim()) { setError("请输入密码"); return; }

    setLoggingIn(true);
    try {
      const device = collectDeviceInfo();
      const res = await authApi.login(email, password, { ...device });
      const token = res.user_info.session_token || res.session_token;
      onSuccess(token, res.user_info);
    } catch (err: any) {
      setError(err.message || "登录失败，请检查邮箱和密码");
    } finally {
      setLoggingIn(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>

        {/* ── Brand ── */}
        <div className="flex items-center gap-2 mb-8">
          <span className="text-xl font-bold tracking-tight text-[var(--accent)]">MindBase</span>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-[var(--accent)]/10 text-[var(--accent)] border border-[var(--accent)]/20 font-semibold tracking-wider uppercase">
            Account
          </span>
        </div>

        {/* ── Heading ── */}
        <h2 className="text-xl font-bold text-[var(--foreground)] mb-2">欢迎回来</h2>
        <p className="text-sm text-[var(--muted-foreground)] mb-8">
          输入邮箱和密码登录您的账号
        </p>

        {/* ── Form ── */}
        <form onSubmit={handleLogin}>
          <div className="space-y-6">
            <FloatingInput
              label="邮箱地址"
              type="email"
              value={email}
              onChange={(v) => { setEmail(v); setError(""); }}
              icon={<MailIcon />}
              autoComplete="email"
              autoFocus
            />

            <FloatingInput
              label="密码"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(v) => { setPassword(v); setError(""); }}
              icon={<LockIcon />}
              autoComplete="current-password"
              suffix={
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
                  tabIndex={-1}
                >
                  <EyeIcon open={showPassword} />
                </button>
              }
            />
          </div>

          {/* ── Error ── */}
          {error && (
            <div className="mt-5 flex items-center gap-2.5 px-4 py-3 rounded-xl bg-red-500/8 border border-red-500/15 text-red-400 text-xs">
              <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
              </svg>
              <span>{error}</span>
            </div>
          )}

          {/* ── Submit ── */}
          <button
            type="submit"
            disabled={loggingIn}
            className="mt-6 w-full py-3 rounded-xl bg-[var(--accent)] text-white text-sm font-semibold
                       hover:brightness-110 active:brightness-95 disabled:opacity-50
                       transition-all duration-200 flex items-center justify-center gap-2
                       shadow-lg shadow-[var(--accent)]/25"
          >
            {loggingIn ? (
              <>
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                登录中...
              </>
            ) : (
              "登录"
            )}
          </button>
        </form>

        {/* ── Footer ── */}
        <div className="mt-8 pt-5 border-t border-[var(--border)]">
          <p className="text-xs text-[var(--muted-foreground)] text-center">
            还没有账号？
            <button
              onClick={() => { onClose(); onSwitchToQR(); }}
              className="ml-1 text-[var(--accent)] hover:underline font-medium transition-colors"
            >
              扫码登录并绑定邮箱
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}
