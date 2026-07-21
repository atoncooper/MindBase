"use client";

import { useId, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { motion } from "framer-motion";
import { userApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { GoogleInput, EyeIcon } from "@/components/ui/google-input";
import { cn } from "@/lib/utils";
import { AuthLayout, itemVariants, Spinner, AlertIcon, CheckSmall, SuccessCard, ErrorCard } from "@/components/auth/auth-ui";

function PasswordChecks({ pw, confirm }: { pw: string; confirm: string }) {
  const checks = [
    { label: "至少 8 个字符", pass: pw.length >= 8 },
    { label: "包含字母", pass: /[A-Za-z]/.test(pw) },
    { label: "包含数字", pass: /[0-9]/.test(pw) },
  ];
  const matched = confirm.length > 0 && pw === confirm;
  const mismatched = confirm.length > 0 && pw !== confirm;

  return (
    <ul className="mt-3 space-y-1.5">
      {checks.map((c) => (
        <li key={c.label} className="flex items-center gap-2 text-[13px]">
          <span
            className={cn(
              "flex h-4 w-4 items-center justify-center rounded-full border transition-all duration-200",
              c.pass
                ? "border-[#1e8e3e] bg-[#1e8e3e] text-white dark:border-[#81c995] dark:bg-[#81c995] dark:text-[#1e2920]"
                : "border-[var(--gemini-border)] text-transparent"
            )}
          >
            <CheckSmall />
          </span>
          <span className={c.pass ? "text-[var(--gemini-text-secondary)]" : "text-[var(--gemini-text-tertiary)]"}>
            {c.label}
          </span>
        </li>
      ))}
      {confirm.length > 0 && (
        <li className="flex items-center gap-2 text-[13px]">
          <span
            className={cn(
              "flex h-4 w-4 items-center justify-center rounded-full border transition-all duration-200",
              mismatched
                ? "border-[#d93025] text-transparent dark:border-[#f28b82]"
                : "border-[#1e8e3e] bg-[#1e8e3e] text-white dark:border-[#81c995] dark:bg-[#81c995] dark:text-[#1e2920]"
            )}
          >
            <CheckSmall />
          </span>
          <span className={matched ? "text-[var(--gemini-text-secondary)]" : "text-[#d93025] dark:text-[#f28b82]"}>
            两次输入一致
          </span>
        </li>
      )}
    </ul>
  );
}

function ResetPasswordInner() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";

  const pwId = useId();
  const confirmId = useId();
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      await userApi.confirmPasswordReset({ reset_token: token, new_password: newPassword });
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "重置失败，请重新申请");
    } finally {
      setSubmitting(false);
    }
  };

  const renderEye = () => (
    <Button
      type="button"
      variant="ghost"
      size="icon-lg"
      onClick={() => setShowPw((o) => !o)}
      aria-label={showPw ? "隐藏密码" : "显示密码"}
      className="h-9 w-9 rounded-full text-[var(--gemini-text-secondary)] hover:bg-[var(--gemini-border-subtle)] hover:text-[var(--gemini-text-primary)]"
    >
      <EyeIcon open={showPw} />
    </Button>
  );

  return (
    <AuthLayout
      brand={
        <>
          <motion.div variants={itemVariants} className="relative z-10 flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--gemini-user-bubble)] text-[var(--gemini-primary)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--gemini-primary)_12%,transparent)]">
              <span className="text-lg font-medium">M</span>
            </div>
            <p className="text-xs font-medium tracking-[0.18em] text-[var(--gemini-primary)]">MINDBASE</p>
          </motion.div>

          <motion.div variants={itemVariants} className="relative z-10 my-10 md:my-0">
            <h1 className="max-w-[320px] text-[28px] font-normal leading-[1.18] tracking-[-0.5px] text-[var(--gemini-text-primary)] md:text-[34px]">
              设置一个新密码
            </h1>
            <p className="mt-4 max-w-[360px] text-[14px] leading-[1.65] text-[var(--gemini-text-secondary)]">
              为你的账号设置新密码后即可重新登录。建议 8 位以上，同时包含字母和数字。
            </p>
          </motion.div>

          <motion.p variants={itemVariants} className="relative z-10 hidden text-[13px] text-[var(--gemini-text-tertiary)] md:block">
            设置完成后，旧密码将立即失效。
          </motion.p>
        </>
      }
    >
      {!token ? (
        <ErrorCard
          title="重置链接无效"
          desc="链接缺少必要的凭证，可能已损坏或被截断。请重新申请一封密码重置邮件。"
        >
          <Link
            href="/forgot-password"
            className="mt-6 flex h-11 items-center justify-center rounded-full bg-[var(--gemini-primary)] font-medium text-white transition-colors hover:bg-[var(--gemini-primary-hover)]"
          >
            重新申请重置邮件
          </Link>
        </ErrorCard>
      ) : done ? (
        <SuccessCard title="密码已重置" desc="你现在可以使用新密码登录了。">
          <Link
            href="/"
            className="mt-6 flex h-11 items-center justify-center rounded-full bg-[var(--gemini-primary)] font-medium text-white transition-colors hover:bg-[var(--gemini-primary-hover)]"
          >
            返回登录
          </Link>
        </SuccessCard>
      ) : (
        <form onSubmit={onSubmit} noValidate>
          <motion.div variants={itemVariants} className="mb-2">
            <p className="text-xs font-medium tracking-[0.16em] text-[var(--gemini-primary)]">MINDBASE</p>
            <h2 className="mt-1 text-[24px] font-normal tracking-[-0.3px] text-[var(--gemini-text-primary)]">设置新密码</h2>
          </motion.div>
          <motion.p variants={itemVariants} className="mb-6 text-[14px] leading-[1.6] text-[var(--gemini-text-secondary)]">
            请输入新密码，并通过下方的强度要求检查。
          </motion.p>

          <motion.div variants={itemVariants} className="grid gap-4">
            <GoogleInput
              id={pwId}
              label="新密码"
              type={showPw ? "text" : "password"}
              value={newPassword}
              onChange={(v) => {
                setNewPassword(v);
                setError(null);
              }}
              autoComplete="new-password"
              trailing={renderEye()}
            />
            <GoogleInput
              id={confirmId}
              label="确认新密码"
              type={showPw ? "text" : "password"}
              value={confirmPassword}
              onChange={(v) => {
                setConfirmPassword(v);
                setError(null);
              }}
              autoComplete="new-password"
              trailing={renderEye()}
            />
          </motion.div>

          <motion.div variants={itemVariants}>
            <PasswordChecks pw={newPassword} confirm={confirmPassword} />
          </motion.div>

          <motion.div variants={itemVariants} className="min-h-[40px] pt-3">
            {error && (
              <div role="alert" className="flex items-start gap-2 rounded-[8px] bg-[#fce8e6] px-3 py-2 text-[13px] leading-5 text-[#d93025] dark:bg-[#2a1a1a] dark:text-[#f28b82]">
                <AlertIcon />
                <span>{error}</span>
              </div>
            )}
          </motion.div>

          <motion.div variants={itemVariants}>
            <Button
              type="submit"
              disabled={submitting}
              className="h-11 w-full rounded-full bg-[var(--gemini-primary)] text-white transition-colors hover:bg-[var(--gemini-primary-hover)] disabled:opacity-60"
            >
              {submitting ? (
                <span className="flex items-center justify-center gap-2">
                  <Spinner /> 提交中
                </span>
              ) : (
                "重置密码"
              )}
            </Button>
          </motion.div>

          <motion.div variants={itemVariants} className="mt-5 text-center">
            <Link href="/" className="text-[13px] font-medium text-[var(--gemini-text-secondary)] transition-colors hover:text-[var(--gemini-primary)] hover:underline">
              ← 返回登录
            </Link>
          </motion.div>
        </form>
      )}
    </AuthLayout>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[var(--gemini-surface)]" />}>
      <ResetPasswordInner />
    </Suspense>
  );
}
