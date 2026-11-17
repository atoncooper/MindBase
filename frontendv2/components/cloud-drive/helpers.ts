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

/** Format a similarity score as a percentage (cosine scores are 0..1). */
export function formatSimilarity(score: number): string {
    if (!Number.isFinite(score)) return "-";
    const pct = score <= 1 ? score * 100 : score;
    return `${Math.round(pct)}%`;
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

/**
 * Friendly Chinese label for a MIME type — raw values such as
 * "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
 * are far wider than the detail panel and used to overflow it. Keep the raw
 * MIME string in a `title` tooltip where the full value still matters.
 */
export function describeMimeType(mimeType: string | null | undefined): string {
    const mime = (mimeType || "").split(";")[0].trim().toLowerCase();
    if (!mime) return "未知类型";

    if (mime === "application/pdf") return "PDF 文档";
    if (mime.includes("wordprocessingml") || mime.includes("msword") || mime.includes("word"))
        return "Word 文档";
    if (mime.includes("spreadsheetml") || mime.includes("ms-excel") || mime.includes("sheet"))
        return "Excel 表格";
    if (mime.includes("presentationml") || mime.includes("ms-powerpoint") || mime.includes("presentation"))
        return "PowerPoint 演示文稿";
    if (mime.includes("markdown")) return "Markdown 文档";
    if (mime === "text/plain") return "纯文本";
    if (mime === "text/html") return "网页";
    if (mime === "application/json") return "JSON 数据";
    if (mime.includes("json")) return "JSON 数据";
    if (mime.includes("xml")) return "XML 数据";
    if (mime.includes("zip") || mime.includes("rar") || mime.includes("7z") || mime.includes("tar") || mime.includes("compressed"))
        return "压缩包";

    const [top, ...rest] = mime.split("/");
    const subtype = formatMimeSubtype(rest.join("/"));
    if (top === "image") return subtype ? `${subtype} 图片` : "图片";
    if (top === "video") return subtype ? `${subtype} 视频` : "视频";
    if (top === "audio") return subtype ? `${subtype} 音频` : "音频";
    if (top === "text") return "文本文件";
    // Unknown vendor type: keep it short enough to never overflow the panel.
    return subtype && subtype.length <= 24 ? subtype : mime.length > 28 ? `${mime.slice(0, 27)}…` : mime;
}

/** "vnd.openxmlformats-officedocument..."/"x-matroska" -> short upper label. */
function formatMimeSubtype(subtype: string): string {
    const cleaned = subtype
        .split("+")[0]
        .replace(/^x-/, "")
        .replace(/^vnd\./, "")
        .trim();
    if (!cleaned) return "";
    return cleaned.toUpperCase();
}
