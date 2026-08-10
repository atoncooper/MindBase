"use client";

/**
 * InstalledList - the user's installed skills as a card grid.
 *
 * Supports upload-install (zip), preview (opens drawer), and uninstall
 * (optimistic removal). Reloads when refreshKey changes (post-install/uninstall).
 */
import { useEffect, useRef, useState } from "react";
import { Plus, Eye, Trash2, Loader2, AlertCircle, Package, Code2 } from "lucide-react";
import { skillsApi, type InstalledSkill } from "@/lib/api";

interface Props {
    refreshKey: number;
    onPreview: (id: string) => void;
    onChanged: () => void;
}

export function InstalledList({ refreshKey, onPreview, onChanged }: Props) {
    const [items, setItems] = useState<InstalledSkill[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [uploading, setUploading] = useState(false);
    const fileRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            setError(null);
            try {
                const list = await skillsApi.listInstalled();
                if (!cancelled) setItems(list);
            } catch (e) {
                if (!cancelled) setError(e instanceof Error ? e.message : "加载失败");
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [refreshKey]);

    async function handleUpload(file: File) {
        setUploading(true);
        setError(null);
        try {
            await skillsApi.uploadInstall(file);
            onChanged();
        } catch (e) {
            setError(e instanceof Error ? e.message : "上传失败");
        } finally {
            setUploading(false);
        }
    }

    async function handleUninstall(id: string) {
        setBusy(id);
        setError(null);
        try {
            await skillsApi.uninstall(id);
            setItems((prev) => prev.filter((s) => s.skill_id !== id));
        } catch (e) {
            setError(e instanceof Error ? e.message : "卸载失败");
        } finally {
            setBusy(null);
        }
    }

    return (
        <div>
            <div className="flex items-center justify-between">
                <p className="text-[13px] text-secondary">
                    {loading ? "加载中…" : `${items.length} 个已安装技能`}
                </p>
                <input
                    ref={fileRef}
                    type="file"
                    accept=".zip"
                    hidden
                    onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void handleUpload(f);
                        e.target.value = "";
                    }}
                />
                <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    disabled={uploading}
                    title="上传安装"
                    aria-label="上传安装"
                    className="grid h-8 w-8 place-items-center rounded-full bg-foreground text-surface transition-opacity hover:opacity-90 disabled:opacity-40"
                >
                    {uploading ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                        <Plus className="h-4 w-4" />
                    )}
                </button>
            </div>

            {error && (
                <div className="mt-4 flex items-start gap-2 rounded-lg border-l-2 border-foreground bg-border-subtle px-3 py-2.5 text-[12px] text-foreground">
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {error}
                </div>
            )}

            {loading ? (
                <div className="mt-16 flex justify-center">
                    <Loader2 className="h-5 w-5 animate-spin text-tertiary" />
                </div>
            ) : items.length === 0 ? (
                <EmptyState />
            ) : (
                <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {items.map((s) => (
                        <div
                            key={s.skill_id}
                            className="flex flex-col rounded-lg border border-border-subtle bg-surface p-4"
                        >
                            <div className="flex items-start gap-2.5">
                                <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-border-subtle text-foreground">
                                    <Package className="h-4 w-4" />
                                </div>
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-1.5">
                                        <span className="truncate text-[14px] font-semibold text-foreground">
                                            {s.name}
                                        </span>
                                        {s.version && (
                                            <span className="shrink-0 text-[11px] text-tertiary">
                                                v{s.version}
                                            </span>
                                        )}
                                    </div>
                                    <div className="truncate text-[11px] text-tertiary">
                                        {s.skill_id}
                                    </div>
                                </div>
                            </div>

                            <p className="mt-2.5 line-clamp-2 min-h-[2.6em] text-[12px] text-secondary">
                                {s.description || "无描述"}
                            </p>

                            <div className="mt-2 flex flex-wrap gap-1">
                                {s.has_code_tools && (
                                    <Badge icon={<Code2 className="h-3 w-3" />}>代码工具</Badge>
                                )}
                                {s.source_store && s.source_store !== "upload" && (
                                    <Badge>{s.source_store}</Badge>
                                )}
                                {!s.enabled && <Badge>已禁用</Badge>}
                            </div>

                            <div className="mt-3 flex items-center gap-1 border-t border-border-subtle pt-3">
                                <button
                                    type="button"
                                    onClick={() => onPreview(s.skill_id)}
                                    className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-md py-1.5 text-[12px] font-medium text-secondary transition-colors hover:bg-border-subtle hover:text-foreground"
                                >
                                    <Eye className="h-3.5 w-3.5" />
                                    预览
                                </button>
                                <button
                                    type="button"
                                    onClick={() => void handleUninstall(s.skill_id)}
                                    disabled={busy === s.skill_id}
                                    className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-md py-1.5 text-[12px] font-medium text-secondary transition-colors hover:bg-danger/5 hover:text-danger disabled:opacity-40"
                                >
                                    {busy === s.skill_id ? (
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    ) : (
                                        <Trash2 className="h-3.5 w-3.5" />
                                    )}
                                    卸载
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

function Badge({
    children,
    icon,
}: {
    children: React.ReactNode;
    icon?: React.ReactNode;
}) {
    return (
        <span className="inline-flex items-center gap-1 rounded bg-border-subtle px-1.5 py-0.5 text-[10px] text-tertiary">
            {icon}
            {children}
        </span>
    );
}

function EmptyState() {
    return (
        <div className="mt-16 flex flex-col items-center gap-2 text-center">
            <Package className="h-8 w-8 text-tertiary" />
            <p className="text-[14px] font-medium text-foreground">
                还没有安装任何技能
            </p>
            <p className="text-[12px] text-tertiary">
                从「技能商店」安装，或上传 zip 包
            </p>
        </div>
    );
}
