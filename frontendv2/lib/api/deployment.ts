/**
 * Runtime deployment address resolver — 前端请求与分享链接共用的地址链。
 *
 * 优先级（与 /api/share-base 的 candidates 一致）：
 *   1. SHARE_DOMAIN（.env，如 minbase.top）
 *   2. 公网 IP（SHARE_PUBLIC_IP 覆盖或自动探测）
 *   3. 本机地址（调用方给的 fallback：API 请求 = 构建期 NEXT_PUBLIC_API_URL/
 *      同源；分享链接 = 当前访问地址）
 *
 * 两个消费语义不同：
 *   - resolveShareBase()：严格按链取首选（链接是给别人点的，域名必须优先）。
 *   - resolveApiBase()：先把「当前访问地址」与候选对齐（同源优先，避免无谓
 *     跨域），不一致时逐候选做 no-cors 可达性探测（域名没配 DNS/hosts 的
 *     客户端自动落到公网 IP），全部不可达再落 fallback。
 */

const ROUTE_URL = "/api/share-base";
const CACHE_KEY = "mb.deployment.base.v1";
const CACHE_TTL_MS = 10 * 60 * 1000;
const PROBE_TIMEOUT_MS = 2500;

interface RoutePayload {
    baseUrl?: unknown;
    candidates?: unknown;
}

/** 读 /api/share-base（同源相对路径 —— 该端点永远在页面自己的 Next 服务器上） */
async function fetchRoute(): Promise<{ baseUrl: string; candidates: string[] }> {
    const res = await fetch(ROUTE_URL, {
        headers: { "X-Requested-With": "XMLHttpRequest" },
        cache: "no-store",
    });
    if (!res.ok) return { baseUrl: "", candidates: [] };
    const data = (await res.json()) as RoutePayload;
    const candidates = Array.isArray(data.candidates)
        ? data.candidates.filter((c): c is string => typeof c === "string" && c.startsWith("http"))
        : [];
    const baseUrl = typeof data.baseUrl === "string" ? data.baseUrl : "";
    return { baseUrl, candidates: baseUrl ? candidates : candidates };
}

/** no-cors 探测：resolve=网络可达（响应不透明，无需 CORS 头），reject=不可达 */
async function isReachable(candidate: string): Promise<boolean> {
    try {
        await fetch(`${candidate}/`, {
            mode: "no-cors",
            method: "HEAD",
            cache: "no-store",
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        return true;
    } catch {
        return false;
    }
}

interface CacheShape {
    base: string;
    at: number;
}

/** 上一轮解析结果（localStorage，跨页面加载即时生效；后台刷新负责纠偏） */
export function readCachedBase(): string | null {
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as CacheShape;
        if (typeof parsed.base !== "string") return null;
        return parsed.base;
    } catch {
        return null;
    }
}

export function writeCachedBase(base: string): void {
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ base, at: Date.now() } satisfies CacheShape));
    } catch {
        // 隐私模式等写失败场景：静默降级为每次现解析
    }
}

function isFresh(): boolean {
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (!raw) return false;
        const parsed = JSON.parse(raw) as CacheShape;
        return typeof parsed.at === "number" && Date.now() - parsed.at < CACHE_TTL_MS;
    } catch {
        return false;
    }
}

/**
 * 分享链接 base：严格链（域名 → 公网IP），空串由调用方回退当前访问地址。
 * 不做同源短路 —— 链接的消费者是别人，域名优先是硬语义。
 */
export async function resolveShareBase(): Promise<string> {
    try {
        return (await fetchRoute()).baseUrl;
    } catch {
        return "";
    }
}

/**
 * 浏览器侧 API base：同源优先 → 逐候选探测 → fallback（本机地址）。
 * SSR 返回 fallback 原值（服务端请求永远走内部网络，不适用此链）。
 */
export async function resolveApiBase(fallback: string): Promise<string> {
    if (typeof window === "undefined") return fallback;
    let candidates: string[] = [];
    try {
        candidates = (await fetchRoute()).candidates;
    } catch {
        return fallback;
    }
    // 0) 当前访问地址本身就是部署地址之一 → 同源相对路径（零跨域，最稳）
    if (candidates.includes(window.location.origin)) return "";
    // 1) 域名优先，逐个探测可达性（域名没解析的设备自动落到公网 IP）
    for (const candidate of candidates) {
        if (await isReachable(candidate)) return candidate;
    }
    // 2) 全部不可达 → 本机地址兜底（构建期值 / 同源）
    return fallback;
}
