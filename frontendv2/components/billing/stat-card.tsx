"use client";

/** Compact stat card - label, big value, optional sub line. */
export function StatCard({
    label,
    value,
    sub,
}: {
    label: string;
    value: string;
    sub?: string;
}) {
    return (
        <div className="rounded-lg border border-border-subtle bg-surface px-5 py-4">
            <div className="text-[11px] font-medium uppercase tracking-wider text-tertiary">
                {label}
            </div>
            <div className="mt-2 text-[26px] font-semibold leading-none tracking-tight text-foreground">
                {value}
            </div>
            {sub && <div className="mt-1.5 text-[12px] text-secondary">{sub}</div>}
        </div>
    );
}
