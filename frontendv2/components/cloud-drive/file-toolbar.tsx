"use client";

/**
 * Cloud drive toolbar - sticky, frosted.
 *
 * Left: current folder title. Right: sort dropdown + list/grid segmented
 * control (framer-motion sliding indicator, same pattern as the note editor)
 * + upload button. Sticks to the top of the main pane with a blur veil so
 * content scrolls beneath, matching Apple Finder / iCloud Drive.
 */
import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { List, LayoutGrid, ArrowUpDown, CloudUpload, Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export type ViewMode = "list" | "grid";
export type SortField = "original_name" | "file_size" | "created_at";
export type SortOrder = "asc" | "desc";

interface FileToolbarProps {
    title: string;
    view: ViewMode;
    onViewChange: (v: ViewMode) => void;
    sort: SortField;
    order: SortOrder;
    onSortChange: (field: SortField, order: SortOrder) => void;
    onUploadClick: () => void;
    uploading: boolean;
}

const SORT_LABELS: Record<SortField, string> = {
    original_name: "名称",
    file_size: "大小",
    created_at: "添加时间",
};

export function FileToolbar({
    title,
    view,
    onViewChange,
    sort,
    order,
    onSortChange,
    onUploadClick,
    uploading,
}: FileToolbarProps) {
    const [sortOpen, setSortOpen] = useState(false);
    const sortRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!sortOpen) return;
        const onDoc = (e: MouseEvent) => {
            if (sortRef.current && !sortRef.current.contains(e.target as Node)) {
                setSortOpen(false);
            }
        };
        document.addEventListener("mousedown", onDoc);
        return () => document.removeEventListener("mousedown", onDoc);
    }, [sortOpen]);

    return (
        <div className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-border-subtle bg-background/75 px-5 py-2.5 backdrop-blur-xl">
            {/* Title */}
            <h1 className="min-w-0 truncate text-[17px] font-semibold tracking-tight text-foreground">
                {title}
            </h1>

            {/* Actions */}
            <div className="flex items-center gap-2">
                {/* Sort */}
                <div ref={sortRef} className="relative">
                    <button
                        type="button"
                        onClick={() => setSortOpen((v) => !v)}
                        title="排序"
                        className="flex items-center gap-1 rounded-full px-2.5 py-1.5 text-[12px] text-secondary transition-colors hover:bg-border-subtle hover:text-foreground"
                    >
                        <ArrowUpDown className="h-3.5 w-3.5" />
                        <span className="hidden sm:inline">{SORT_LABELS[sort]}</span>
                    </button>
                    <AnimatePresence>
                        {sortOpen && (
                            <motion.div
                                initial={{ opacity: 0, y: -4, scale: 0.97 }}
                                animate={{ opacity: 1, y: 0, scale: 1 }}
                                exit={{ opacity: 0, y: -4, scale: 0.97 }}
                                transition={{ duration: 0.14 }}
                                className="absolute right-0 top-full mt-1.5 w-44 overflow-hidden rounded-xl border border-border bg-surface py-1 shadow-[0_8px_28px_rgba(0,0,0,0.10)]"
                            >
                                {(Object.keys(SORT_LABELS) as SortField[]).map((field) => (
                                    <button
                                        key={field}
                                        type="button"
                                        onClick={() => {
                                            onSortChange(
                                                field,
                                                sort === field && order === "asc" ? "desc" : "asc"
                                            );
                                            setSortOpen(false);
                                        }}
                                        className={cn(
                                            "flex w-full items-center justify-between px-3 py-1.5 text-[13px] transition-colors hover:bg-border-subtle",
                                            sort === field ? "text-accent" : "text-foreground"
                                        )}
                                    >
                                        <span>{SORT_LABELS[field]}</span>
                                        {sort === field && (
                                            <span className="text-[10px] text-tertiary">
                                                {order === "asc" ? "升序" : "降序"}
                                            </span>
                                        )}
                                    </button>
                                ))}
                                <div className="my-1 border-t border-border-subtle" />
                                <button
                                    type="button"
                                    onClick={() => {
                                        onSortChange(sort, order === "asc" ? "desc" : "asc");
                                        setSortOpen(false);
                                    }}
                                    className="flex w-full items-center gap-2 px-3 py-1.5 text-[13px] text-foreground transition-colors hover:bg-border-subtle"
                                >
                                    <Check
                                        className={cn(
                                            "h-3.5 w-3.5",
                                            order === "asc" ? "text-accent" : "text-transparent"
                                        )}
                                    />
                                    升序
                                </button>
                                <button
                                    type="button"
                                    onClick={() => {
                                        onSortChange(sort, "desc");
                                        setSortOpen(false);
                                    }}
                                    className="flex w-full items-center gap-2 px-3 py-1.5 text-[13px] text-foreground transition-colors hover:bg-border-subtle"
                                >
                                    <Check
                                        className={cn(
                                            "h-3.5 w-3.5",
                                            order === "desc" ? "text-accent" : "text-transparent"
                                        )}
                                    />
                                    降序
                                </button>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>

                {/* View toggle */}
                <div className="flex items-center gap-0.5 rounded-[10px] bg-border-subtle/70 p-0.5">
                    <SegBtn
                        active={view === "list"}
                        onClick={() => onViewChange("list")}
                        icon={<List className="h-3.5 w-3.5" />}
                        label="列表"
                    />
                    <SegBtn
                        active={view === "grid"}
                        onClick={() => onViewChange("grid")}
                        icon={<LayoutGrid className="h-3.5 w-3.5" />}
                        label="网格"
                    />
                </div>

                {/* Upload */}
                <button
                    type="button"
                    onClick={onUploadClick}
                    disabled={uploading}
                    className="btn-pill btn-primary h-8 px-3.5 text-[12px]"
                >
                    {uploading ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                        <CloudUpload className="h-3.5 w-3.5" />
                    )}
                    <span className="hidden sm:inline">上传</span>
                </button>
            </div>
        </div>
    );
}

function SegBtn({
    active,
    onClick,
    icon,
    label,
}: {
    active: boolean;
    onClick: () => void;
    icon: React.ReactNode;
    label: string;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={active}
            className={cn(
                "relative inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors duration-200",
                active ? "text-foreground" : "text-secondary hover:text-foreground"
            )}
        >
            {active && (
                <motion.span
                    layoutId="cloud-view-active"
                    className="absolute inset-0 rounded-md bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.10),0_0_0_0.5px_rgba(0,0,0,0.05)]"
                    transition={{ type: "spring", stiffness: 420, damping: 34, mass: 0.6 }}
                />
            )}
            <span className="relative z-10 flex items-center gap-1.5">
                {icon}
                <span className="hidden sm:inline">{label}</span>
            </span>
        </button>
    );
}
