"use client";

import { useState } from "react";
import { userApi } from "@/lib/api";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) {
      setError("请输入邮箱");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await userApi.requestPasswordReset({ email: email.trim() });
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "请求失败，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#f8fafd] flex items-center justify-center px-4">
      <div className="w-full max-w-md bg-white rounded-[20px] shadow-[0_12px_36px_rgba(60,64,67,0.18)] p-8">
        <div className="mb-6 flex items-center gap-3">
          <div className="h-11 w-11 rounded-full bg-[#e8f0fe] text-[#1a73e8] flex items-center justify-center font-medium text-lg">
            M
          </div>
          <div>
            <p className="text-xs font-medium tracking-[0.16em] text-[#1a73e8]">MINDBASE</p>
            <h1 className="text-[22px] font-normal text-[#202124]">重置密码</h1>
          </div>
        </div>

        {done ? (
          <div className="space-y-4">
            <p className="text-[14px] leading-6 text-[#3c4043]">
              如果该邮箱已注册，您将收到一封包含重置链接的邮件。请在 10 分钟内完成重置。
            </p>
            <p className="text-[13px] text-[#5f6368]">
              没收到？请检查垃圾邮件箱，或{" "}
              <button
                onClick={() => setDone(false)}
                className="text-[#1a73e8] hover:underline font-medium"
              >
                重新输入邮箱
              </button>
            </p>
            <button
              onClick={() => (window.location.href = "/")}
              className="w-full h-11 rounded-full bg-[#1a73e8] text-white font-medium text-[14px] hover:bg-[#1765cc] transition-colors"
            >
              返回首页
            </button>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <p className="text-[14px] leading-6 text-[#3c4043]">
              输入您的账号邮箱，我们会向您发送一封密码重置邮件。
            </p>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="your@email.com"
              required
              className="w-full h-[48px] rounded border border-[#dadce0] bg-white px-4 text-base text-[#202124] outline-none focus:border-2 focus:border-[#1a73e8] transition-colors"
            />
            {error && (
              <div className="text-[13px] text-[#d93025] bg-[#fce8e6] rounded px-3 py-2">
                {error}
              </div>
            )}
            <button
              type="submit"
              disabled={submitting}
              className="w-full h-11 rounded-full bg-[#1a73e8] text-white font-medium text-[14px] hover:bg-[#1765cc] transition-colors disabled:opacity-60"
            >
              {submitting ? "发送中…" : "发送重置邮件"}
            </button>
            <button
              type="button"
              onClick={() => (window.location.href = "/")}
              className="w-full text-[13px] text-[#5f6368] hover:underline"
            >
              返回首页
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
