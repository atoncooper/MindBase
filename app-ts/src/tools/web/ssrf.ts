import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * SSRF guards for the fetch_webpage tool — shared by the HTTP fetcher and the
 * HTML cleaner (link extraction).
 */

export class WebFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebFetchError";
  }
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.goog",
]);

const PRIVATE_V4_RANGES: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local / cloud metadata
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
];

function v4ToLong(ip: string): number {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return -1;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isPrivateIPv4(ip: string): boolean {
  const v = v4ToLong(ip);
  if (v < 0) return true; // unparseable → treat as unsafe
  return PRIVATE_V4_RANGES.some(([net, bits]) => {
    const base = v4ToLong(net);
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (v & mask) === (base & mask);
  });
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // IPv4-mapped ::ffff:a.b.c.d
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  if (lower === "::" || lower === "::1") return true;
  if (/^f[cd]/.test(lower)) return true; // fc00::/7 unique local
  if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
  return false;
}

export function isPrivateIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateIPv4(ip);
  if (version === 6) return isPrivateIPv6(ip);
  return true; // not an IP → caller should DNS-resolve instead
}

export function hostnameBlocked(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  if (h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  // IP literals are checked directly (no DNS hop to defend)
  if (isIP(h)) return isPrivateIp(h);
  return false;
}

export function assertPublicUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new WebFetchError(`无效 URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebFetchError(`仅支持 http/https 协议: ${url.protocol}`);
  }
  if (hostnameBlocked(url.hostname)) {
    throw new WebFetchError(`禁止访问内网/保留地址: ${url.hostname}`);
  }
  return url;
}

export async function assertPublicDns(hostname: string, lookupFn: typeof lookup): Promise<void> {
  if (isIP(hostname)) return; // literal already validated
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookupFn(hostname, { all: true });
  } catch (err) {
    throw new WebFetchError(`域名解析失败: ${hostname}（${err instanceof Error ? err.message : err}）`);
  }
  if (addresses.length === 0) {
    throw new WebFetchError(`域名解析结果为空: ${hostname}`);
  }
  for (const a of addresses) {
    if (isPrivateIp(a.address)) {
      throw new WebFetchError(`禁止访问：${hostname} 解析到内网/保留地址 ${a.address}`);
    }
  }
}
