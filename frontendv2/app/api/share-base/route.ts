/**
 * Runtime deployment config: 对外分享链接的 base URL。
 *
 * 解析优先级：
 *   1. SHARE_DOMAIN（.env，如 minbase.top，可带 scheme）→ https://<域名>
 *   2. SHARE_PUBLIC_IP（.env 覆盖）→ https://<公网IP>
 *   3. 自动探测部署机公网 IP（api.ipify.org / ifconfig.me，10 分钟缓存）
 *   4. 全部失败 → baseUrl 为空串，前端回退 window.location.origin（本地测试）
 *
 * 这是 frontendv2 第一个 Next Route Handler：nginx location / 已把未匹配路径
 * 送进 frontend 容器，无需 nginx/APISIX 新路由。值是部署属性而非用户数据，
 * 放在出分享链接的消费方（前端）自己的运行时里最直接。
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PUBLIC_IP_TTL_MS = 10 * 60 * 1000;

let ipCache: { base: string; fetchedAt: number } | null = null;

/** 允许 "minbase.top" 或 "http://minbase.top" 两种写法；统一去尾斜杠。 */
function normalizeDomain(raw: string): string {
    const host = raw.trim().replace(/\/+$/, "");
    if (!host) return "";
    return /^https?:\/\//i.test(host) ? host : `https://${host}`;
}

async function detectPublicIP(): Promise<string> {
    const sources = ["https://api.ipify.org", "https://ifconfig.me/ip"];
    for (const url of sources) {
        try {
            const res = await fetch(url, {
                signal: AbortSignal.timeout(3000),
                cache: "no-store",
            });
            if (!res.ok) continue;
            const ip = (await res.text()).trim();
            // IPv4/IPv6 字面量校验，防止镜像站返回 HTML
            if (/^[0-9a-fA-F.:]+$/.test(ip) && ip.length <= 45) return ip;
        } catch {
            // 网络不可达 / 超时 → 尝试下一个源
        }
    }
    return "";
}

export async function GET() {
    // 候选地址（有序、去重、非空）：域名 → 公网IP → 自动探测。
    // baseUrl = 首选（分享链接用）；candidates = 全量候选（前端 API base
    // 逐个做可达性探测后选取，域名不可达的客户端自动落到公网 IP）。
    const candidates: string[] = [];

    // 1) 显式域名最高优先
    const domain = (process.env.SHARE_DOMAIN ?? "").trim();
    if (domain) candidates.push(normalizeDomain(domain));

    // 2) 手工指定的公网 IP
    const staticIP = (process.env.SHARE_PUBLIC_IP ?? "").trim();
    if (staticIP) candidates.push(`https://${staticIP}`);

    // 3) 自动探测公网 IP（带缓存；无公网出口时为空 → 前端回退当前地址）
    if (ipCache && Date.now() - ipCache.fetchedAt < PUBLIC_IP_TTL_MS) {
        if (ipCache.base) candidates.push(ipCache.base);
    } else {
        const ip = await detectPublicIP();
        ipCache = { base: ip ? `https://${ip}` : "", fetchedAt: Date.now() };
        if (ipCache.base) candidates.push(ipCache.base);
    }

    const unique = [...new Set(candidates)];
    return Response.json({
        baseUrl: unique[0] ?? "",
        candidates: unique,
        source: unique.length ? (unique[0] === normalizeDomain(domain) && domain ? "domain" : "public-ip") : "origin",
    });
}
