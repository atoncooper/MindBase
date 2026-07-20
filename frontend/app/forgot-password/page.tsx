"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { userApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { GoogleInput } from "@/components/ui/google-input";
import { AuthLayout, itemVariants, Spinner, AlertIcon, SuccessCard } from "@/components/auth/auth-ui";

export default function ForgotPasswordPage() {
  const emailId = useId();
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const trimmed = email.trim();
    if (!trimmed) {
      setError("请输入邮箱地址");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setError("请输入有效的邮箱地址");
      return;
    }
    setSubmitting(true);
    try {
      await userApi.requestPasswordReset({ email: trimmed });
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "请求失败，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  };

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
              找回你的账号访问
            </h1>
            <p className="mt-4 max-w-[360px] text-[14px] leading-[1.65] text-[var(--gemini-text-secondary)]">
              输入注册邮箱，我们会发送一封密码重置邮件。链接在 10 分钟内有效，请尽快完成重置。
            </p>
          </motion.div>

          <motion.p variants={itemVariants} className="relative z-10 hidden text-[13px] text-[var(--gemini-text-tertiary)] md:block">
            还没有账号？先扫码登录，再在账户安全中绑定邮箱并设置密码。
          </motion.p>
        </>
      }
    >
      {done ? (
        <SuccessCard
          title="检查你的邮箱"
          desc={
            <>
              如果 <span className="font-medium text-[var(--gemini-text-primary)]">{email}</span> 已注册，你将收到一封包含重置链接的邮件。
            </>
          }
        >
          <p className="mt-2 text-[13px] text-[var(--gemini-text-tertiary)]">
            没收到？检查垃圾邮件箱，或
            <button type="button" onClick={() => setDone(false)} className="ml-1 font-medium text-[var(--gemini-primary)] hover:underline">
              重新输入邮箱
            </button>
          </p>
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
            <h2 className="mt-1 text-[24px] font-normal tracking-[-0.3px] text-[var(--gemini-text-primary)]">重置密码</h2>
          </motion.div>
          <motion.p variants={itemVariants} className="mb-6 text-[14px] leading-[1.6] text-[var(--gemini-text-secondary)]">
            输入账号邮箱，我们会向你发送一封密码重置邮件。
          </motion.p>

          <motion.div variants={itemVariants}>
            <GoogleInput
              id={emailId}
              label="电子邮件地址"
              type="email"
              value={email}
              onChange={(v) => {
                setEmail(v);
                setError(null);
              }}
              autoComplete="email"
              autoFocus
              required
            />
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
                  <Spinner /> 发送中
                </span>
              ) : (
                "发送重置邮件"
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
