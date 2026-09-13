"use client";

/**
 * MindMapView - 思维导图页主视图（P2：列表 + 完整编辑器）。
 *
 * 左侧栏沿用 Google Drive 式列表（搜索 / tonal 选中态 / 胶囊行）；选中后右侧
 * 挂载从桌面端移植的完整编辑器（MindMapEditorView，含主题/大纲/图形库/导出/
 * 快照等，经 web shim 走 boards API 持久化）。编辑器经 next/dynamic
 * ssr:false 懒加载（simple-mind-map 直接操作 DOM）。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { Plus, Pin, Trash2, Network, Search, X } from "lucide-react";
import { boardsApi, type BoardMeta } from "@/lib/api/boards";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ToastProvider } from "./editor/toast";

const MindMapEditorView = dynamic(() => import("./editor/MindMapEditorView"), {
    ssr: false,
    loading: () => (
        <div className="flex h-full items-center justify-center text-[13px] text-secondary">
            编辑器加载中…
        </div>
    ),
});

function timeAgo(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    const diff = Date.now() - date.getTime();
    const min = Math.floor(diff / 60000);
    const hour = Math.floor(diff / 3600000);
    const day = Math.floor(diff / 86400000);
    if (min < 1) return "刚刚";
    if (min < 60) return `${min} 分钟前`;
    if (hour < 24) return `${hour} 小时前`;
    if (day < 7) return `${day} 天前`;
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

/** Google 图标按钮：圆形 hover 区域。 */
function IconButton({
    label,
    danger,
    active,
    onClick,
    children,
}: {
    label: string;
    danger?: boolean;
    active?: boolean;
    onClick: () => void;
    children: React.ReactNode;
}) {
    return (
        <button
            title={label}
            aria-label={label}
            onClick={onClick}
            className={cn(
                "flex h-9 w-9 items-center justify-center rounded-full transition-colors",
                "hover:bg-border-subtle focus:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                danger ? "text-secondary hover:text-danger" : active ? "text-accent" : "text-secondary"
            )}
        >
            {children}
        </button>
    );
}

export function MindMapView() {
    const [boards, setBoards] = useState<BoardMeta[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [selected, setSelected] = useState<BoardMeta | null>(null);
    const [query, setQuery] = useState("");
    const [creating, setCreating] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState<BoardMeta | null>(null);
    const [deleting, setDeleting] = useState(false);

    const refreshList = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const result = await boardsApi.list({ kind: "mindmap" });
            setBoards(result.items);
        } catch (e) {
            setError(e instanceof Error ? e.message : "加载失败");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void refreshList();
    }, [refreshList]);

    // 编辑器自动保存后同步列表的 updated_at（编辑器 flush 不回调，这里轮询节流）。
    useEffect(() => {
        if (selected === null) return;
        const timer = setInterval(() => void refreshList(), 30_000);
        return () => clearInterval(timer);
    }, [selected, refreshList]);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return boards;
        return boards.filter((b) => b.title.toLowerCase().includes(q));
    }, [boards, query]);

    // Google Drive 惯例：新建即创建"未命名导图"并打开。
    const handleCreate = async () => {
        if (creating) return;
        setCreating(true);
        try {
            const meta = await boardsApi.create({ title: "未命名导图", kind: "mindmap" });
            await refreshList();
            setSelected(meta);
        } catch (e) {
            setError(e instanceof Error ? e.message : "创建失败");
        } finally {
            setCreating(false);
        }
    };

    const handleTogglePin = async (board: BoardMeta) => {
        try {
            await boardsApi.setPin(board.uuid, !board.isPinned);
            await refreshList();
        } catch (e) {
            setError(e instanceof Error ? e.message : "操作失败");
        }
    };

    const handleDelete = async () => {
        if (confirmDelete === null) return;
        setDeleting(true);
        try {
            await boardsApi.remove(confirmDelete.uuid);
            if (selected?.uuid === confirmDelete.uuid) setSelected(null);
            setConfirmDelete(null);
            await refreshList();
        } catch (e) {
            setError(e instanceof Error ? e.message : "删除失败");
        } finally {
            setDeleting(false);
        }
    };

    return (
        <ToastProvider>
            <div className="flex h-[calc(100vh-3rem)] overflow-hidden">
                {/* ── 左侧栏：搜索 + 新建 + 文件列表 ────────────────── */}
                <aside className="flex w-80 shrink-0 flex-col border-r border-border-subtle bg-surface">
                    <div className="flex items-baseline gap-2 px-5 pb-3 pt-4">
                        <h1 className="text-[15px] font-medium tracking-tight">思维导图</h1>
                        <span className="text-xs text-tertiary">{boards.length}</span>
                    </div>

                    {/* 胶囊搜索框（Google search bar：灰底、聚焦浮白描边） */}
                    <div className="px-4 pb-3">
                        <div
                            className={cn(
                                "flex h-10 items-center gap-2 rounded-full px-4 transition-colors",
                                query
                                    ? "bg-surface ring-1 ring-border"
                                    : "bg-border-subtle focus-within:bg-surface focus-within:ring-1 focus-within:ring-border"
                            )}
                        >
                            <Search className="h-4 w-4 shrink-0 text-secondary" />
                            <input
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                placeholder="搜索导图"
                                className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-tertiary"
                            />
                            {query && (
                                <button
                                    onClick={() => setQuery("")}
                                    aria-label="清空搜索"
                                    className="text-tertiary hover:text-secondary"
                                >
                                    <X className="h-4 w-4" />
                                </button>
                            )}
                        </div>
                    </div>

                    {/* Filled 新建按钮（Google primary button） */}
                    <div className="px-4 pb-3">
                        <button
                            onClick={() => void handleCreate()}
                            disabled={creating}
                            className={cn(
                                "flex h-10 w-full items-center justify-center gap-2 rounded-full bg-accent text-[13px] font-medium text-accent-foreground shadow-sm transition-all",
                                "hover:bg-accent-hover hover:shadow active:shadow-none disabled:opacity-60"
                            )}
                        >
                            <Plus className="h-4 w-4" />
                            新建导图
                        </button>
                    </div>

                    {/* 文件列表：tonal 选中态 + 胶囊行 */}
                    <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
                        {loading ? (
                            <div className="px-4 py-10 text-center text-[13px] text-secondary">加载中…</div>
                        ) : filtered.length === 0 ? (
                            <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
                                <Network className="h-8 w-8 text-tertiary" strokeWidth={1.5} />
                                <p className="text-[13px] text-secondary">
                                    {query ? "没有匹配的导图" : "还没有导图"}
                                </p>
                                {!query && <p className="text-xs text-tertiary">点击上方「新建导图」开始</p>}
                            </div>
                        ) : (
                            <ul className="space-y-0.5">
                                {filtered.map((b) => {
                                    const active = selected?.uuid === b.uuid;
                                    return (
                                        <li key={b.uuid}>
                                            <div
                                                role="button"
                                                tabIndex={0}
                                                onClick={() => setSelected(b)}
                                                onKeyDown={(e) => {
                                                    if (e.key === "Enter" || e.key === " ") setSelected(b);
                                                }}
                                                className={cn(
                                                    "group flex cursor-pointer items-center gap-3 rounded-full px-4 py-2.5 transition-colors",
                                                    "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                                                    active ? "bg-accent-soft" : "hover:bg-border-subtle"
                                                )}
                                            >
                                                <Network
                                                    className={cn(
                                                        "h-4 w-4 shrink-0",
                                                        active ? "text-accent" : "text-tertiary"
                                                    )}
                                                />
                                                <div className="min-w-0 flex-1">
                                                    <div
                                                        className={cn(
                                                            "truncate text-[13px]",
                                                            active ? "font-medium text-accent" : "text-foreground"
                                                        )}
                                                    >
                                                        {b.title || "未命名导图"}
                                                    </div>
                                                    <div className="text-[11px] text-tertiary">
                                                        {timeAgo(b.updatedAt)}
                                                    </div>
                                                </div>
                                                <div
                                                    className={cn(
                                                        "flex items-center",
                                                        active ? "flex" : "hidden group-hover:flex"
                                                    )}
                                                >
                                                    <IconButton
                                                        label={b.isPinned ? "取消置顶" : "置顶"}
                                                        active={b.isPinned}
                                                        onClick={() => void handleTogglePin(b)}
                                                    >
                                                        <Pin className="h-4 w-4" />
                                                    </IconButton>
                                                    <IconButton
                                                        label="删除"
                                                        danger
                                                        onClick={() => setConfirmDelete(b)}
                                                    >
                                                        <Trash2 className="h-4 w-4" />
                                                    </IconButton>
                                                </div>
                                            </div>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </nav>
                </aside>

                {/* ── 右侧：完整编辑器（P2，桌面端移植） ─────────────── */}
                <section className="relative flex min-w-0 flex-1 flex-col bg-background">
                    {error && (
                        <div className="bg-danger/10 px-5 py-2 text-[13px] text-danger">{error}</div>
                    )}
                    {selected === null ? (
                        <div className="flex h-full flex-col items-center justify-center gap-3 bg-border-subtle">
                            <Network className="h-12 w-12 text-tertiary" strokeWidth={1} />
                            <p className="text-sm text-secondary">从左侧选择一个导图</p>
                            <button
                                onClick={() => void handleCreate()}
                                className="flex h-9 items-center gap-2 rounded-full border border-border bg-surface px-4 text-[13px] font-medium text-accent shadow-sm transition-colors hover:bg-accent-soft"
                            >
                                <Plus className="h-4 w-4" />
                                新建导图
                            </button>
                        </div>
                    ) : (
                        <MindMapEditorView key={selected.uuid} mapId={selected.uuid} />
                    )}
                </section>

                <ConfirmDialog
                    open={confirmDelete !== null}
                    title="删除导图"
                    message={confirmDelete ? `确定删除「${confirmDelete.title || "未命名导图"}」吗？` : ""}
                    confirmLabel="删除"
                    danger
                    busy={deleting}
                    onConfirm={() => void handleDelete()}
                    onCancel={() => setConfirmDelete(null)}
                />
            </div>
        </ToastProvider>
    );
}
