import { config } from "../../config/index.js";
import { createLogger } from "../../logger.js";
import type { WebFetchOptions, WebFetchPort, WebPage } from "./fetcher.js";
import { assertPublicUrl, WebFetchError } from "./ssrf.js";

const log = createLogger("WEB_DEEPSEEK");

/**
 * DeepSeek 官方网页搜索/抓取 API 客户端
 * （契约：https://api-docs.deepseek.com/zh-cn/guides/search）
 *
 * - Search：POST {base}/v1/tools/search —— 结构化结果（rerank_score 0-3、authority 0-4、
 *   snippet/summary 双轨摘要、date）；按成功请求计费（¥5/1000 次），失败/空结果不计费。
 * - Fetch：POST {base}/v1/tools/fetch —— 云端代抓，返回 Markdown 正文。
 * - 鉴权：Authorization: Bearer <API Key>（与 DeepSeek API 同一把 key）。
 * - 限速：账号级 Search 100 QPS / Fetch 25 QPS；超限 429，上层引擎链/调用方自行退避。
 * - 错误：OpenAI 兼容格式 {error:{message,type,param,code}}；本类只做映射，不自动重试
 *   （可重试的 408/429/5xx 由引擎链的"下一个引擎"兜底，与 tavily/searxng 失败语义一致）。
 */

export class DeepSeekApiError extends Error {
  constructor(
    message: string,
    /** HTTP 状态码；0 = 本地校验拒绝或传输失败（未收到响应） */
    readonly status: number,
  ) {
    super(message);
    this.name = "DeepSeekApiError";
  }
}

export interface DeepSeekSearchParams {
  query: string;
  /** 返回条数，1-50，默认 10（计费与条数无关） */
  count?: number;
  /** 是否返回网页正文 content；false 时 content 恒为空串 */
  needContent?: boolean;
  /**
   * 触发搜索的用户原始问题（1-128 字符，服务端用于意图理解）。
   * web_search 工具的 ToolRunContext 不携带用户消息，当前不传；客户端先行支持。
   */
  oriQuestion?: string;
  signal?: AbortSignal;
}

export interface DeepSeekSearchResult {
  rerankScore: number;
  title: string;
  url: string;
  snippet: string;
  summary: string;
  content: string;
  siteName: string | null;
  siteIcon: string | null;
  /** UTC RFC 3339，未知为 null */
  date: string | null;
  /** 权威层级 0-4（-1 未知），>=3 为极权威 */
  authority: number;
}

export interface DeepSeekPage {
  title: string;
  content: string;
}

type FetchImpl = typeof fetch;

/** API 约束的本地预检阈值（省一次注定 400 的付费调用） */
const QUERY_MAX_CHARS = 128;
const URL_MAX_CHARS = 8192;

export class DeepSeekToolsApi {
  constructor(
    private readonly opts: {
      apiKey: string;
      baseUrl: string;
      /** 可注入的 fetch 实现（单测替身）；缺省用全局 fetch */
      fetchImpl?: FetchImpl;
    },
  ) {}

  async search(params: DeepSeekSearchParams): Promise<DeepSeekSearchResult[]> {
    const query = params.query.trim();
    if (!query) throw new DeepSeekApiError("搜索词不能为空", 0);
    const count = params.count ?? 10;
    if (!Number.isInteger(count) || count < 1 || count > 50) {
      throw new DeepSeekApiError(`count 必须在 1-50 之间，收到 ${count}`, 0);
    }
    const body: Record<string, unknown> = {
      query: query.slice(0, QUERY_MAX_CHARS),
      count,
      need_content: params.needContent ?? false,
    };
    if (params.oriQuestion) {
      const ori = params.oriQuestion.replace(/\s+/g, " ").trim().slice(0, QUERY_MAX_CHARS);
      if (ori) body.ori_question = ori;
    }
    const json = await this.request("/v1/tools/search", body, params.signal);
    if (!Array.isArray(json.results)) throw new DeepSeekApiError("响应缺少 results 数组", 0);
    return json.results.map(mapSearchResult).filter((r): r is DeepSeekSearchResult => r !== null);
  }

  async fetchPage(url: string, signal?: AbortSignal): Promise<DeepSeekPage> {
    assertFetchUrl(url);
    const json = await this.request("/v1/tools/fetch", { url }, signal);
    if (typeof json.content !== "string") throw new DeepSeekApiError("响应缺少 content 字段", 0);
    if (!json.content.trim()) throw new DeepSeekApiError("官方抓取返回空正文", 0);
    return { title: typeof json.title === "string" ? json.title : "", content: json.content };
  }

  private async request(path: string, body: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await (this.opts.fetchImpl ?? fetch)(`${this.opts.baseUrl.replace(/\/$/, "")}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.opts.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new DeepSeekApiError(`DeepSeek API 请求失败: ${err instanceof Error ? err.message : err}`, 0);
    }
    if (!res.ok) throw await errorFromResponse(res);
    try {
      return (await res.json()) as Record<string, unknown>;
    } catch {
      throw new DeepSeekApiError(`DeepSeek API 响应不是合法 JSON（HTTP ${res.status}）`, res.status);
    }
  }
}

/** URL 约束（指南 Fetch 请求字段）：≤8192 字符、含 host 的 http/https、不得携带用户名/密码。 */
function assertFetchUrl(raw: string): void {
  if (raw.length > URL_MAX_CHARS) throw new DeepSeekApiError(`URL 长度超过 ${URL_MAX_CHARS} 字符`, 0);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new DeepSeekApiError(`无效 URL: ${raw}`, 0);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new DeepSeekApiError(`仅支持 http/https 协议: ${parsed.protocol}`, 0);
  }
  if (!parsed.hostname) throw new DeepSeekApiError("URL 缺少 host", 0);
  if (parsed.username || parsed.password) throw new DeepSeekApiError("URL 不允许携带用户名/密码", 0);
}

async function errorFromResponse(res: Response): Promise<DeepSeekApiError> {
  let detail = "";
  try {
    const body = (await res.json()) as { error?: { message?: unknown } };
    if (typeof body?.error?.message === "string" && body.error.message) detail = body.error.message;
  } catch {
    // 非 JSON 错误体（网关 HTML 等）→ 只报状态码
  }
  return new DeepSeekApiError(`DeepSeek API HTTP ${res.status}${detail ? `: ${detail}` : ""}`, res.status);
}

function mapSearchResult(raw: unknown): DeepSeekSearchResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const title = typeof r.title === "string" ? r.title : "";
  const url = typeof r.url === "string" ? r.url : "";
  if (!title || !url) return null;
  return {
    rerankScore: typeof r.rerank_score === "number" ? r.rerank_score : 0,
    title,
    url,
    snippet: typeof r.snippet === "string" ? r.snippet : "",
    summary: typeof r.summary === "string" ? r.summary : "",
    content: typeof r.content === "string" ? r.content : "",
    siteName: typeof r.site_name === "string" ? r.site_name : null,
    siteIcon: typeof r.site_icon === "string" ? r.site_icon : null,
    date: typeof r.date === "string" ? r.date : null,
    authority: typeof r.authority === "number" ? r.authority : -1,
  };
}

// ---------- 组合根辅助 ----------

/** 从 config.web 装配客户端（每次调用新建，读即时配置快照，便于测试改配置）。 */
export function createDeepSeekApiFromConfig(fetchImpl?: FetchImpl): DeepSeekToolsApi {
  return new DeepSeekToolsApi({
    apiKey: config.web.deepseekApiKey,
    baseUrl: config.web.deepseekApiBaseUrl,
    fetchImpl,
  });
}

/**
 * fetch_webpage 的 DeepSeek 优先装饰器：默认由官方 Fetch API 代抓（云端渲染、稳定
 * 返回 Markdown 正文），DeepSeek 无法提供（请求失败、空正文；未配 key 时组合根直接
 * 短路）才回退本地 HttpWebFetch——免费、SSRF/DNS 双重防护、同宿主礼貌限速、可提取
 * 站内链接。策略性拒绝（非 http、内网/保留地址）在进入任何网络前即拒绝：不送云端
 * （避免借外部服务探测我们内网），也不打本地。API 不回报重定向后的最终 URL，
 * finalUrl 记请求 URL。
 */
export class DeepSeekFetchPrimary implements WebFetchPort {
  constructor(
    private readonly deepseek: DeepSeekToolsApi,
    private readonly base: WebFetchPort,
  ) {}

  async fetch(url: string, opts: WebFetchOptions = {}): Promise<WebPage> {
    assertPublicUrl(url);
    let deepseekMsg = "";
    try {
      const page = await this.deepseek.fetchPage(url, opts.signal);
      log.info(`[WEB_DEEPSEEK] 官方抓取成功 chars=${page.content.length}`);
      return {
        url,
        finalUrl: url,
        title: page.title,
        text: page.content,
        links: [],
        contentType: "text/markdown",
        bytes: Buffer.byteLength(page.content),
      };
    } catch (dsErr) {
      deepseekMsg = dsErr instanceof Error ? dsErr.message : String(dsErr);
      log.warn(`[WEB_DEEPSEEK] 官方抓取不可用，回退本地抓取: ${deepseekMsg}`);
    }
    try {
      return await this.base.fetch(url, opts);
    } catch (baseErr) {
      const baseMsg = baseErr instanceof Error ? baseErr.message : String(baseErr);
      throw new WebFetchError(`DeepSeek 官方抓取失败（${deepseekMsg}）；本地抓取回退也失败（${baseMsg}）`);
    }
  }
}

/** 组合根入口：未配 key 或显式关闭时原样返回本地端口（行为与接入前一致）。 */
export function createFetchPortWithDeepseekPrimary(base: WebFetchPort): WebFetchPort {
  if (!config.web.deepseekApiKey || !config.web.deepseekFetchPrimary) return base;
  log.info("[WEB_DEEPSEEK] fetch_webpage 默认走 DeepSeek Fetch API，失败回退本地抓取");
  return new DeepSeekFetchPrimary(createDeepSeekApiFromConfig(), base);
}
