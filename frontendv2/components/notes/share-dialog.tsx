"use client";

/**
 * Share dialog - create / copy / revoke a public share link for a note.
 *
 * Two states: no active share (offer to create with optional expiry) vs.
 * active share (show link + copy + revoke). Apple-style centered modal,
 * portaled to document.body.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Copy, Check, Link2, Loader2, Trash2, X, Globe } from "lucide-react";
import { notesApi, type NoteShareInfo } from "@/lib/api/notes";

interface ShareDialogProps {
    open: boolean;
    uuid: string;
    shareToken: string | null;
    shareExpiresAt: string | null;
    onClose: () => void;
    onShareChanged: (info: NoteShareInfo | null) => void;
}

export function ShareDialog({
    open,
    uuid,
    shareToken,
    shareExpiresAt,
    onClose,
    onShareChanged,
}: ShareDialogProps) {
    const [expiresIn, setExpiresIn] = useState("");
    const [busy, setBusy] = useState(false);
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        // Reset transient form state when the dialog closes. These setStates
        // sync to the `open` prop rather than deriving from render, so the
        // cascading-render rule is a false positive here.
        /* eslint-disable react-hooks/set-state-in-effect */
        if (!open) {
            setExpiresIn("");
            setBusy(false);
            setCopied(false);
            setError(null);
        }
        /* eslint-enable react-hooks/set-state-in-effect */
    }, [open]);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [open, onClose]);

    if (typeof document === "undefined") return null;

    const fullUrl =
        shareToken && typeof window !== "undefined"
            ? `${window.location.origin}/notes/shared/${shareToken}`
            : "";

    const handleCreate = async () => {
        setBusy(true);
        setError(null);
        try {
            const days = expiresIn.trim() ? Number.parseInt(expiresIn, 10) : undefined;
            if (expiresIn.trim() && (!days || days < 1 || days > 365)) {
                setError("有效期需为 1-365 之间的整数，或留空表示永久");
                setBusy(false);
                return;
            }
            const info = await notesApi.createShare(uuid, days);
            onShareChanged(info);
        } catch (e) {
            setError(e instanceof Error ? e.message : "生成分享链接失败");
        } finally {
            setBusy(false);
        }
    };

    const handleCopy = async () => {
        if (!fullUrl) return;
        try {
            await navigator.clipboard.writeText(fullUrl);
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
        } catch {
            // Silently ignore - user can still select and copy manually.
        }
    };

    const handleRevoke = async () => {
        setBusy(true);
        setError(null);
        try {
            await notesApi.revokeShare(uuid);
            onShareChanged(null);
        } catch (e) {
            setError(e instanceof Error ? e.message : "撤销分享失败");
        } finally {
            setBusy(false);
        }
    };

    const expiryLabel = (() => {
        if (!shareExpiresAt) return "永久有效";
        const d = new Date(shareExpiresAt);
        return Number.isNaN(d.getTime()) ? "永久有效" : `过期时间：${d.toLocaleString("zh-CN")}`;
    })();

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
                        aria-label="分享笔记"
                    >
                        {/* Header */}
                        <div className="flex items-center justify-between px-5 pb-3 pt-5">
                            <div className="flex items-center gap-2">
                                <span className="grid h-7 w-7 place-items-center rounded-full bg-accent-soft text-accent">
                                    <Globe className="h-4 w-4" />
                                </span>
                                <h2 className="text-[15px] font-semibold tracking-tight text-foreground">
                                    分享笔记
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
                            {shareToken ? (
                                /* Active share */
                                <div className="space-y-3">
                                    <div className="flex items-center gap-2 rounded-xl border border-border bg-border-subtle/60 px-3 py-2">
                                        <Link2 className="h-3.5 w-3.5 shrink-0 text-secondary" />
                                        <input
                                            readOnly
                                            value={fullUrl}
                                            className="min-w-0 flex-1 bg-transparent text-[12px] text-foreground/80 outline-none"
                                            onFocus={(e) => e.currentTarget.select()}
                                        />
                                        <button
                                            type="button"
                                            onClick={handleCopy}
                                            className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-accent transition-colors hover:bg-accent-soft"
                                        >
                                            {copied ? (
                                                <>
                                                    <Check className="h-3 w-3" />
                                                    已复制
                                                </>
                                            ) : (
                                                <>
                                                    <Copy className="h-3 w-3" />
                                                    复制
                                                </>
                                            )}
                                        </button>
                                    </div>
                                    <p className="flex items-center gap-1.5 text-[11px] text-secondary">
                                        <Link2 className="h-3 w-3" />
                                        {expiryLabel}
                                    </p>
                                    <button
                                        type="button"
                                        disabled={busy}
                                        onClick={handleRevoke}
                                        className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-danger/20 bg-danger/5 py-2 text-[13px] font-medium text-danger transition-colors hover:bg-danger/10 disabled:opacity-50"
                                    >
                                        {busy ? (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        ) : (
                                            <Trash2 className="h-3.5 w-3.5" />
                                        )}
                                        撤销分享
                                    </button>
                                </div>
                            ) : (
                                /* No share - create */
                                <div className="space-y-3">
                                    <p className="text-[13px] leading-relaxed text-secondary">
                                        生成一个公开链接，任何人都可以查看这篇笔记的内容（只读）。
                                    </p>
                                    <div>
                                        <label className="mb-1.5 block text-[12px] text-secondary">
                                            有效期（天，留空为永久）
                                        </label>
                                        <input
                                            type="number"
                                            min={1}
                                            max={365}
                                            value={expiresIn}
                                            onChange={(e) => setExpiresIn(e.target.value)}
                                            placeholder="如 7"
                                            className="field h-9 text-[13px]"
                                        />
                                    </div>
                                    <button
                                        type="button"
                                        disabled={busy}
                                        onClick={handleCreate}
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

                            {error && (
                                <p className="mt-3 text-[12px] text-danger">{error}</p>
                            )}
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>,
        document.body
    );
}
