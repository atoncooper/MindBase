import { lookup } from "node:dns/promises";
import { config } from "../../config/index.js";
import { createLogger } from "../../logger.js";
import {
  assertPublicDns,
  assertPublicUrl,
  WebFetchError,
  hostnameBlocked,
  isPrivateIp,
} from "./ssrf.js";
import { extractReadable } from "./html-cleaner.js";

// Guards live in ssrf.ts; re-exported for convenience.
export { assertPublicUrl, assertPublicDns, hostnameBlocked, isPrivateIp, WebFetchError } from "./ssrf.js";

const log = createLogger("WEB");

/**
 * Web fetch port: the model's window onto the public web.
 *
 * SECURITY (the red lines of this port):
 * - SSRF guard on EVERY hop: http/https only, localhost/metadata hostnames and all
 *   private/loopback/link-local IP literals rejected, DNS results re-checked before
 *   connecting (a public hostname resolving to an internal IP is still blocked).
 * - Redirects are followed MANUALLY so each hop is re-validated (a redirect cannot
 *   smuggle the fetch into the internal network).
 * - Hard size cap + budget signal come from the TimeoutManager (never self-timed).
 *
 * POLITENESS: at most one request per host per `web.perHostIntervalMs` (real wait,
 * abortable via the budget signal) — back-to-back crawls of the same site can't
 * hammer it. HTML cleaning (nav/ads/hidden-element removal, main-content
 * preference, structure-preserving text) lives in html-cleaner.ts.
 */

export interface WebPage {
  url: string;
  finalUrl: string;
  title: string;
  /** meta description / og:description, when the page declares one */
  description?: string;
  text: string;
  /** absolute follow-up links found on the page (deduped, http/https only) */
  links: string[];
  contentType: string;
  bytes: number;
}

export interface WebFetchOptions {
  signal?: AbortSignal;
}

export interface WebFetchPort {
  fetch(url: string, opts?: WebFetchOptions): Promise<WebPage>;
}

// ---------- HTTP implementation ----------

type FetchImpl = typeof fetch;
type LookupFn = typeof lookup;

export class HttpWebFetch implements WebFetchPort {
  /** last request timestamp per host (politeness interval) */
  private lastRequestAt = new Map<string, number>();

  constructor(
    private readonly fetchImpl: FetchImpl = fetch,
    private readonly lookupFn: LookupFn = lookup,
  ) {}

  async fetch(url: string, opts: WebFetchOptions = {}): Promise<WebPage> {
    const maxRedirects = config.web.maxRedirects;
    let current = assertPublicUrl(url);
    let response: Response | null = null;

    for (let hop = 0; hop <= maxRedirects; hop++) {
      await assertPublicDns(current.hostname, this.lookupFn);
      await this.politeDelay(current.hostname, opts.signal);
      response = await this.fetchImpl(current.toString(), {
        redirect: "manual", // every hop is re-validated — no redirect-based SSRF
        headers: {
          "User-Agent": config.web.userAgent,
          Accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8",
        },
        signal: opts.signal,
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new WebFetchError(`重定向缺少 location: ${current}`);
        if (hop === maxRedirects) throw new WebFetchError(`重定向次数超过上限（${maxRedirects}）`);
        response.body?.cancel().catch(() => undefined);
        current = assertPublicUrl(new URL(location, current).toString());
        continue;
      }
      break;
    }

    if (!response) throw new WebFetchError("未获得响应");
    if (!response.ok) {
      throw new WebFetchError(`目标返回 HTTP ${response.status}（${current.toString().slice(0, 120)}）`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    const supported = /text\/html|application\/xhtml|text\/plain|application\/json|text\/xml|application\/xml/i.test(contentType);
    if (!supported) {
      throw new WebFetchError(`不支持的内容类型: ${contentType || "未知"}（仅 html/xhtml/plain/json/xml）`);
    }

    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > config.web.maxBytes) {
      throw new WebFetchError(`页面超过大小上限（${Math.floor(config.web.maxBytes / 1024)}KB）`);
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > config.web.maxBytes) {
      throw new WebFetchError(`页面超过大小上限（${Math.floor(config.web.maxBytes / 1024)}KB）`);
    }

    const raw = decodeBody(buffer, contentType);
    const isHtml = /html/i.test(contentType);
    const extracted = isHtml
      ? extractReadable(raw, current)
      : { title: "", description: "", text: raw, links: [] as string[] };
    if (!extracted.text) {
      throw new WebFetchError("页面没有可提取的文本内容");
    }
    log.info(`[WEB] fetched ${current.hostname} bytes=${buffer.byteLength} text_chars=${extracted.text.length} links=${extracted.links.length}`);
    return {
      url,
      finalUrl: current.toString(),
      title: extracted.title,
      description: extracted.description || undefined,
      text: extracted.text,
      links: extracted.links,
      contentType,
      bytes: buffer.byteLength,
    };
  }

  /**
   * One request per host per interval: same-host back-to-back crawls wait out the
   * remaining gap (abortable). The map is capped — a full map just resets its
   * timestamps, which only makes the very next request wait again.
   */
  private async politeDelay(host: string, signal?: AbortSignal): Promise<void> {
    const interval = config.web.perHostIntervalMs;
    if (interval <= 0) return;
    if (this.lastRequestAt.size > 1000) this.lastRequestAt.clear();
    const last = this.lastRequestAt.get(host) ?? 0;
    const waitMs = last + interval - Date.now();
    if (waitMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          resolve();
        }, waitMs);
        const onAbort = () => {
          cleanup();
          reject(new WebFetchError("已取消"));
        };
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        };
        signal?.addEventListener("abort", onAbort);
      });
    }
    this.lastRequestAt.set(host, Date.now());
  }
}

/** Decode with the declared charset when present (GBK/GB2312 pages arrive garbled under naive UTF-8). */
function decodeBody(buffer: ArrayBuffer, contentType: string): string {
  const charset = contentType.match(/charset=["']?([\w-]+)/i)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return new TextDecoder("utf-8").decode(buffer);
  }
}
