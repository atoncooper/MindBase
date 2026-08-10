"use client";

/**
 * Cloud drive status badges.
 *
 * asr_status: pending -> processing -> done / failed (video ASR).
 * vector_status: pending -> processing -> done / failed / not_supported.
 * not_supported is permanent (encrypted/empty PDF, un-vectorizable MIME).
 *
 * Renders as a subtle dot + label, Apple-restrained: never loud.
 */
import { cn } from "@/lib/utils";

interface StatusMeta {
    label: string;
    dotClass: string;
    textClass: string;
}

const ASR_META: Record<string, StatusMeta> = {
    pending: { label: "待转写", dotClass: "bg-tertiary", textClass: "text-secondary" },
    processing: { label: "转写中", dotClass: "bg-warning animate-pulse", textClass: "text-warning" },
    done: { label: "已转写", dotClass: "bg-success", textClass: "text-success" },
    failed: { label: "失败", dotClass: "bg-danger", textClass: "text-danger" },
};

const VECTOR_META: Record<string, StatusMeta> = {
    pending: { label: "待入库", dotClass: "bg-tertiary", textClass: "text-secondary" },
    processing: { label: "入库中", dotClass: "bg-warning animate-pulse", textClass: "text-warning" },
    done: { label: "已入库", dotClass: "bg-success", textClass: "text-success" },
    failed: { label: "失败", dotClass: "bg-danger", textClass: "text-danger" },
    not_supported: { label: "不支持", dotClass: "bg-tertiary", textClass: "text-tertiary" },
};

function StatusDot({ meta }: { meta: StatusMeta }) {
    return (
        <span className="inline-flex items-center gap-1.5 text-[12px]">
            <span className={cn("h-1.5 w-1.5 rounded-full", meta.dotClass)} />
            <span className={cn("tracking-tight", meta.textClass)}>{meta.label}</span>
        </span>
    );
}

export function AsrStatusBadge({ status }: { status: string }) {
    const meta = ASR_META[status] ?? ASR_META.pending;
    return <StatusDot meta={meta} />;
}

export function VectorStatusBadge({ status }: { status: string }) {
    const meta = VECTOR_META[status] ?? VECTOR_META.pending;
    return <StatusDot meta={meta} />;
}

/** Compact dot-only variant for dense list rows. */
export function VectorStatusDotOnly({ status }: { status: string }) {
    const meta = VECTOR_META[status] ?? VECTOR_META.pending;
    return (
        <span
            className={cn("h-1.5 w-1.5 shrink-0 rounded-full", meta.dotClass)}
            title={meta.label}
        />
    );
}
