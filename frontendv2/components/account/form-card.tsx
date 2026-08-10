"use client";

import { Loader2 } from "lucide-react";

/**
 * FormCard - OpenAI-style settings card: header (title + description + optional
 * action) on top, body below, optional footer (action buttons). Body is
 * unpadded; callers manage their own padding so rows can bleed to card edges.
 */
export function FormCard({
    title,
    description,
    action,
    children,
    footer,
}: {
    title: string;
    description?: string;
    action?: React.ReactNode;
    children: React.ReactNode;
    footer?: React.ReactNode;
}) {
    return (
        <section className="overflow-hidden rounded-lg border border-border-subtle bg-surface">
            <div className="flex items-start justify-between gap-3 border-b border-border-subtle px-5 py-4">
                <div className="min-w-0">
                    <h2 className="text-[15px] font-semibold tracking-tight text-foreground">
                        {title}
                    </h2>
                    {description && (
                        <p className="mt-0.5 text-[12px] text-secondary">{description}</p>
                    )}
                </div>
                {action && <div className="shrink-0">{action}</div>}
            </div>
            <div>{children}</div>
            {footer && (
                <div className="flex items-center justify-end gap-2 border-t border-border-subtle px-5 py-3">
                    {footer}
                </div>
            )}
        </section>
    );
}

/** Ghost text button used in card headers to enter edit mode. */
export function EditButton({
    icon,
    label,
    onClick,
}: {
    icon?: React.ReactNode;
    label: string;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className="inline-flex h-7 items-center rounded-md px-2.5 text-[12px] font-medium text-secondary transition-colors hover:bg-border-subtle hover:text-foreground"
        >
            {icon && <span className="mr-1 flex items-center">{icon}</span>}
            {label}
        </button>
    );
}

/** Secondary outline button (cancel). */
export function CancelButton({
    children,
    onClick,
    disabled,
}: {
    children: React.ReactNode;
    onClick: () => void;
    disabled?: boolean;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className="inline-flex h-8 items-center rounded-md border border-border px-3.5 text-[12px] text-secondary transition-colors hover:bg-border-subtle disabled:opacity-40"
        >
            {children}
        </button>
    );
}

/** Primary solid button (OpenAI black). */
export function PrimaryButton({
    children,
    onClick,
    disabled,
    loading,
    icon,
}: {
    children: React.ReactNode;
    onClick: () => void;
    disabled?: boolean;
    loading?: boolean;
    icon?: React.ReactNode;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled || loading}
            className="inline-flex h-8 items-center rounded-md bg-foreground px-3.5 text-[12px] font-medium text-surface transition-opacity hover:opacity-90 disabled:opacity-40"
        >
            {loading ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
                icon
            )}
            {children}
        </button>
    );
}

/** Small status pill. */
export function Tag({
    children,
    tone = "neutral",
}: {
    children: React.ReactNode;
    tone?: "neutral" | "ok" | "warn" | "danger";
}) {
    const cls = {
        neutral: "bg-border-subtle text-secondary",
        ok: "bg-success/10 text-success",
        warn: "bg-warning/10 text-warning",
        danger: "bg-danger/10 text-danger",
    }[tone];
    return (
        <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${cls}`}
        >
            {children}
        </span>
    );
}
