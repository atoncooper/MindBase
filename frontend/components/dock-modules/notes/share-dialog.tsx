"use client";

import { useState } from "react";
import { X, Copy, Check, Link2, ShieldOff } from "lucide-react";
import { notesApi, type NoteShareInfo } from "@/lib/api";
import "./notes.css";

interface ShareDialogProps {
    noteUuid: string;
    existing: NoteShareInfo | null;
    onClose: () => void;
    onShared: (info: NoteShareInfo | null) => void;
}

export default function ShareDialog({
    noteUuid,
    existing,
    onClose,
    onShared,
}: ShareDialogProps) {
    const [info, setInfo] = useState<NoteShareInfo | null>(existing);
    const [expiresInDays, setExpiresInDays] = useState<number | "">("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const fullUrl = info ? `${origin}${info.shareUrl}` : "";

    const create = async () => {
        setBusy(true);
        setError(null);
        try {
            const days = expiresInDays === "" ? undefined : Number(expiresInDays);
            const result = await notesApi.createShare(noteUuid, days);
            setInfo(result);
            onShared(result);
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : "生成失败");
        } finally {
            setBusy(false);
        }
    };

    const revoke = async () => {
        if (!confirm("撤销后分享链接立即失效，确定？")) return;
        setBusy(true);
        setError(null);
        try {
            await notesApi.revokeShare(noteUuid);
            setInfo(null);
            onShared(null);
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : "撤销失败");
        } finally {
            setBusy(false);
        }
    };

    const copy = async () => {
        if (!fullUrl) return;
        try {
            await navigator.clipboard.writeText(fullUrl);
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
        } catch {
            // ignore
        }
    };

    return (
        <div
            className="notes-scope fixed inset-0 flex items-center justify-center z-50 note-modal-backdrop"
            onClick={onClose}
        >
            <div
                className="note-modal w-full max-w-md p-7 note-fade-in"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-start justify-between mb-1">
                    <div>
                        <h3
                            style={{
                                fontFamily: "var(--note-serif)",
                                fontSize: 19,
                                fontWeight: 500,
                                color: "var(--note-ink)",
                                letterSpacing: "-0.005em",
                                fontVariationSettings: '"opsz" 72',
                            }}
                        >
                            分享笔记
                        </h3>
                        <p
                            className="mt-1"
                            style={{
                                fontFamily: "var(--note-sans)",
                                fontSize: 12,
                                color: "var(--note-ink-faint)",
                            }}
                        >
                            任何持有链接的人都可只读访问
                        </p>
                    </div>
                    <button
                        onClick={onClose}
                        className="note-btn is-ghost"
                        aria-label="关闭"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>

                <div
                    className="my-5"
                    style={{ borderTop: "1px solid var(--note-line-soft)" }}
                />

                {info ? (
                    <div className="space-y-4">
                        <div>
                            <label
                                className="note-meta-soft"
                                style={{ display: "block", marginBottom: 6 }}
                            >
                                分享链接
                            </label>
                            <div className="flex gap-2">
                                <input
                                    readOnly
                                    value={fullUrl}
                                    className="flex-1 px-3 py-2 text-sm rounded-lg outline-none"
                                    style={{
                                        fontFamily: "var(--note-mono)",
                                        fontSize: 12,
                                        background: "var(--note-paper-sunken)",
                                        border: "1px solid var(--note-line)",
                                        color: "var(--note-ink)",
                                    }}
                                    onFocus={(e) =>
                                        e.currentTarget.select()
                                    }
                                />
                                <button
                                    onClick={copy}
                                    className="note-btn is-primary"
                                    style={{ padding: "8px 14px" }}
                                >
                                    {copied ? (
                                        <Check className="w-3.5 h-3.5" />
                                    ) : (
                                        <Copy className="w-3.5 h-3.5" />
                                    )}
                                    {copied ? "已复制" : "复制"}
                                </button>
                            </div>
                        </div>
                        <div
                            className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs"
                            style={{
                                background: "var(--note-paper-sunken)",
                                color: "var(--note-ink-soft)",
                                fontFamily: "var(--note-sans)",
                            }}
                        >
                            <Link2 className="w-3 h-3" />
                            {info.expiresAt
                                ? `过期时间：${new Date(info.expiresAt).toLocaleString("zh-CN")}`
                                : "永久有效"}
                        </div>
                        <button
                            onClick={revoke}
                            disabled={busy}
                            className="note-btn is-danger w-full justify-center"
                            style={{ padding: "9px 14px" }}
                        >
                            <ShieldOff className="w-3.5 h-3.5" />
                            撤销分享
                        </button>
                    </div>
                ) : (
                    <div className="space-y-4">
                        <div>
                            <label
                                className="note-meta-soft"
                                style={{ display: "block", marginBottom: 6 }}
                            >
                                有效期（天，留空 = 永久）
                            </label>
                            <input
                                type="number"
                                min={1}
                                max={365}
                                value={expiresInDays}
                                onChange={(e) =>
                                    setExpiresInDays(
                                        e.target.value === ""
                                            ? ""
                                            : Number(e.target.value),
                                    )
                                }
                                placeholder="如 7"
                                className="w-full px-3 py-2 text-sm rounded-lg outline-none"
                                style={{
                                    fontFamily: "var(--note-sans)",
                                    background: "var(--note-paper)",
                                    border: "1px solid var(--note-line)",
                                    color: "var(--note-ink)",
                                }}
                            />
                        </div>
                        <button
                            onClick={create}
                            disabled={busy}
                            className="note-btn is-primary w-full justify-center"
                            style={{ padding: "10px 14px" }}
                        >
                            生成分享链接
                        </button>
                    </div>
                )}

                {error && (
                    <p
                        className="mt-3 text-xs"
                        style={{
                            color: "var(--note-danger)",
                            fontFamily: "var(--note-sans)",
                        }}
                    >
                        {error}
                    </p>
                )}
            </div>
        </div>
    );
}
