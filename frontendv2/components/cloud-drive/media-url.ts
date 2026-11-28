/**
 * Convert a MinIO presigned URL that goes through the edge proxy into a
 * same-origin path. Keeping media requests same-origin avoids X-Frame-Options
 * and mixed-origin cookie issues for <video>/<audio>/<img>.
 *
 * Two paths exist:
 *  - edge page (https://localhost, i.e. OpenResty serves the page): the
 *    presigned path is already same-origin, keep it relative.
 *  - local dev (next dev on :3000): there is no rewrite for the media path, so
 *    a relative URL would 404 or be re-proxied through Next (slow/full-buffer).
 *    The presigned URL is self-authorizing and media elements do not need
 *    same-origin cookies, so in that case keep the absolute edge URL: the
 *    browser streams the Range requests straight from OpenResty.
 */
export function toSameOriginUrl(url: string): string {
    try {
        const u = new URL(url, window.location.origin);
        if (!u.pathname.startsWith("/minio-proxy/") && !u.pathname.startsWith("/mindbase/api/v1/media/")) {
            return url;
        }
        if (u.origin === window.location.origin) {
            return u.pathname + u.search;
        }
        return url;
    } catch {
        return url;
    }
}
