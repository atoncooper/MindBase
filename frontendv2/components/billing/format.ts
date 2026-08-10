/** Number formatting helpers shared across the billing/usage view. */

export function formatTokens(v: number): string {
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
    return String(Math.round(v));
}

export function formatCost(v: number): string {
    if (!Number.isFinite(v)) return "¥0.00";
    return `¥${v.toFixed(2)}`;
}

export function formatNum(v: number): string {
    if (!Number.isFinite(v)) return "0";
    return Math.round(v).toLocaleString("en-US");
}
