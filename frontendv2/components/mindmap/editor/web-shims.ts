/**
 * Web shims for desktop-only imports (lib/router, @tauri-apps/plugin-dialog).
 *
 * The editor components are ported from mind-base-desktop with minimal
 * changes; these stand-ins keep their imports compiling with web semantics:
 *   - navigate: external links open a new tab; internal hashes are no-ops.
 *   - confirm: window.confirm (styling parity is a P3 nicety, not a blocker).
 */

/** Desktop hash constants — kept for import compatibility. */
export const MINDMAP_HASH = "#/mindmap";

/** Desktop hash builder — unused on web; kept for import compatibility. */
export function mindMapHash(id: string): string {
    return `#/mindmap/${encodeURIComponent(id)}`;
}

/** Desktop navigate(hash) — web: open absolute URLs, ignore hash routing. */
export function navigate(hash: string): void {
    if (/^https?:\/\//i.test(hash)) {
        window.open(hash, "_blank", "noopener,noreferrer");
        return;
    }
    if (/^https?:/i.test(hash) === false && /^\//.test(hash) === false) {
        // Internal app hashes (desktop router) have no web equivalent; the
        // mindmap page owns its own state, so hash navigation is a no-op.
        return;
    }
    if (/^\//.test(hash)) {
        window.location.hash = hash;
    }
}

/** Node-link confirmation — desktop uses the native dialog; web confirms. */
export async function confirm(
    message: string,
    options?: { title?: string; kind?: string; okLabel?: string; cancelLabel?: string },
): Promise<boolean> {
    const title = options?.title ? `${options.title}\n` : "";
    return window.confirm(`${title}${message}`);
}
