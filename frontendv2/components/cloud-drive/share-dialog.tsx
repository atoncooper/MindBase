"use client";

/**
 * Share dialog — create/copy/revoke Baidu-style share links for one file.
 * Extraction code (optional), expiry (days), download cap. The share URL is
 * an anonymous route (/cloud/s/<token>).
 *
 * The body is a keyed child mounted per-open — all dialog state resets via
 * unmount (no state-sync effects).
 */
import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, Copy, Link2, Loader2, Lock, X } from "lucide-react";
import { cloudApi, type CloudShareView } from "@/lib/api/cloud";
import { getShareBaseUrl } from "@/lib/api/share";
import { Select } from "@/components/ui/select";

interface ShareDialogProps {
    open: boolean;
    uploadUuid: string | null;
    fileName: string;
    onClose: () => void;
}

export function ShareDialog({ open, uploadUuid, fileName, onClose }: ShareDialogProps) {
    return (
        <AnimatePresence>
            {open && uploadUuid && (
                <ShareDialogBody
                    key={uploadUuid}
                    uploadUuid={uploadUuid}
                    fileName={fileName}
                    onClose={onClose}
                />
            )}
        </AnimatePresence>
    );
}

function ShareDialogBody({
    uploadUuid,
    fileName,
    onClose,
}: {
    uploadUuid: string;
    fileName: string;
    onClose: () => void;
}) {
    const [shares, setShares] = useState<CloudShareView[]>([]);
    // starts true: the mount effect kicks off the initial fetch
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [useCode, setUseCode] = useState(false);
    const [code, setCode] = useState("");
    const [expiresInDays, setExpiresInDays] = useState(7);
    const [maxDownloads, setMaxDownloads] = useState("");
    const [copiedId, setCopiedId] = useState<number | string | null>(null);
    // 重设提取码（legacy 哈希行不可见 → 换新码；链接与 token 不变）
    const [resetCodeId, setResetCodeId] = useState<number | null>(null);
    const [resetCodeValue, setResetCodeValue] = useState("");
    const [error, setError] = useState<string | null>(null);
    // 分享域名/公网 IP（/api/share-base），空则回退当前访问地址
    const [shareBase, setShareBase] = useState("");

    useEffect(() => {
        void getShareBaseUrl().then((base) => {
            setShareBase(base || (typeof window !== "undefined" ? window.location.origin : ""));
        });
    }, []);

    const fullUrlFor = (token: string) => `${shareBase}/cloud/s/${token}`;

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            const res = await cloudApi.listShares(uploadUuid);
            setShares(res.shares);
        } catch {
            setShares([]);
        } finally {
            setLoading(false);
        }
    }, [uploadUuid]);

    useEffect(() => {
        // mount fetch: async body so no setState runs synchronously in the effect
        const run = async () => {
            await Promise.resolve();
            await refresh();
        };
        void run();
    }, [refresh]);

    const handleCreate = async () => {
        setBusy(true);
        setError(null);
        try {
            const trimmed = code.trim();
            if (useCode && trimmed.length < 3) {
                setError("提取码至少 3 位");
                return;
            }
            const md = maxDownloads.trim();
            if (md && (!Number.isFinite(Number(md)) || Number(md) < 1)) {
                setError("下载次数上限需为正整数，或留空不限");
                return;
            }
            const res = await cloudApi.createShare(uploadUuid, {
                ...(useCode && trimmed ? { code: trimmed } : {}),
                expiresInDays,
                ...(md ? { maxDownloads: Number(md) } : {}),
            });
            setCopiedId(res.id ?? null); // 新链接直接进入列表并高亮复制态
            await refresh();
        } catch (e) {
            setError(e instanceof Error ? e.message : "创建失败");
        } finally {
            setBusy(false);
        }
    };

    const handleResetCode = async (id: number) => {
        if (resetCodeValue.trim().length < 3) return;
        setBusy(true);
        try {
            await cloudApi.updateShareCode(id, resetCodeValue.trim());
            setResetCodeId(null);
            setResetCodeValue("");
            await refresh();
        } catch (e) {
            setError(e instanceof Error ? e.message : "重设失败");
        } finally {
            setBusy(false);
        }
    };

    const handleRevoke = async (id: number) => {
        setBusy(true);
        try {
            await cloudApi.revokeShare(id);
            await refresh();
        } finally {
            setBusy(false);
        }
    };

    const copyLink = (id: number | string, url: string) => {
        void navigator.clipboard.writeText(url);
        setCopiedId(id);
        setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1500);
    };

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm"
            onClick={() => (busy ? undefined : onClose())}
        >
            <motion.div
                initial={{ opacity: 0, scale: 0.96, y: 8 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.96, y: 8 }}
                transition={{ duration: 0.18 }}
                className="w-full max-w-md rounded-2xl border border-border bg-surface p-5 shadow-[0_20px_60px_rgba(0,0,0,0.18)]"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="mb-4 flex items-center justify-between">
                    <h2 className="flex items-center gap-2 text-[15px] font-semibold text-foreground">
                        <Link2 className="h-4 w-4" />
                        分享「{fileName}」
                    </h2>
                    <button
                        type="button"
                        onClick={onClose}
                        className="rounded-full p-1 text-tertiary hover:bg-border-subtle hover:text-foreground"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                {/* Create form */}
                <div className="space-y-3 rounded-xl border border-border-subtle p-3">
                    <label className="flex items-center gap-2 text-[13px] text-foreground">
                        <input
                            type="checkbox"
                            checked={useCode}
                            onChange={(e) => setUseCode(e.target.checked)}
                            className="accent-[var(--accent,currentColor)]"
                        />
                        提取码
                    </label>
                    {useCode && (
                        <input
                            value={code}
                            onChange={(e) => setCode(e.target.value)}
                            placeholder="4 位提取码"
                            maxLength={8}
                            className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-[13px] outline-none focus:border-accent"
                        />
                    )}
                    <div className="flex items-center gap-2 text-[13px] text-foreground">
                        <span className="shrink-0 text-secondary">有效期</span>
                        <Select
                            className="flex-1"
                            value={String(expiresInDays)}
                            onChange={(v) => setExpiresInDays(Number(v))}
                            ariaLabel="有效期"
                            options={[
                                { value: "1", label: "1 天" },
                                { value: "7", label: "7 天" },
                                { value: "30", label: "30 天" },
                                { value: "0", label: "永久" },
                            ]}
                        />
                    </div>
                    <div className="flex items-center gap-2 text-[13px] text-foreground">
                        <span className="shrink-0 text-secondary">下载上限</span>
                        <input
                            type="number"
                            min={1}
                            value={maxDownloads}
                            onChange={(e) => setMaxDownloads(e.target.value)}
                            placeholder="不限"
                            className="field h-8 flex-1 text-[13px]"
                        />
                    </div>
                    {error && <p className="text-[12px] text-red-500">{error}</p>}
                    <button
                        type="button"
                        onClick={() => void handleCreate()}
                        disabled={busy}
                        className="btn-pill btn-primary h-8 w-full text-[12px]"
                    >
                        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "创建分享链接"}
                    </button>
                </div>

                {/* Active shares */}
                <div className="mt-4">
                    <p className="mb-2 text-[12px] font-medium text-secondary">
                        生效中的链接（{shares.length}）
                    </p>
                    {loading ? (
                        <div className="flex justify-center py-3">
                            <Loader2 className="h-4 w-4 animate-spin text-tertiary" />
                        </div>
                    ) : shares.length === 0 ? (
                        <p className="py-2 text-center text-[12px] text-tertiary">暂无生效链接</p>
                    ) : (
                        <ul className="max-h-52 space-y-2 overflow-y-auto">
                            {shares.map((sh) => {
                                const url = sh.shareToken ? fullUrlFor(sh.shareToken) : "";
                                return (
                                    <li
                                        key={sh.id}
                                        className="rounded-lg bg-border-subtle/50 px-2.5 py-1.5 text-[12px]"
                                    >
                                        <div className="flex items-center gap-1.5">
                                            <Link2 className="h-3 w-3 shrink-0 text-tertiary" />
                                            <span className="min-w-0 flex-1 truncate text-foreground">
                                                {url || "（无 token）"}
                                            </span>
                                            {url && (
                                                <button
                                                    type="button"
                                                    onClick={() => copyLink(sh.id, url)}
                                                    className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-accent hover:bg-accent-soft"
                                                >
                                                    {copiedId === sh.id ? (
                                                        <Check className="h-3 w-3" />
                                                    ) : (
                                                        <Copy className="h-3 w-3" />
                                                    )}
                                                    {copiedId === sh.id ? "已复制" : "复制"}
                                                </button>
                                            )}
                                            <button
                                                type="button"
                                                onClick={() => void handleRevoke(sh.id)}
                                                disabled={busy}
                                                className="shrink-0 text-[11px] text-red-500 hover:underline disabled:opacity-50"
                                            >
                                                撤销
                                            </button>
                                        </div>
                                        {/* 提取码：明文可见可复制；legacy 哈希行 → 重设 */}
                                        {sh.hasCode && (
                                            <div className="mt-1.5 flex items-center gap-1.5">
                                                {sh.extractionCode ? (
                                                    <>
                                                        <Lock className="h-3 w-3 shrink-0 text-tertiary" />
                                                        <span className="font-mono text-[11px] tracking-wider text-foreground">
                                                            {sh.extractionCode}
                                                        </span>
                                                        <button
                                                            type="button"
                                                            onClick={() => copyLink(`code-${sh.id}`, sh.extractionCode ?? "")}
                                                            className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-accent hover:bg-accent-soft"
                                                        >
                                                            {copiedId === `code-${sh.id}` ? (
                                                                <Check className="h-3 w-3" />
                                                            ) : (
                                                                <Copy className="h-3 w-3" />
                                                            )}
                                                            {copiedId === `code-${sh.id}` ? "已复制" : "复制"}
                                                        </button>
                                                    </>
                                                ) : (
                                                    <button
                                                        type="button"
                                                        onClick={() =>
                                                            setResetCodeId((cur) => (cur === sh.id ? null : sh.id))
                                                        }
                                                        className="text-[11px] text-warning hover:underline"
                                                    >
                                                        提取码不可见（旧格式）—— 点击重设
                                                    </button>
                                                )}
                                            </div>
                                        )}
                                        {resetCodeId === sh.id && (
                                            <div className="mt-1.5 flex gap-1.5">
                                                <input
                                                    value={resetCodeValue}
                                                    onChange={(e) => setResetCodeValue(e.target.value)}
                                                    placeholder="新提取码（3 位以上）"
                                                    maxLength={16}
                                                    className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-[12px] outline-none focus:border-accent"
                                                />
                                                <button
                                                    type="button"
                                                    disabled={busy || resetCodeValue.trim().length < 3}
                                                    onClick={() => void handleResetCode(sh.id)}
                                                    className="shrink-0 rounded-md bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent disabled:opacity-50"
                                                >
                                                    保存
                                                </button>
                                            </div>
                                        )}
                                        <div className="mt-1 text-[11px] text-tertiary">
                                            {sh.expiresAt
                                                ? `至 ${new Date(sh.expiresAt).toLocaleDateString()}`
                                                : "永久"}
                                            {" · "}
                                            查看 {sh.viewCount} · 下载 {sh.downloadCount}
                                        </div>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>
            </motion.div>
        </motion.div>
    );
}
