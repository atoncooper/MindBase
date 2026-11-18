"use client";

import { Loader2 } from "lucide-react";

/**
 * FormCard - Google Account 风格设置卡：顶部标题 / 说明 / 操作，主体不设内边距
 * 以便列表行贴边，底部可选操作栏。视觉 token 由 .g-account 作用域提供。
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
        <section className="overflow-hidden rounded-lg border border-border bg-surface">
            <div className="flex items-start justify-between gap-3 border-b border-border-subtle px-5 py-4">
                <div className="min-w-0">
                    <h2 className="text-[16px] font-medium text-foreground">
                        {title}
                    </h2>
                    {description && (
                        <p className="mt-1 max-w-[560px] text-[12px] leading-relaxed text-secondary">
                            {description}
                        </p>
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

/** Card header 文本按钮（进入编辑态）。 */
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
            className="inline-flex h-8 items-center rounded-lg px-2.5 text-[12px] font-medium text-accent transition-colors hover:bg-[#f1f3f4]"
        >
            {icon && <span className="mr-1 flex items-center">{icon}</span>}
            {label}
        </button>
    );
}

/** 描边次按钮（取消）。 */
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
            className="inline-flex h-9 items-center rounded-lg border border-border bg-surface px-4 text-[12px] font-medium text-accent transition-colors hover:bg-[#f8f9fa] disabled:opacity-40"
        >
            {children}
        </button>
    );
}

/** Google 填充主按钮。 */
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
            className="inline-flex h-9 items-center rounded-lg bg-accent px-4 text-[12px] font-medium text-white shadow-[0_1px_2px_rgba(60,64,67,0.28)] transition-colors hover:bg-accent-hover disabled:opacity-40"
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
