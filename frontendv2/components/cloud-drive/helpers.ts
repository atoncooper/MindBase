/**
 * Cloud drive formatters - relative time + duration.
 *
 * Pure helpers colocated for the cloud-drive feature; formatBytes already
 * lives in lib/api/cloud.ts. Mirrors the favorites formatters but kept local
 * to avoid a cross-feature import edge.
 */

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
