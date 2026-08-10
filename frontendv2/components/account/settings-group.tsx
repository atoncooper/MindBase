"use client";

import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * SettingsGroup / Row - Apple-settings style grouped list.
 *
 * A group is a rounded card with hairline-separated rows. A row shows an icon
 * (in a tinted square), a label, an optional trailing value, and a chevron
 * when clickable. Used across the account page.
 */

export function SettingsGroup({
    title,
    children,
}: {
    title?: string;
    children: React.ReactNode;
}) {
    return (
        <div>
            {title && (
                <h2 className="mb-1.5 px-4 text-[11px] font-medium uppercase tracking-wider text-tertiary">
                    {title}
                </h2>
            )}
            <div className="overflow-hidden rounded-lg border border-border-subtle bg-surface">
                {children}
            </div>
        </div>
    );
}

export function Row({
    icon,
    label,
    value,
    onClick,
    danger,
}: {
    icon?: React.ReactNode;
    label: string;
    value?: React.ReactNode;
    onClick?: () => void;
    danger?: boolean;
}) {
    const className = cn(
        "flex w-full items-center gap-3 border-b border-border-subtle px-5 py-3 text-left transition-colors last:border-b-0",
        onClick && "cursor-pointer hover:bg-border-subtle",
        danger ? "text-danger" : "text-foreground",
    );

    const content = (
        <>
            {icon && (
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-border-subtle text-secondary">
                    {icon}
                </span>
            )}
            <span className="flex-1 text-[14px] font-medium">{label}</span>
            {value !== undefined && (
                <span className="max-w-[55%] truncate text-[13px] text-tertiary">
                    {value}
                </span>
            )}
            {onClick && <ChevronRight className="h-4 w-4 shrink-0 text-tertiary" />}
        </>
    );

    if (onClick) {
        return (
            <button type="button" onClick={onClick} className={className}>
                {content}
            </button>
        );
    }
    return <div className={className}>{content}</div>;
}
