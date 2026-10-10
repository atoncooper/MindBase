"use client";

/**
 * 忘记密码 — 请求发送密码重置邮件（公开页，route-guard 白名单放行）。
 *
 * 链路：本页（邮箱 + 图形验证码）→ POST /auth/password/reset-request →
 * Resend 发送重置邮件（一次性链接，10 分钟有效）→ 用户点击邮件中的
 * 链接进入 /reset-password?token=... 完成重置。
 *
 * 后端不区分邮箱是否存在（防账号枚举），统一返回成功语义 message；
 * 图形验证码一次性消费，每次提交后 bump key 重挂载刷新（与登录弹窗一致）。
 * 入口在登录弹窗「账号登录 → 密码登录」表单下方，邮件服务未配置时隐藏。
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { userApi, type CaptchaValue } from "@/lib/api";
import { CaptchaField } from "@/components/captcha-field";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [captcha, setCaptcha] = useState<CaptchaValue>({ captcha_id: "", captcha_code: "" });
  /** bump 强制重挂载 CaptchaField：每次提交（无论成败）验证码都被后端消费 */
  const [captchaKey, setCaptchaKey] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [sentMessage, setSentMessage] = useState("");
  /** 客户端节流，配合后端 per-IP / per-email 限流窗口 */
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setInterval(() => setCooldown((v) => Math.max(0, v - 1)), 1000);
    return () => clearInterval(t);
  }, [cooldown]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading || cooldown > 0) return;
    setError("");
    setLoading(true);
    try {
      const res = await userApi.requestPasswordReset({
        email: email.trim(),
        captcha_id: captcha.captcha_id,
        captcha_code: captcha.captcha_code,
      });
      setSent(true);
      setSentMessage(res.message || "如果该邮箱已注册，您将收到重置邮件");
      setCooldown(60);
    } catch (err) {
      setError(err instanceof Error ? err.message : "发送失败，请稍后重试");
    } finally {
      setLoading(false);
      setCaptchaKey((k) => k + 1);
      setCaptcha({ captcha_id: "", captcha_code: "" });
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-[400px] rounded-[18px] border border-border bg-surface p-7 shadow-[0_20px_60px_rgba(0,0,0,0.18)]">
        {!sent ? (
          <>
            <h1 className="text-[22px] font-semibold tracking-tight text-foreground">找回密码</h1>
            <p className="mt-1 text-[13px] text-secondary">
              输入账号绑定的邮箱，我们将发送密码重置链接
            </p>
            <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-3">
              <input
                type="email"
                className="field"
                placeholder="邮箱"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
              />
              <CaptchaField key={`forgot-${captchaKey}`} onChange={setCaptcha} />
              {error && <p className="text-[12px] text-danger">{error}</p>}
              <button
                type="submit"
                disabled={loading || cooldown > 0}
                className="btn-pill btn-primary mt-1 h-10 text-[14px]"
              >
                {loading ? "发送中…" : cooldown > 0 ? `${cooldown}s 后可重发` : "发送重置邮件"}
              </button>
            </form>
          </>
        ) : (
          <>
            <h1 className="text-[22px] font-semibold tracking-tight text-foreground">查收邮件</h1>
            <p className="mt-1 text-[13px] text-secondary">
              {sentMessage}。重置链接 10 分钟内有效，请前往邮箱点击链接设置新密码；
              若未收到，请检查垃圾箱或稍后重新发送。
            </p>
            <button
              onClick={() => setSent(false)}
              disabled={cooldown > 0}
              className="btn-pill btn-ghost mt-6 h-10 w-full text-[14px]"
            >
              {cooldown > 0 ? `${cooldown}s 后可重新发送` : "重新发送"}
            </button>
          </>
        )}
        <p className="mt-5 text-center text-[12px] text-tertiary">
          想起密码了？{" "}
          <Link
            href="/"
            className="text-foreground underline underline-offset-2 hover:text-primary"
          >
            返回登录
          </Link>
        </p>
      </div>
    </div>
  );
}
