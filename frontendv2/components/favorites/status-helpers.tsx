"use client";

/**
 * Shared presentational helpers for the favorites view.
 *
 * Pure / stateless: status badges, vector-status dots, and small formatters.
 * Kept here so folder-card / video-list / page-list all render status
 * consistently and Apple-clean (subtle pills + colored dots, never loud).
 */
import { cn } from "@/lib/utils";

// ══════════════════════════════════════════════════════════════
// Folder-level indexing status (derived from FolderStatus)
// ══════════════════════════════════════════════════════════════

export type FolderStatusKind = "indexed" | "partial" | "none";

export interface DerivedFolderStatus {
    kind: FolderStatusKind;
    label: string;
    indexed: number;
    total: number;
}

/**
 * Derive a folder's indexing status from its FolderStatus counters.
 * - never synced        -> none   ("未入库")
 * - fully indexed       -> indexed ("已入库")
 * - partially indexed   -> partial ("待入库")
 */
export function deriveFolderStatus(
    indexed: number | undefined,
    total: number,
    lastSync: string | null | undefined
): DerivedFolderStatus {
    const idx = indexed ?? 0;
    if (!lastSync) {
        return { kind: "none", label: "未入库", indexed: idx, total };
    }
    if (idx >= total && total > 0) {
        return { kind: "indexed", label: "已入库", indexed: idx, total };
    }
    if (idx > 0) {
        return { kind: "partial", label: "待入库", indexed: idx, total };
    }
    return { kind: "none", label: "未入库", indexed: idx, total };
}

const FOLDER_STATUS_STYLES: Record<FolderStatusKind, string> = {
    indexed: "bg-success/10 text-success",
    partial: "bg-warning/10 text-warning",
    none: "bg-border-subtle text-secondary",
};

export function FolderStatusBadge({ status }: { status: DerivedFolderStatus }) {
    return (
        <span
            className={cn(
                "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium tracking-tight",
                FOLDER_STATUS_STYLES[status.kind]
            )}
        >
            {status.label}
        </span>
    );
}

// ══════════════════════════════════════════════════════════════
// Page-level vector status
// ══════════════════════════════════════════════════════════════

export type VectorState = "pending" | "processing" | "done" | "failed";

export interface VectorStatusMeta {
    label: string;
    dotClass: string;
    textClass: string;
}

const VECTOR_STATUS_META: Record<VectorState, VectorStatusMeta> = {
    done: { label: "已向量化", dotClass: "bg-success", textClass: "text-success" },
    processing: { label: "处理中", dotClass: "bg-warning animate-pulse", textClass: "text-warning" },
    pending: { label: "待向量化", dotClass: "bg-tertiary", textClass: "text-secondary" },
    failed: { label: "失败", dotClass: "bg-danger", textClass: "text-danger" },
};

export function VectorStatusDot({ state }: { state: VectorState }) {
    const meta = VECTOR_STATUS_META[state] ?? VECTOR_STATUS_META.pending;
    return (
        <span className="inline-flex items-center gap-1.5 text-[12px]">
            <span className={cn("h-1.5 w-1.5 rounded-full", meta.dotClass)} />
            <span className={cn("tracking-tight", meta.textClass)}>{meta.label}</span>
        </span>
    );
}

/** Compact dot-only variant for dense rows. */
export function VectorStatusDotOnly({ state }: { state: VectorState }) {
    const meta = VECTOR_STATUS_META[state] ?? VECTOR_STATUS_META.pending;
    return <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", meta.dotClass)} title={meta.label} />;
}

// ══════════════════════════════════════════════════════════════
// Formatters
// ══════════════════════════════════════════════════════════════

/** Format seconds as m:ss or h:mm:ss. */
export function formatDuration(seconds: number | null | undefined): string {
    if (!seconds || seconds <= 0) return "--";
    const s = Math.floor(seconds % 60);
    const m = Math.floor((seconds / 60) % 60);
    const h = Math.floor(seconds / 3600);
    const pad = (n: number) => n.toString().padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Format an ISO timestamp as a relative Chinese string. */
export function formatRelativeTime(iso: string | null | undefined): string {
    if (!iso) return "";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    const now = Date.now();
    const diff = now - date.getTime();
    const min = Math.floor(diff / 60000);
    const hour = Math.floor(diff / 3600000);
    const day = Math.floor(diff / 86400000);
    if (min < 1) return "刚刚";
    if (min < 60) return `${min} 分钟前`;
    if (hour < 24) return `${hour} 小时前`;
    if (day < 7) return `${day} 天前`;
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
