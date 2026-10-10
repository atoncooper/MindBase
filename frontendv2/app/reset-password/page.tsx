"use client";

/**
 * 重置密码 — 邮件链接落地页（公开页，route-guard 白名单放行）。
 *
 * 邮件中的链接形如 {email.frontend_url}/reset-password?token=...；
 * token 为一次性 32 字节随机串，10 分钟有效，后端核销后即失效。
 * useSearchParams 需要 Suspense 边界（同 /oauth/wechat/callback 页做法）。
 */
import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { userApi } from "@/lib/api";

/** 与后端 validatePasswordStrength 对齐的前置校验（最终以后端为准） */
const passwordOk = (pw: string) => pw.length >= 8 && /[a-zA-Z]/.test(pw) && /\d/.test(pw);

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-[400px] rounded-[18px] border border-border bg-surface p-7 shadow-[0_20px_60px_rgba(0,0,0,0.18)]">
        {children}
      </div>
    </div>
  );
}

function FooterLink({ href, label, prefix }: { href: string; label: string; prefix?: string }) {
  return (
    <p className="mt-5 text-center text-[12px] text-tertiary">
      {prefix}{" "}
      <Link href={href} className="text-foreground underline underline-offset-2 hover:text-primary">
        {label}
      </Link>
    </p>
  );
}

/** token 缺失 / 已失效时的兜底视图 */
function InvalidView({ reason }: { reason: string }) {
  return (
    <Card>
      <h1 className="text-[22px] font-semibold tracking-tight text-foreground">链接已失效</h1>
      <p className="mt-1 text-[13px] text-secondary">{reason}重置链接为一次性且 10 分钟内有效，请重新申请。</p>
      <Link
        href="/forgot-password"
        className="btn-pill btn-primary mt-6 grid h-10 place-items-center text-[14px]"
      >
        重新申请
      </Link>
      <FooterLink href="/" label="返回登录" prefix="想起密码了？" />
    </Card>
  );
}

function ResetPasswordInner() {
  const params = useSearchParams();
  const token = (params.get("token") ?? "").trim();

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  if (!token) {
    return <InvalidView reason="缺少重置令牌。" />;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!passwordOk(password)) {
      setError("密码至少 8 位，且必须同时包含字母和数字");
      return;
    }
    if (password !== confirm) {
      setError("两次输入的密码不一致");
      return;
    }
    setLoading(true);
    try {
      await userApi.confirmPasswordReset({
        reset_token: token,
        new_password: password,
      });
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "重置失败，请稍后重试");
    } finally {
      setLoading(false);
    }
  };

  if (done) {
    return (
      <Card>
        <h1 className="text-[22px] font-semibold tracking-tight text-foreground">密码已重置</h1>
        <p className="mt-1 text-[13px] text-secondary">请使用新密码重新登录。</p>
        <Link
          href="/"
          className="btn-pill btn-primary mt-6 grid h-10 place-items-center text-[14px]"
        >
          去登录
        </Link>
      </Card>
    );
  }

  return (
    <Card>
      <h1 className="text-[22px] font-semibold tracking-tight text-foreground">设置新密码</h1>
      <p className="mt-1 text-[13px] text-secondary">为新密码设置至少 8 位、包含字母和数字的组合</p>
      <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-3">
        <input
          type="password"
          className="field"
          placeholder="新密码（8 位以上，含字母和数字）"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoFocus
        />
        <input
          type="password"
          className="field"
          placeholder="确认新密码"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
        />
        {error && <p className="text-[12px] text-danger">{error}</p>}
        <button
          type="submit"
          disabled={loading}
          className="btn-pill btn-primary mt-1 h-10 text-[14px]"
        >
          {loading ? "提交中…" : "重置密码"}
        </button>
      </form>
      <FooterLink href="/forgot-password" label="重新申请" prefix="链接失效了？" />
      <FooterLink href="/" label="返回登录" />
    </Card>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordInner />
    </Suspense>
  );
}
