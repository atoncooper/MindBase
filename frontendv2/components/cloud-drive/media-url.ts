/**
 * Convert a MinIO presigned URL that goes through the edge proxy into a
 * same-origin path. Keeping media requests same-origin avoids X-Frame-Options
 * and mixed-origin cookie issues for <video>/<audio>/<img>.
 */
export function toSameOriginUrl(url: string): string {
    try {
        const u = new URL(url, window.location.origin);
        if (u.pathname.startsWith("/minio-proxy/") || u.pathname.startsWith("/mindbase/api/v1/media/")) {
            return u.pathname + u.search;
        }
        return url;
    } catch {
        return url;
    }
}
