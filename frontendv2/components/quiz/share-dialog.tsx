"use client";

/**
 * Quiz share dialog - create/copy/revoke the public share link for one quiz.
 *
 * Backend model: ONE active share per quiz（状态 → 创建 → 撤销 → 重建）。
 * No share → create form (expiry select); shared → link + copy + revoke.
 * 公开阅读页：/quiz/shared/<token>（免登录，含设备证明？无 —— 文本类轻量）。
 */
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Check, Copy, Link2, Loader2, Trash2, X, Globe } from "lucide-react";
import { quizApi, type QuizShareStatus } from "@/lib/api";
import { getShareBaseUrl } from "@/lib/api/share";
import { Select } from "@/components/ui/select";

interface ShareDialogProps {
    open: boolean;
    quizUuid: string;
    /** 分享状态变化后通知父级（刷新列表徽标等） */
    onChanged?: () => void;
    onClose: () => void;
}

export function QuizShareDialog({ open, quizUuid, onChanged, onClose }: ShareDialogProps) {
    const [status, setStatus] = useState<QuizShareStatus | null>(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [expiresInDays, setExpiresInDays] = useState("");
    const [copied, setCopied] = useState(false);
    const [shareBase, setShareBase] = useState("");
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        void getShareBaseUrl().then((base) => {
            setShareBase(base || (typeof window !== "undefined" ? window.location.origin : ""));
        });
    }, []);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const s = await quizApi.getShareStatus(quizUuid);
            setStatus(s);
        } catch (e) {
            setError(e instanceof Error ? e.message : "加载分享状态失败");
        } finally {
            setLoading(false);
        }
    }, [quizUuid]);

    useEffect(() => {
        if (!open) return;
        // defer: load() sets state synchronously (react-hooks/set-state-in-effect)
        const t = setTimeout(() => void load(), 0);
        return () => clearTimeout(t);
    }, [open, load]);

    // Escape 关闭
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [open, onClose]);

    const active = status?.shared && status.share_token ? status : null;
    const fullUrl = active?.share_token ? `${shareBase}/quiz/shared/${active.share_token}` : "";

    const handleCreate = async () => {
        setBusy(true);
        setError(null);
        try {
            const d = expiresInDays.trim() ? Number.parseInt(expiresInDays, 10) : undefined;
            await quizApi.createShare(quizUuid, d ?? null);
            await load();
            onChanged?.();
        } catch (e) {
            setError(e instanceof Error ? e.message : "生成分享链接失败");
        } finally {
            setBusy(false);
        }
    };

    const handleRevoke = async () => {
        setBusy(true);
        setError(null);
        try {
            await quizApi.revokeShare(quizUuid);
            setStatus((s) => (s ? { ...s, shared: false, share_token: undefined } : s));
            onChanged?.();
        } catch (e) {
            setError(e instanceof Error ? e.message : "撤销分享失败");
        } finally {
            setBusy(false);
        }
    };

    const copyLink = () => {
        if (!fullUrl) return;
        void navigator.clipboard.writeText(fullUrl);
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
    };

    if (typeof document === "undefined") return null;

    return createPortal(
        <AnimatePresence>
            {open && (
                <motion.div
                    className="fixed inset-0 z-[100] flex items-center justify-center p-4"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                >
                    <div className="absolute inset-0 bg-black/30 backdrop-blur-[2px]" onClick={onClose} />
                    <motion.div
                        initial={{ opacity: 0, y: 16, scale: 0.97 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 16, scale: 0.97 }}
                        transition={{ duration: 0.22, ease: [0.28, 0.11, 0.32, 1] }}
                        className="relative w-full max-w-[400px] overflow-hidden rounded-[20px] border border-border bg-surface shadow-[0_12px_40px_rgba(0,0,0,0.14),0_2px_8px_rgba(0,0,0,0.06)]"
                        role="dialog"
                        aria-modal="true"
                        aria-label="分享测验"
                    >
                        <div className="flex items-center justify-between px-5 pb-3 pt-5">
                            <div className="flex items-center gap-2">
                                <span className="grid h-7 w-7 place-items-center rounded-full bg-accent-soft text-accent">
                                    <Globe className="h-4 w-4" />
                                </span>
                                <h2 className="text-[15px] font-semibold tracking-tight text-foreground">
                                    分享测验
                                </h2>
                            </div>
                            <button
                                type="button"
                                onClick={onClose}
                                className="grid h-7 w-7 place-items-center rounded-full text-secondary transition-colors hover:bg-border-subtle hover:text-foreground"
                            >
                                <X className="h-4 w-4" />
                            </button>
                        </div>

                        <div className="px-5 pb-5">
                            {loading ? (
                                <div className="flex justify-center py-8">
                                    <Loader2 className="h-5 w-5 animate-spin text-tertiary" />
                                </div>
                            ) : active ? (
                                <div className="space-y-3">
                                    <div className="flex items-center gap-2 rounded-xl border border-border bg-border-subtle/60 px-3 py-2">
                                        <Link2 className="h-3.5 w-3.5 shrink-0 text-secondary" />
                                        <input
                                            readOnly
                                            value={fullUrl}
                                            onFocus={(e) => e.currentTarget.select()}
                                            className="min-w-0 flex-1 bg-transparent text-[12px] text-foreground/80 outline-none"
                                        />
                                        <button
                                            type="button"
                                            onClick={copyLink}
                                            className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-accent transition-colors hover:bg-accent-soft"
                                        >
                                            {copied ? (
                                                <Check className="h-3 w-3" />
                                            ) : (
                                                <Copy className="h-3 w-3" />
                                            )}
                                            {copied ? "已复制" : "复制"}
                                        </button>
                                    </div>
                                    <p className="flex items-center gap-1.5 text-[11px] text-secondary">
                                        <Link2 className="h-3 w-3" />
                                        {active.share_expires_at
                                            ? `过期时间：${new Date(active.share_expires_at).toLocaleString("zh-CN")}`
                                            : "永久有效"}
                                    </p>
                                    <button
                                        type="button"
                                        disabled={busy}
                                        onClick={() => void handleRevoke()}
                                        className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-danger/20 bg-danger/5 py-2 text-[13px] font-medium text-danger transition-colors hover:bg-danger/10 disabled:opacity-50"
                                    >
                                        {busy ? (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        ) : (
                                            <Trash2 className="h-3.5 w-3.5" />
                                        )}
                                        撤销分享
                                    </button>
                                    <p className="text-center text-[11px] text-tertiary">
                                        撤销后可重新生成新的分享链接
                                    </p>
                                </div>
                            ) : (
                                <div className="space-y-3">
                                    <p className="text-[13px] leading-relaxed text-secondary">
                                        生成一个公开链接，任何人都可以在线查看这份题卷（只读，不含答案）。
                                    </p>
                                    <div>
                                        <label className="mb-1.5 block text-[12px] text-secondary">
                                            有效期（天，留空为永久）
                                        </label>
                                        <input
                                            type="number"
                                            min={1}
                                            max={365}
                                            value={expiresInDays}
                                            onChange={(e) => setExpiresInDays(e.target.value)}
                                            placeholder="如 7"
                                            className="field h-9 text-[13px]"
                                        />
                                    </div>
                                    <button
                                        type="button"
                                        disabled={busy}
                                        onClick={() => void handleCreate()}
                                        className="btn-pill btn-primary flex h-9 w-full text-[13px]"
                                    >
                                        {busy ? (
                                            <Loader2 className="h-4 w-4 animate-spin" />
                                        ) : (
                                            <Link2 className="h-4 w-4" />
                                        )}
                                        生成分享链接
                                    </button>
                                </div>
                            )}

                            {error && <p className="mt-3 text-[12px] text-danger">{error}</p>}
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>,
        document.body,
    );
}
