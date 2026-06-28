"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { userApi } from "@/lib/api";

function ResetPasswordInner() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) setError("重置链接无效：缺少 token");
  }, [token]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!token) {
      setError("重置链接无效");
      return;
    }
    if (newPassword.length < 8) {
      setError("密码至少 8 位");
      return;
    }
    if (!/[A-Za-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      setError("密码必须同时包含字母和数字");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("两次输入的密码不一致");
      return;
    }

    setSubmitting(true);
    try {
      await userApi.confirmPasswordReset({
        reset_token: token,
        new_password: newPassword,
      });
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "重置失败，请重新申请");
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
            <h1 className="text-[22px] font-normal text-[#202124]">设置新密码</h1>
          </div>
        </div>

        {done ? (
          <div className="space-y-4">
            <p className="text-[14px] leading-6 text-[#3c4043]">
              密码已重置成功，请使用新密码登录。
            </p>
            <button
              onClick={() => (window.location.href = "/")}
              className="w-full h-11 rounded-full bg-[#1a73e8] text-white font-medium text-[14px] hover:bg-[#1765cc] transition-colors"
            >
              返回首页登录
            </button>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <p className="text-[13px] text-[#5f6368]">
              请输入新密码（8 位以上，同时包含字母和数字）。
            </p>
            <input
              type={showPw ? "text" : "password"}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="新密码"
              required
              className="w-full h-[48px] rounded border border-[#dadce0] bg-white px-4 text-base text-[#202124] outline-none focus:border-2 focus:border-[#1a73e8] transition-colors"
            />
            <input
              type={showPw ? "text" : "password"}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="再次输入新密码"
              required
              className="w-full h-[48px] rounded border border-[#dadce0] bg-white px-4 text-base text-[#202124] outline-none focus:border-2 focus:border-[#1a73e8] transition-colors"
            />
            <label className="flex items-center gap-2 text-[13px] text-[#3c4043] cursor-pointer">
              <input
                type="checkbox"
                checked={showPw}
                onChange={(e) => setShowPw(e.target.checked)}
              />
              显示密码
            </label>
            {error && (
              <div className="text-[13px] text-[#d93025] bg-[#fce8e6] rounded px-3 py-2">
                {error}
              </div>
            )}
            <button
              type="submit"
              disabled={submitting || !token}
              className="w-full h-11 rounded-full bg-[#1a73e8] text-white font-medium text-[14px] hover:bg-[#1765cc] transition-colors disabled:opacity-60"
            >
              {submitting ? "提交中…" : "重置密码"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#f8fafd]" />}>
      <ResetPasswordInner />
    </Suspense>
  );
}
