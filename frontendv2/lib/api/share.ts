/**
 * Share link base URL - 对外分享链接的部署级地址。
 *
 * 严格链：SHARE_DOMAIN → 公网 IP → 当前访问地址（resolveShareBase，
 * 见 lib/api/deployment.ts 与 app/api/share-base/route.ts）。
 *
 * ⚠️ 必须同源请求 Next 服务器自身的 /api/share-base，不能用 request()：
 * request() 会拼构建期固化的 API_BASE_URL，而分享链接的意义就是脱离创建者
 * 的访问地址。
 */
import { resolveShareBase } from "./deployment";

export async function getShareBaseUrl(): Promise<string> {
    if (typeof window === "undefined") return "";
    try {
        return await resolveShareBase();
    } catch {
        return "";
    }
}

/** 组装绝对分享链接：部署域名/公网 IP 优先，否则当前访问地址。 */
export async function buildShareUrl(path: string): Promise<string> {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    let base = "";
    try {
        base = await resolveShareBase();
    } catch {
        base = "";
    }
    return `${base || origin}${path}`;
}
