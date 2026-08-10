"use client";

/**
 * Folder sidebar - recursive folder tree + inline create + delete.
 *
 * Apple Finder sidebar feel: a "全部文件" root entry, then a collapsible
 * nested tree. Active folder = accent-soft + accent text; hover reveals a
 * delete affordance. Creating a folder shows an inline input at the top of
 * the tree. A footer shows the total file count across all folders.
 */
import { useState, useRef, useEffect } from "react";
import {
    Cloud,
    Folder,
    FolderPlus,
    ChevronRight,
    ChevronDown,
    Trash2,
    Loader2,
    X,
} from "lucide-react";
import type { CloudFolderTreeItem } from "@/lib/api/cloud";
import { cn } from "@/lib/utils";

interface FolderSidebarProps {
    folders: CloudFolderTreeItem[];
    loading: boolean;
    selectedFolderId: number | null;
    totalCount: number;
    onSelect: (id: number | null) => void;
    onCreateFolder: (name: string) => Promise<void>;
    onDeleteFolder: (folder: CloudFolderTreeItem) => void;
}

export function FolderSidebar({
    folders,
    loading,
    selectedFolderId,
    totalCount,
    onSelect,
    onCreateFolder,
    onDeleteFolder,
}: FolderSidebarProps) {
    const [creating, setCreating] = useState(false);
    const [draftName, setDraftName] = useState("");
    const [busy, setBusy] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (creating) inputRef.current?.focus();
    }, [creating]);

    const submitCreate = async () => {
        const name = draftName.trim();
        if (!name || busy) return;
        setBusy(true);
        try {
            await onCreateFolder(name);
            setCreating(false);
            setDraftName("");
        } catch {
            // Keep the input open so the error is visible.
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="flex h-full flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-4 pb-2 pt-4">
                <h2 className="text-[13px] font-semibold text-foreground">位置</h2>
                <button
                    type="button"
                    onClick={() => setCreating((v) => !v)}
                    title="新建文件夹"
                    aria-label="新建文件夹"
                    className="grid h-7 w-7 place-items-center rounded-full text-secondary transition-colors hover:bg-border-subtle hover:text-foreground"
                >
                    <FolderPlus className="h-[18px] w-[18px]" />
                </button>
            </div>

            {/* Tree */}
            <nav className="flex-1 overflow-y-auto px-2 pb-2">
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

                {/* Inline create input */}
                {creating && (
                    <div className="mt-0.5 flex items-center gap-2 rounded-[10px] bg-accent-soft px-2.5 py-1.5">
                        <Folder className="h-4 w-4 shrink-0 text-accent" />
                        <input
                            ref={inputRef}
                            value={draftName}
                            onChange={(e) => setDraftName(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") void submitCreate();
                                if (e.key === "Escape") {
                                    setCreating(false);
                                    setDraftName("");
                                }
                            }}
                            placeholder="文件夹名称"
                            className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-tertiary"
                        />
                        {busy ? (
                            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent" />
                        ) : (
                            <button
                                type="button"
                                onClick={() => {
                                    setCreating(false);
                                    setDraftName("");
                                }}
                                className="shrink-0 text-tertiary hover:text-foreground"
                            >
                                <X className="h-3.5 w-3.5" />
                            </button>
                        )}
                    </div>
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

                {/* Recursive tree */}
                {!loading &&
                    folders.map((folder) => (
                        <FolderNode
                            key={folder.id}
                            folder={folder}
                            depth={0}
                            selectedFolderId={selectedFolderId}
                            onSelect={onSelect}
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

function FolderNode({
    folder,
    depth,
    selectedFolderId,
    onSelect,
    onDeleteFolder,
}: {
    folder: CloudFolderTreeItem;
    depth: number;
    selectedFolderId: number | null;
    onSelect: (id: number | null) => void;
    onDeleteFolder: (folder: CloudFolderTreeItem) => void;
}) {
    const [open, setOpen] = useState(true);
    const hasChildren = folder.children.length > 0;
    const active = selectedFolderId === folder.id;

    return (
        <div>
            <div
                className={cn(
                    "group flex items-center gap-1 rounded-[10px] pr-1 transition-colors",
                    active ? "bg-accent-soft" : "hover:bg-border-subtle/70"
                )}
                style={{ paddingLeft: depth * 12 + 4 }}
            >
                <button
                    type="button"
                    onClick={() => hasChildren && setOpen((v) => !v)}
                    className={cn(
                        "grid h-6 w-5 shrink-0 place-items-center text-tertiary",
                        !hasChildren && "invisible"
                    )}
                >
                    {open ? (
                        <ChevronDown className="h-3.5 w-3.5" />
                    ) : (
                        <ChevronRight className="h-3.5 w-3.5" />
                    )}
                </button>
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
                <button
                    type="button"
                    onClick={(e) => {
                        e.stopPropagation();
                        onDeleteFolder(folder);
                    }}
                    title="删除文件夹"
                    aria-label="删除文件夹"
                    className={cn(
                        "grid h-6 w-6 shrink-0 place-items-center rounded-full text-tertiary transition-colors hover:bg-danger/10 hover:text-danger",
                        active ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                    )}
                >
                    <Trash2 className="h-3.5 w-3.5" />
                </button>
            </div>
            {hasChildren && open && (
                <div>
                    {folder.children.map((child) => (
                        <FolderNode
                            key={child.id}
                            folder={child}
                            depth={depth + 1}
                            selectedFolderId={selectedFolderId}
                            onSelect={onSelect}
                            onDeleteFolder={onDeleteFolder}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}
