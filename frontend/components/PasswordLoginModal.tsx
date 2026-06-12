"use client";

import { useId, useState } from "react";
import { authApi } from "@/lib/api";
import type { UserInfo } from "@/lib/api";
import { collectDeviceInfo } from "@/lib/device";
import { Button } from "@/components/ui/button";

function GoogleInput({
  id,
  label,
  type,
  value,
  onChange,
  autoComplete,
  autoFocus,
  trailing,
}: {
  id: string;
  label: string;
  type: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  autoFocus?: boolean;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="relative w-full">
      <input
        id={id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder=" "
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        className="peer h-[58px] w-full rounded border border-[#dadce0] bg-white text-base text-[#202124] outline-none transition-colors hover:border-[#5f6368] focus:border-2 focus:border-[#1a73e8] disabled:bg-[#f8fafd]"
        style={{ padding: trailing ? "12px 56px 0 16px" : "12px 16px 0" }}
      />
      <label
        htmlFor={id}
        className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 bg-white text-base text-[#5f6368] transition-all duration-150 peer-focus:left-3 peer-focus:top-0 peer-focus:text-xs peer-focus:font-medium peer-focus:text-[#1a73e8] peer-[:not(:placeholder-shown)]:left-3 peer-[:not(:placeholder-shown)]:top-0 peer-[:not(:placeholder-shown)]:text-xs"
        style={{ padding: "0 4px" }}
      >
        {label}
      </label>
      {trailing && <div className="absolute right-2 top-1/2 -translate-y-1/2">{trailing}</div>}
    </div>
  );
}

function EyeIcon({ open }: { open: boolean }) {
  return open ? (
    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  ) : (
    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" />
    </svg>
  );
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (sessionToken: string, user: UserInfo) => void;
  onSwitchToQR: () => void;
}

export default function PasswordLoginModal({ isOpen, onClose, onSuccess, onSwitchToQR }: Props) {
  const emailId = useId();
  const passwordId = useId();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [error, setError] = useState("");

  const handleLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");

    if (!email.trim()) {
      setError("请输入邮箱地址");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError("请输入有效的邮箱地址");
      return;
    }
    if (!password.trim()) {
      setError("请输入密码");
      return;
    }

    setLoggingIn(true);
    try {
      const device = collectDeviceInfo();
      const res = await authApi.login(email.trim(), password, { ...device });
      onSuccess(res.session_token, res.user_info);
    } catch (err: any) {
      setError(err.message || "登录失败，请检查邮箱和密码");
    } finally {
      setLoggingIn(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-[#202124]/55" style={{ padding: "24px 16px" }} onClick={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="password-login-title"
        className="relative my-auto flex w-[calc(100%-2rem)] max-w-[840px] flex-col overflow-hidden rounded-[20px] bg-white text-[#202124] shadow-[0_12px_36px_rgba(60,64,67,0.30)] md:min-h-[456px] md:flex-row"
        onClick={(event) => event.stopPropagation()}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-lg"
          onClick={onClose}
          aria-label="关闭登录窗口"
          className="absolute right-3 top-3 z-10 h-9 w-9 rounded-full text-[#5f6368] hover:bg-[#f1f3f4] hover:text-[#202124]"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </Button>

        <aside className="flex min-w-0 flex-none flex-col justify-between bg-[#f8fafd] md:w-[48%]" style={{ padding: "44px" }}>
            <div>
              <div className="mb-7 flex h-11 w-11 items-center justify-center rounded-full bg-[#e8f0fe] text-[#1a73e8] shadow-[inset_0_0_0_1px_rgba(26,115,232,0.08)] md:mb-8">
                <span className="text-lg font-medium">M</span>
              </div>
              <p className="mb-3 text-xs font-medium tracking-[0.16em] text-[#1a73e8]">MINDBASE ACCOUNT</p>
              <h1 id="password-login-title" className="max-w-[280px] text-[26px] font-normal leading-[1.22] tracking-[-0.4px] text-[#202124] md:max-w-[280px] md:text-[30px] md:tracking-[-0.6px]">
                登录到你的知识库
              </h1>
            </div>

            <p className="mt-6 max-w-[300px] text-[14px] leading-[1.6] text-[#5f6368] md:mt-10">
              使用邮箱和密码继续访问收藏夹同步、语义检索和聊天记录。
            </p>
        </aside>

        <form onSubmit={handleLogin} noValidate className="flex min-w-0 flex-1 flex-col items-center border-t border-[#e8eaed] md:border-l md:border-t-0">
            <div className="flex w-full max-w-[380px] flex-1 flex-col justify-center" style={{ padding: "36px 32px" }}>
              <div className="grid gap-5">
                <GoogleInput
                  id={emailId}
                  label="电子邮件地址"
                  type="email"
                  value={email}
                  onChange={(value) => {
                    setEmail(value);
                    setError("");
                  }}
                  autoComplete="email"
                  autoFocus
                />

                <GoogleInput
                  id={passwordId}
                  label="输入密码"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(value) => {
                    setPassword(value);
                    setError("");
                  }}
                  autoComplete="current-password"
                  trailing={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-lg"
                      onClick={() => setShowPassword((current) => !current)}
                      aria-label={showPassword ? "隐藏密码" : "显示密码"}
                      className="h-9 w-9 rounded-full text-[#5f6368] hover:bg-[#f1f3f4] hover:text-[#202124]"
                    >
                      <EyeIcon open={showPassword} />
                    </Button>
                  }
                />
              </div>

              <div className="min-h-[44px] pt-3">
                {error && (
                  <div className="flex gap-2 text-sm leading-5 text-[#d93025]" role="alert">
                    <svg className="mt-0.5 h-4 w-4 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M18 10A8 8 0 112 10a8 8 0 0116 0zM9 5a1 1 0 112 0v6a1 1 0 11-2 0V5zm1 10a1.25 1.25 0 100-2.5A1.25 1.25 0 0010 15z" clipRule="evenodd" />
                    </svg>
                    <span>{error}</span>
                  </div>
                )}
              </div>

              <p className="text-[13px] leading-6 text-[#5f6368]">
                还没有密码？请先使用 B 站扫码登录，在账户安全中绑定邮箱并设置密码。
              </p>

              <div className="flex flex-col-reverse items-stretch gap-3 pt-8 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
                <Button
                  type="button"
                  variant="ghost"
                  size="lg"
                  onClick={() => {
                    onClose();
                    onSwitchToQR();
                  }}
                  className="h-10 rounded-full text-[#1a73e8] hover:bg-[#f6fafe] hover:text-[#1a73e8] sm:-ml-3"
                  style={{ padding: "0 16px" }}
                >
                  使用扫码登录
                </Button>
                <Button
                  type="submit"
                  disabled={loggingIn}
                  size="lg"
                  className="h-10 min-w-28 rounded-full bg-[#1a73e8] text-white hover:bg-[#1765cc]"
                  style={{ padding: "0 24px" }}
                >
                  {loggingIn ? (
                    <span className="flex items-center gap-2">
                      <span className="h-4 w-4 rounded-full border-2 border-white/50 border-t-white animate-spin" />
                      登录中
                    </span>
                  ) : (
                    "下一步"
                  )}
                </Button>
              </div>
            </div>
        </form>
      </section>
    </div>
  );
}
