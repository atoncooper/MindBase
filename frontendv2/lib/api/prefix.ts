/**
 * Unified external API / page namespace.
 *
 * Public contract: every backend API lives under /mindbase/api/v1/<domain>/...
 * The OpenResty edge strips this prefix before forwarding to APISIX, so APISIX
 * keeps owning per-domain routing/plugins and services keep their internal
 * paths. Share pages / OAuth callbacks live under /mindbase/... (pages plane).
 *
 * Build-time value (Next inlines NEXT_PUBLIC_*): set by compose. Empty means
 * legacy bare paths (local dev without the edge).
 */
export const API_PREFIX = process.env.NEXT_PUBLIC_API_PREFIX || "";

/** Public share page prefixes (canonical URLs shown to visitors). */
export const SHARE_PATHS = {
    cloud: "/mindbase/s/cloud",
    notes: "/mindbase/s/notes",
    quiz: "/mindbase/s/quiz",
} as const;
