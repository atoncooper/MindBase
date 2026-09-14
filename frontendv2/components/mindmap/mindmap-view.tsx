"use client";

/**
 * MindMapView - 思维导图/白板页主视图。
 *
 * 左侧栏沿用 Google Drive 式列表（kind 切换 / 搜索 / tonal 选中态 / 胶囊行）；
 * 选中后右侧挂载从桌面端移植的完整编辑器（MindMapEditorView：导图与白板
 * 按 board kind 内部分发，经 web shim 走 boards API 持久化）。编辑器经
 * next/dynamic ssr:false 懒加载（simple-mind-map 直接操作 DOM）。
 *
 * 导入：.md 按标题/列表层级转树（simple-mind-map markdownTo），.xmind 经
 * 库解析器转树，均落成一张新导图。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Plus, Pin, Trash2, Network, PenTool, Search, X, Upload } from "lucide-react";
import { boardsApi, type BoardMeta, type BoardKind } from "@/lib/api/boards";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ToastProvider } from "./editor/toast";
import { createMindMap, saveMindMap } from "@/lib/board-store";
import { transformMarkdownTo } from "simple-mind-map/src/parse/markdownTo.js";
import xmindParser from "simple-mind-map/src/parse/xmind.js";
import { toErrorMessage } from "./editor/errmsg";

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
    const [kind, setKind] = useState<BoardKind>("mindmap");
    const [boards, setBoards] = useState<BoardMeta[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [selected, setSelected] = useState<BoardMeta | null>(null);
    const [query, setQuery] = useState("");
    const [creating, setCreating] = useState(false);
    const [importing, setImporting] = useState(false);
    const importInputRef = useRef<HTMLInputElement | null>(null);
    const [confirmDelete, setConfirmDelete] = useState<BoardMeta | null>(null);
    const [deleting, setDeleting] = useState(false);

    const refreshList = useCallback(
        async (wantKind: BoardKind = kind) => {
            setLoading(true);
            setError(null);
            try {
                const result = await boardsApi.list({ kind: wantKind });
                setBoards(result.items);
            } catch (e) {
                setError(e instanceof Error ? e.message : "加载失败");
            } finally {
                setLoading(false);
            }
        },
        [kind],
    );

    useEffect(() => {
        // kind 切换只清掉与当前 tab 类型不符的选中（转白板跳转时先改 kind
        // 再 setSelected，effect 里保留同类型选中才不会把新板清掉）。
        setSelected((prev) => (prev && prev.kind !== kind ? null : prev));
        void refreshList(kind);
    }, [kind, refreshList]);

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

    const isBoard = kind === "whiteboard";
    const noun = isBoard ? "白板" : "导图";

    // Google Drive 惯例：新建即创建"未命名"并打开。
    const handleCreate = async () => {
        if (creating) return;
        setCreating(true);
        try {
            const meta = await boardsApi.create({
                title: `未命名${noun}`,
                kind,
            });
            await refreshList();
            setSelected(meta);
        } catch (e) {
            setError(e instanceof Error ? e.message : "创建失败");
        } finally {
            setCreating(false);
        }
    };

    // ── 导入：.md 标题/列表层级 → 树；.xmind 经库解析 → 树 ──────────────
    const handleImportFiles = async (files: FileList): Promise<void> => {
        const file = files[0];
        if (file === undefined) return;
        setImporting(true);
        try {
            const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
            let tree: ReturnType<typeof transformMarkdownTo> | undefined;
            if (ext === "xmind") {
                tree = await xmindParser.parseXmindFile(file, false);
            } else if (ext === "md" || ext === "markdown") {
                tree = transformMarkdownTo(await file.text());
            } else {
                throw new Error("仅支持 .md / .markdown / .xmind 文件");
            }
            if (tree === undefined || tree.data === undefined) {
                throw new Error("文件内容解析不出导图结构");
            }
            const baseName =
                file.name.replace(/\.[^.]+$/, "").slice(0, 60) || "导入的导图";
            const meta = await createMindMap(baseName, "mindmap");
            await saveMindMap(meta.id, baseName, { root: tree });
            await refreshList();
            const row = boards.find((b) => b.uuid === meta.id) ?? null;
            if (row !== null) setSelected(row);
            else setSelected({ ...meta, uuid: meta.id, version: 1, isPinned: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as BoardMeta);
        } catch (e) {
            setError(e instanceof Error ? e.message : "导入失败");
        } finally {
            setImporting(false);
        }
    };

    /** 转白板完成后打开新板（编辑器回调）：拉一次详情并选中。 */
    const handleOpenBoard = useCallback(
        async (id: string) => {
            try {
                const meta = await boardsApi.get(id);
                setKind("whiteboard");
                setSelected(meta);
            } catch (e) {
                setError(e instanceof Error ? e.message : "打开白板失败");
            }
        },
        [],
    );

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
                {/* ── 左侧栏：kind 切换 + 搜索 + 新建 + 文件列表 ─────────── */}
                <aside className="flex w-80 shrink-0 flex-col border-r border-border-subtle bg-surface">
                    <div className="flex items-baseline gap-2 px-5 pb-3 pt-4">
                        <h1 className="text-[15px] font-medium tracking-tight">知识导图</h1>
                        <span className="text-xs text-tertiary">{boards.length}</span>
                    </div>

                    {/* 导图 / 白板 kind 切换（桌面端同款分段控件） */}
                    <div className="px-4 pb-3">
                        <div
                            role="tablist"
                            aria-label="对象类型"
                            className="flex rounded-full bg-border-subtle p-1"
                        >
                            {(
                                [
                                    { kind: "mindmap" as BoardKind, label: "导图", icon: Network },
                                    { kind: "whiteboard" as BoardKind, label: "白板", icon: PenTool },
                                ]
                            ).map((tab) => (
                                <button
                                    key={tab.kind}
                                    role="tab"
                                    aria-selected={kind === tab.kind}
                                    onClick={() => setKind(tab.kind)}
                                    className={cn(
                                        "flex h-8 flex-1 items-center justify-center gap-1.5 rounded-full text-[13px] transition-colors",
                                        kind === tab.kind
                                            ? "bg-surface font-medium text-foreground shadow-sm"
                                            : "text-secondary hover:text-foreground"
                                    )}
                                >
                                    <tab.icon className="h-3.5 w-3.5" />
                                    {tab.label}
                                </button>
                            ))}
                        </div>
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
                                placeholder={`搜索${noun}`}
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

                    {/* Filled 新建按钮（Google primary button）+ 导入 */}
                    <div className="flex gap-2 px-4 pb-3">
                        <button
                            onClick={() => void handleCreate()}
                            disabled={creating}
                            className={cn(
                                "flex h-10 flex-1 items-center justify-center gap-2 rounded-full bg-accent text-[13px] font-medium text-accent-foreground shadow-sm transition-all",
                                "hover:bg-accent-hover hover:shadow active:shadow-none disabled:opacity-60"
                            )}
                        >
                            <Plus className="h-4 w-4" />
                            新建{noun}
                        </button>
                        {!isBoard && (
                            <button
                                onClick={() => importInputRef.current?.click()}
                                disabled={importing}
                                title="导入 .md / .xmind 文件转成导图"
                                className={cn(
                                    "flex h-10 items-center justify-center gap-2 rounded-full border border-border bg-surface px-3.5 text-[13px] font-medium text-accent shadow-sm transition-colors hover:bg-accent-soft",
                                    "disabled:opacity-60"
                                )}
                            >
                                <Upload className="h-4 w-4" />
                                {importing ? "导入中…" : "导入"}
                            </button>
                        )}
                    </div>

                    {/* 文件列表：tonal 选中态 + 胶囊行 */}
                    <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
                        {loading ? (
                            <div className="px-4 py-10 text-center text-[13px] text-secondary">加载中…</div>
                        ) : filtered.length === 0 ? (
                            <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
                                {isBoard ? (
                                    <PenTool className="h-8 w-8 text-tertiary" strokeWidth={1.5} />
                                ) : (
                                    <Network className="h-8 w-8 text-tertiary" strokeWidth={1.5} />
                                )}
                                <p className="text-[13px] text-secondary">
                                    {query ? `没有匹配的${noun}` : `还没有${noun}`}
                                </p>
                                {!query && <p className="text-xs text-tertiary">点击上方「新建{noun}」开始</p>}
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
                                                {b.kind === "whiteboard" ? (
                                                    <PenTool
                                                        className={cn(
                                                            "h-4 w-4 shrink-0",
                                                            active ? "text-accent" : "text-tertiary"
                                                        )}
                                                    />
                                                ) : (
                                                    <Network
                                                        className={cn(
                                                            "h-4 w-4 shrink-0",
                                                            active ? "text-accent" : "text-tertiary"
                                                        )}
                                                    />
                                                )}
                                                <div className="min-w-0 flex-1">
                                                    <div
                                                        className={cn(
                                                            "truncate text-[13px]",
                                                            active ? "font-medium text-accent" : "text-foreground"
                                                        )}
                                                    >
                                                        {b.title || `未命名${b.kind === "whiteboard" ? "白板" : "导图"}`}
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

                {/* ── 右侧：完整编辑器（导图/白板按 board kind 内部分发） ── */}
                <section className="relative flex min-w-0 flex-1 flex-col bg-background">
                    {error && (
                        <div className="bg-danger/10 px-5 py-2 text-[13px] text-danger">{error}</div>
                    )}
                    {selected === null ? (
                        <div className="flex h-full flex-col items-center justify-center gap-3 bg-border-subtle">
                            {isBoard ? (
                                <PenTool className="h-12 w-12 text-tertiary" strokeWidth={1} />
                            ) : (
                                <Network className="h-12 w-12 text-tertiary" strokeWidth={1} />
                            )}
                            <p className="text-sm text-secondary">从左侧选择一个{noun}</p>
                            <button
                                onClick={() => void handleCreate()}
                                className="flex h-9 items-center gap-2 rounded-full border border-border bg-surface px-4 text-[13px] font-medium text-accent shadow-sm transition-colors hover:bg-accent-soft"
                            >
                                <Plus className="h-4 w-4" />
                                新建{noun}
                            </button>
                        </div>
                    ) : (
                        <MindMapEditorView
                            key={selected.uuid}
                            mapId={selected.uuid}
                            onExit={() => setSelected(null)}
                            onOpenBoard={(id) => void handleOpenBoard(id)}
                        />
                    )}
                </section>

                <ConfirmDialog
                    open={confirmDelete !== null}
                    title={`删除${confirmDelete?.kind === "whiteboard" ? "白板" : "导图"}`}
                    message={
                        confirmDelete
                            ? `确定删除「${confirmDelete.title || "未命名"}」吗？内容会一并删除，不可恢复。`
                            : ""
                    }
                    confirmLabel="删除"
                    danger
                    busy={deleting}
                    onConfirm={() => void handleDelete()}
                    onCancel={() => setConfirmDelete(null)}
                />

                <input
                    ref={importInputRef}
                    type="file"
                    accept=".md,.markdown,.xmind"
                    style={{ display: "none" }}
                    onChange={(event) => {
                        const files = event.target.files;
                        event.target.value = "";
                        if (files !== null && files.length > 0) void handleImportFiles(files);
                    }}
                />
            </div>
        </ToastProvider>
    );
}
