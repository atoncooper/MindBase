"use client";

/**
 * Folder card - the first level of the favorites drill-down.
 *
 * One row per B站 favorites folder. Two independent tap targets:
 *   - the selection circle (left) -> toggles inclusion in a knowledge build
 *   - the row body / chevron     -> expands the video list
 *
 * Apple-style: solid surface card, generous radius, subtle hairline divider
 * between the header and the expanded video list.
 */
import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Folder, ChevronDown, Check } from "lucide-react";
import type { FavoriteFolderV2 } from "@/lib/api/favorites";
import type { FolderStatus } from "@/lib/api/knowledge";
import { cn } from "@/lib/utils";
import {
    deriveFolderStatus,
    FolderStatusBadge,
    formatRelativeTime,
} from "./status-helpers";
import { VideoList } from "./video-list";

interface FolderCardProps {
    folder: FavoriteFolderV2;
    status?: FolderStatus;
    selected: boolean;
    onToggleSelect: (mediaId: number) => void;
}

export function FolderCard({ folder, status, selected, onToggleSelect }: FolderCardProps) {
    const [expanded, setExpanded] = useState(false);

    const derived = deriveFolderStatus(
        status?.indexed_count,
        folder.media_count,
        folder.last_sync_at
    );

    return (
        <div
            className={cn(
                "overflow-hidden rounded-2xl border bg-surface transition-colors",
                selected ? "border-accent/40 bg-accent-soft/40" : "border-border-subtle hover:border-border"
            )}
        >
            <div className="flex items-center gap-3 px-3.5 py-3">
                {/* Selection circle - independent tap target */}
                <button
                    type="button"
                    onClick={() => onToggleSelect(folder.media_id)}
                    aria-pressed={selected}
                    aria-label={selected ? "取消选择" : "选择此收藏夹"}
                    className={cn(
                        "grid h-5 w-5 shrink-0 place-items-center rounded-full border transition-colors",
                        selected
                            ? "border-accent bg-accent text-white"
                            : "border-border text-transparent hover:border-accent"
                    )}
                >
                    <Check className="h-3 w-3" strokeWidth={3} />
                </button>

                {/* Row body - expands the video list */}
                <button
                    type="button"
                    onClick={() => setExpanded((v) => !v)}
                    aria-expanded={expanded}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                >
                    <span
                        className={cn(
                            "grid h-8 w-8 shrink-0 place-items-center rounded-lg",
                            selected ? "bg-accent-soft text-accent" : "bg-border-subtle text-secondary"
                        )}
                    >
                        <Folder className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                            <p className="truncate text-[14px] font-medium tracking-tight text-foreground">
                                {folder.title}
                            </p>
                            {folder.is_default && (
                                <span className="rounded-full bg-border-subtle px-1.5 py-0.5 text-[10px] text-secondary">
                                    默认
                                </span>
                            )}
                        </div>
                        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-secondary">
                            <span>{folder.media_count} 个视频</span>
                            {folder.last_sync_at && (
                                <span className="hidden sm:inline">
                                    · 同步于 {formatRelativeTime(folder.last_sync_at)}
                                </span>
                            )}
                            {status && (
                                <span className="hidden sm:inline">
                                    · {derived.indexed}/{derived.total} 已入库
                                </span>
                            )}
                        </div>
                    </div>
                    <FolderStatusBadge status={derived} />
                    <ChevronDown
                        className={cn(
                            "h-4 w-4 shrink-0 text-tertiary transition-transform duration-200",
                            expanded && "rotate-180"
                        )}
                    />
                </button>
            </div>

            <AnimatePresence initial={false}>
                {expanded && (
                    <motion.div
                        key="videos"
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.26, ease: [0.28, 0.11, 0.32, 1] }}
                        className="overflow-hidden border-t border-border-subtle"
                    >
                        <VideoList mediaId={folder.media_id} />
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
