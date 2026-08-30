"use client";

/**
 * Folder sidebar - recursive folder tree with full CRUD.
 *
 * Apple Finder sidebar feel: a "全部文件" root entry, then a collapsible
 * nested tree. Active folder = accent-soft + accent text; hover reveals the
 * action group (new subfolder / rename / delete). Creating shows an inline
 * input under the target node (or at the tree top for the root); renaming
 * swaps the row's name for an inline input.
 *
 * State ownership:
 *  - expanded/collapsed: lifted here (persisted to localStorage); selection
 *    changes auto-expand the ancestor chain and scroll the row into view.
 *  - drafts (create/rename input text): local to the node rendering them.
 */
import { useState, useRef, useEffect, useCallback } from "react";
import {
    Cloud,
    Folder,
    FolderPlus,
    ChevronRight,
    ChevronDown,
    Trash2,
    Pencil,
    Loader2,
    X,
    FolderOpen,
} from "lucide-react";
import type { CloudFolderTreeItem } from "@/lib/api/cloud";
import { cn } from "@/lib/utils";

const COLLAPSED_KEY = "cloud-drive:collapsed-folders";

interface FolderSidebarProps {
    folders: CloudFolderTreeItem[];
    loading: boolean;
    selectedFolderId: number | null;
    totalCount: number;
    onSelect: (id: number | null) => void;
    onCreateFolder: (name: string, parentId: number | null) => Promise<void>;
    onRenameFolder: (id: number, name: string) => Promise<void>;
    onDeleteFolder: (folder: CloudFolderTreeItem) => void;
}

function readCollapsed(): Set<number> {
    if (typeof window === "undefined") return new Set();
    try {
        const raw = window.localStorage.getItem(COLLAPSED_KEY);
        const arr = raw ? (JSON.parse(raw) as number[]) : [];
        return new Set(Array.isArray(arr) ? arr : []);
    } catch {
        return new Set();
    }
}

/** Ancestor ids on the path to targetId (empty when target not found). */
function findAncestors(
    folders: CloudFolderTreeItem[],
    targetId: number,
    trail: number[] = []
): number[] {
    for (const folder of folders) {
        if (folder.id === targetId) return trail;
        const hit = findAncestors(folder.children, targetId, [...trail, folder.id]);
        if (hit.length > 0 || folder.children.some((c) => c.id === targetId)) {
            if (hit.length > 0) return hit;
            return [...trail, folder.id];
        }
    }
    return [];
}

export function FolderSidebar({
    folders,
    loading,
    selectedFolderId,
    totalCount,
    onSelect,
    onCreateFolder,
    onRenameFolder,
    onDeleteFolder,
}: FolderSidebarProps) {
    const [collapsed, setCollapsed] = useState<Set<number>>(() => readCollapsed());
    // null = none; { parentId: null } = root-level create.
    const [createTarget, setCreateTarget] = useState<{ parentId: number | null } | null>(null);
    const [renamingId, setRenamingId] = useState<number | null>(null);
    const navRef = useRef<HTMLElement>(null);

    // Persist collapsed ids.
    useEffect(() => {
        try {
            window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
        } catch {
            // Storage unavailable - expansion just won't persist.
        }
    }, [collapsed]);

    // Selection (including a restored one from localStorage) must reveal its
    // folder: expand ancestors and scroll the row into view.
    useEffect(() => {
        if (selectedFolderId == null) return;
        const ancestors = findAncestors(folders, selectedFolderId);
        if (ancestors.length === 0) return;
        setCollapsed((prev) => {
            const next = new Set(prev);
            let changed = false;
            for (const id of ancestors) {
                if (next.delete(id)) changed = true;
            }
            return changed ? next : prev;
        });
    }, [selectedFolderId, folders]);

    useEffect(() => {
        if (selectedFolderId == null || loading) return;
        navRef.current
            ?.querySelector(`[data-folder-id="${selectedFolderId}"]`)
            ?.scrollIntoView({ block: "nearest" });
    }, [selectedFolderId, folders, loading, collapsed]);

    const toggle = useCallback((id: number) => {
        setCollapsed((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    return (
        <div className="flex h-full flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-4 pb-2 pt-4">
                <h2 className="text-[13px] font-semibold text-foreground">位置</h2>
                <button
                    type="button"
                    onClick={() => {
                        setRenamingId(null);
                        setCreateTarget({ parentId: null });
                    }}
                    title="新建文件夹"
                    aria-label="新建文件夹"
                    className="grid h-7 w-7 place-items-center rounded-full text-secondary transition-colors hover:bg-border-subtle hover:text-foreground"
                >
                    <FolderPlus className="h-[18px] w-[18px]" />
                </button>
            </div>

            {/* Tree */}
            <nav ref={navRef} className="flex-1 overflow-y-auto px-2 pb-2">
                {/* All files root */}
                <button
                    type="button"
                    onClick={() => onSelect(null)}
                    className={cn(
                        "flex w-full items-center gap-2 rounded-[10px] px-2.5 py-1.5 text-[13px] transition-colors",
                        selectedFolderId === null
                            ? "bg-accent-soft font-medium text-accent"
                            : "text-foreground hover:bg-border-subtle/70"
                    )}
                >
                    <Cloud className="h-4 w-4 shrink-0" />
                    <span className="truncate">全部文件</span>
                </button>

                {/* Root-level inline create input */}
                {createTarget?.parentId === null && (
                    <InlineCreateInput
                        depth={0}
                        onCancel={() => setCreateTarget(null)}
                        onSubmit={async (name) => {
                            await onCreateFolder(name, null);
                            setCreateTarget(null);
                        }}
                    />
                )}

                {/* Loading */}
                {loading && (
                    <div className="space-y-1 px-1 pt-2">
                        {Array.from({ length: 3 }).map((_, i) => (
                            <div
                                key={i}
                                className="h-7 w-full animate-pulse rounded-[10px] bg-border-subtle"
                            />
                        ))}
                    </div>
                )}

                {/* Empty state */}
                {!loading && folders.length === 0 && (
                    <div className="flex flex-col items-center gap-1.5 px-3 pt-6 text-center">
                        <FolderOpen className="h-6 w-6 text-tertiary" />
                        <p className="text-[12px] text-tertiary">
                            还没有文件夹
                            <br />
                            点击右上角新建
                        </p>
                    </div>
                )}

                {/* Recursive tree */}
                {!loading &&
                    folders.map((folder) => (
                        <FolderNode
                            key={folder.id}
                            folder={folder}
                            depth={0}
                            collapsed={collapsed}
                            onToggle={toggle}
                            selectedFolderId={selectedFolderId}
                            onSelect={onSelect}
                            createTarget={createTarget}
                            setCreateTarget={setCreateTarget}
                            renamingId={renamingId}
                            setRenamingId={setRenamingId}
                            onCreateFolder={onCreateFolder}
                            onRenameFolder={onRenameFolder}
                            onDeleteFolder={onDeleteFolder}
                        />
                    ))}
            </nav>

            {/* Footer */}
            <div className="border-t border-border-subtle px-4 py-2.5 text-[11px] text-tertiary">
                共 {totalCount} 个文件
            </div>
        </div>
    );
}

/** Indented inline input used for both root-level and in-folder creation. */
function InlineCreateInput({
    depth,
    onCancel,
    onSubmit,
}: {
    depth: number;
    onCancel: () => void;
    onSubmit: (name: string) => Promise<void>;
}) {
    const [draftName, setDraftName] = useState("");
    const [busy, setBusy] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    const submit = async () => {
        const name = draftName.trim();
        if (!name || busy) return;
        setBusy(true);
        try {
            await onSubmit(name);
        } catch {
            // Keep the input open so the error is visible.
        } finally {
            setBusy(false);
        }
    };

    return (
        <div
            className="mt-0.5 flex items-center gap-2 rounded-[10px] bg-accent-soft px-2.5 py-1.5"
            style={{ marginLeft: depth * 12 + 4 }}
        >
            <Folder className="h-4 w-4 shrink-0 text-accent" />
            <input
                ref={inputRef}
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === "Enter") void submit();
                    if (e.key === "Escape") onCancel();
                }}
                maxLength={80}
                placeholder="文件夹名称"
                className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-tertiary"
            />
            {busy ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
            ) : (
                <button
                    type="button"
                    onClick={onCancel}
                    className="shrink-0 text-tertiary hover:text-foreground"
                    aria-label="取消"
                >
                    <X className="h-3.5 w-3.5" />
                </button>
            )}
        </div>
    );
}

function FolderNode({
    folder,
    depth,
    collapsed,
    onToggle,
    selectedFolderId,
    onSelect,
    createTarget,
    setCreateTarget,
    renamingId,
    setRenamingId,
    onCreateFolder,
    onRenameFolder,
    onDeleteFolder,
}: {
    folder: CloudFolderTreeItem;
    depth: number;
    collapsed: Set<number>;
    onToggle: (id: number) => void;
    selectedFolderId: number | null;
    onSelect: (id: number | null) => void;
    createTarget: { parentId: number | null } | null;
    setCreateTarget: (t: { parentId: number | null } | null) => void;
    renamingId: number | null;
    setRenamingId: (id: number | null) => void;
    onCreateFolder: (name: string, parentId: number | null) => Promise<void>;
    onRenameFolder: (id: number, name: string) => Promise<void>;
    onDeleteFolder: (folder: CloudFolderTreeItem) => void;
}) {
    const hasChildren = folder.children.length > 0;
    const active = selectedFolderId === folder.id;
    const open = !collapsed.has(folder.id);
    const renaming = renamingId === folder.id;
    const creatingHere = createTarget?.parentId === folder.id;
    const [renameDraft, setRenameDraft] = useState("");
    const [renameBusy, setRenameBusy] = useState(false);
    const renameInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (renaming) {
            setRenameDraft(folder.name);
            renameInputRef.current?.focus();
            renameInputRef.current?.select();
        }
    }, [renaming, folder.name]);

    const submitRename = async () => {
        const name = renameDraft.trim();
        if (!name || renameBusy || name === folder.name) {
            setRenamingId(null);
            return;
        }
        setRenameBusy(true);
        try {
            await onRenameFolder(folder.id, name);
            setRenamingId(null);
        } catch {
            // Keep the input open so the error is visible.
        } finally {
            setRenameBusy(false);
        }
    };

    return (
        <div>
            <div
                data-folder-id={folder.id}
                className={cn(
                    "group flex items-center gap-1 rounded-[10px] pr-1 transition-colors",
                    active ? "bg-accent-soft" : "hover:bg-border-subtle/70"
                )}
                style={{ paddingLeft: depth * 12 + 4 }}
            >
                <button
                    type="button"
                    onClick={() => hasChildren && onToggle(folder.id)}
                    aria-expanded={hasChildren ? open : undefined}
                    className={cn(
                        "grid h-6 w-5 shrink-0 place-items-center text-tertiary transition-transform",
                        !hasChildren && "invisible"
                    )}
                >
                    {open ? (
                        <ChevronDown className="h-3.5 w-3.5" />
                    ) : (
                        <ChevronRight className="h-3.5 w-3.5" />
                    )}
                </button>

                {renaming ? (
                    <div className="flex min-w-0 flex-1 items-center gap-2 py-1.5">
                        <Folder className="h-4 w-4 shrink-0 text-accent" />
                        <input
                            ref={renameInputRef}
                            value={renameDraft}
                            disabled={renameBusy}
                            onChange={(e) => setRenameDraft(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") void submitRename();
                                if (e.key === "Escape") setRenamingId(null);
                            }}
                            maxLength={80}
                            className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none"
                        />
                        {renameBusy ? (
                            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
                        ) : (
                            <button
                                type="button"
                                onClick={() => setRenamingId(null)}
                                className="shrink-0 text-tertiary hover:text-foreground"
                                aria-label="取消重命名"
                            >
                                <X className="h-3.5 w-3.5" />
                            </button>
                        )}
                    </div>
                ) : (
                    <>
                        <button
                            type="button"
                            onClick={() => onSelect(folder.id)}
                            className={cn(
                                "flex min-w-0 flex-1 items-center gap-2 py-1.5 text-[13px]",
                                active ? "font-medium text-accent" : "text-foreground"
                            )}
                        >
                            <Folder
                                className={cn(
                                    "h-4 w-4 shrink-0",
                                    active ? "text-accent" : "text-secondary"
                                )}
                            />
                            <span className="truncate">{folder.name}</span>
                            {folder.videoCount > 0 && (
                                <span className="ml-auto shrink-0 text-[11px] tabular-nums text-tertiary">
                                    {folder.videoCount}
                                </span>
                            )}
                        </button>
                        {/* Hover action group: create subfolder / rename / delete */}
                        <div
                            className={cn(
                                "flex shrink-0 items-center",
                                active ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                            )}
                        >
                            <button
                                type="button"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setRenamingId(null);
                                    setCreateTarget({ parentId: folder.id });
                                }}
                                title="新建子文件夹"
                                aria-label={`在 ${folder.name} 中新建文件夹`}
                                className="grid h-6 w-6 place-items-center rounded-full text-tertiary transition-colors hover:bg-accent-soft hover:text-accent"
                            >
                                <FolderPlus className="h-3.5 w-3.5" />
                            </button>
                            <button
                                type="button"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setCreateTarget(null);
                                    setRenamingId(folder.id);
                                }}
                                title="重命名"
                                aria-label={`重命名 ${folder.name}`}
                                className="grid h-6 w-6 place-items-center rounded-full text-tertiary transition-colors hover:bg-border-subtle hover:text-foreground"
                            >
                                <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button
                                type="button"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onDeleteFolder(folder);
                                }}
                                title="删除文件夹"
                                aria-label={`删除 ${folder.name}`}
                                className="grid h-6 w-6 place-items-center rounded-full text-tertiary transition-colors hover:bg-danger/10 hover:text-danger"
                            >
                                <Trash2 className="h-3.5 w-3.5" />
                            </button>
                        </div>
                    </>
                )}
            </div>

            {/* Inline create input for a subfolder of THIS node */}
            {creatingHere && (
                <InlineCreateInput
                    depth={depth + 1}
                    onCancel={() => setCreateTarget(null)}
                    onSubmit={async (name) => {
                        await onCreateFolder(name, folder.id);
                    }}
                />
            )}

            {hasChildren && open && (
                <div>
                    {folder.children.map((child) => (
                        <FolderNode
                            key={child.id}
                            folder={child}
                            depth={depth + 1}
                            collapsed={collapsed}
                            onToggle={onToggle}
                            selectedFolderId={selectedFolderId}
                            onSelect={onSelect}
                            createTarget={createTarget}
                            setCreateTarget={setCreateTarget}
                            renamingId={renamingId}
                            setRenamingId={setRenamingId}
                            onCreateFolder={onCreateFolder}
                            onRenameFolder={onRenameFolder}
                            onDeleteFolder={onDeleteFolder}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}
