import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  DeepSeekApiError,
  DeepSeekFetchPrimary,
  DeepSeekToolsApi,
  createFetchPortWithDeepseekPrimary,
} from "../src/tools/web/deepseek.js";
import {
  HttpWebFetch,
  WebFetchError,
  type LookupFn,
  type WebFetchOptions,
  type WebFetchPort,
  type WebPage,
} from "../src/tools/web/fetcher.js";
import { createWebSearchTool } from "../src/tools/web/search.js";
import { createFetchWebpageTool } from "../src/tools/web/fetch-page.js";
import { ResultCollector } from "../src/context/types.js";
import { config } from "../src/config/index.js";

function ctx() {
  return { uid: 1, chatSessionId: "s1", scope: {}, collector: new ResultCollector() };
}

const content = (out: unknown) => (typeof out === "string" ? out : (out as { content: string }).content);

/** 记录请求并按 URL/状态返回 canned JSON 的 fetch 替身。 */
function jsonFetch(routes: Array<{ match: RegExp; status?: number; body: unknown }>, capture: { url?: string; init?: RequestInit } = {}) {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (capture) {
      capture.url = url;
      capture.init = init;
    }
    const route = routes.find((r) => r.match.test(url));
    if (!route) throw new Error(`unexpected fetch: ${url}`);
    return new Response(typeof route.body === "string" ? route.body : JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const SEARCH_RESPONSE = {
  results: [
    {
      rerank_score: 2.4,
      title: "DeepSeek V4 模型发布",
      url: "https://example.com/deepseek-v4",
      snippet: "DeepSeek V4 已上线，支持工具调用与长上下文。",
      summary: "DeepSeek 发布了 V4 模型，此次发布改进了工具调用与长上下文能力。",
      content: "",
      site_name: "Example News",
      site_icon: "https://example.com/favicon.ico",
      date: "2026-06-01T00:00:00+00:00",
      authority: 3,
    },
    {
      rerank_score: 1.8,
      title: "另一条结果",
      url: "https://other.example.com/post",
      snippet: "",
      summary: "summary 兜底 snippet 的长摘要文本。",
      content: "",
      site_name: null,
      site_icon: null,
      date: null,
      authority: -1,
    },
  ],
};

// ---------- DeepSeekToolsApi.search ----------

describe("DeepSeekToolsApi.search", () => {
  it("按契约发起请求并映射结构化结果", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const api = new DeepSeekToolsApi({
      apiKey: "sk-test",
      baseUrl: "https://api.deepseek.com/",
      fetchImpl: jsonFetch([{ match: /\/v1\/tools\/search$/, body: SEARCH_RESPONSE }], capture),
    });
    const results = await api.search({ query: "DeepSeek V4 发布", count: 5 });

    expect(capture.url).toBe("https://api.deepseek.com/v1/tools/search");
    expect(capture.init?.method).toBe("POST");
    const headers = new Headers(capture.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer sk-test");
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(capture.init?.body))).toEqual({ query: "DeepSeek V4 发布", count: 5, need_content: false });

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      rerankScore: 2.4,
      title: "DeepSeek V4 模型发布",
      url: "https://example.com/deepseek-v4",
      siteName: "Example News",
      date: "2026-06-01T00:00:00+00:00",
      authority: 3,
    });
    // 尾部 "/" 被剥掉；第二条 authority=-1 映射保留（展示层再决定是否渲染）
    expect(results[1].authority).toBe(-1);
  });

  it("query 超 128 字符本地截断（精确断言请求体，不浪费注定 400 的付费调用）", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const api = new DeepSeekToolsApi({
      apiKey: "k",
      baseUrl: "https://api.deepseek.com",
      fetchImpl: jsonFetch([{ match: /search$/, body: { results: [] } }], capture),
    });
    const long = "字".repeat(200);
    await api.search({ query: long });
    const sent = JSON.parse(String(capture.init?.body));
    expect(sent.query).toHaveLength(128);
    expect(sent.query).toBe("字".repeat(128));
  });

  it("空白 query 与非法 count 本地拒绝（status=0，无网络请求）", async () => {
    const fetchImpl = vi.fn();
    const api = new DeepSeekToolsApi({ apiKey: "k", baseUrl: "https://api.deepseek.com", fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(api.search({ query: "   " })).rejects.toThrow(DeepSeekApiError);
    await expect(api.search({ query: "ok", count: 99 })).rejects.toThrow(/count/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("OpenAI 兼容错误体映射出状态码与服务端 message", async () => {
    const api = new DeepSeekToolsApi({
      apiKey: "k",
      baseUrl: "https://api.deepseek.com",
      fetchImpl: jsonFetch([{ match: /search$/, status: 402, body: { error: { message: "账号余额不足", type: "invalid_request_error", param: null, code: "invalid_request_error" } } }]),
    });
    const err = await api.search({ query: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeepSeekApiError);
    expect((err as DeepSeekApiError).status).toBe(402);
    expect((err as DeepSeekApiError).message).toContain("402");
    expect((err as DeepSeekApiError).message).toContain("账号余额不足");
  });

  it("非 JSON 错误体只报状态码；空 results 是成功而非错误", async () => {
    const api = new DeepSeekToolsApi({
      apiKey: "k",
      baseUrl: "https://api.deepseek.com",
      fetchImpl: jsonFetch([{ match: /search$/, status: 502, body: "<html>bad gateway</html>" }]),
    });
    await expect(api.search({ query: "x" })).rejects.toThrow(/502/);

    const ok = new DeepSeekToolsApi({
      apiKey: "k",
      baseUrl: "https://api.deepseek.com",
      fetchImpl: jsonFetch([{ match: /search$/, body: { results: [] } }]),
    });
    await expect(ok.search({ query: "x" })).resolves.toEqual([]);
  });

  it("ori_question 折叠空白后截断发送；缺省不发该字段", async () => {
    const capture: { init?: RequestInit } = {};
    const api = new DeepSeekToolsApi({
      apiKey: "k",
      baseUrl: "https://api.deepseek.com",
      fetchImpl: jsonFetch([{ match: /search$/, body: { results: [] } }], capture),
    });
    await api.search({ query: "q", oriQuestion: "  我  想  知道\n  DeepSeek  的搜索价格？  " });
    let sent = JSON.parse(String(capture.init?.body)) as { ori_question?: string };
    expect(sent.ori_question).toBe("我 想 知道 DeepSeek 的搜索价格？");

    await api.search({ query: "q" });
    sent = JSON.parse(String(capture.init?.body));
    expect(sent.ori_question).toBeUndefined();
  });
});

// ---------- DeepSeekToolsApi.fetchPage ----------

describe("DeepSeekToolsApi.fetchPage", () => {
  it("返回 title + Markdown content；打到 /v1/tools/fetch", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const api = new DeepSeekToolsApi({
      apiKey: "k",
      baseUrl: "https://api.deepseek.com",
      fetchImpl: jsonFetch([{ match: /\/v1\/tools\/fetch$/, body: { title: "示例文章", content: "# 示例文章\n\n正文。" } }], capture),
    });
    const page = await api.fetchPage("https://example.com/article");
    expect(capture.url).toBe("https://api.deepseek.com/v1/tools/fetch");
    expect(JSON.parse(String(capture.init?.body))).toEqual({ url: "https://example.com/article" });
    expect(page).toEqual({ title: "示例文章", content: "# 示例文章\n\n正文。" });
  });

  it("URL 约束本地预检：超长/非 http/无 host/带凭据（status=0，无网络）", async () => {
    const fetchImpl = vi.fn();
    const api = new DeepSeekToolsApi({ apiKey: "k", baseUrl: "https://api.deepseek.com", fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(api.fetchPage(`https://example.com/${"a".repeat(9000)}`)).rejects.toThrow(/8192/);
    await expect(api.fetchPage("ftp://example.com/x")).rejects.toThrow(/http/);
    await expect(api.fetchPage("https://user:pass@example.com/x")).rejects.toThrow(/用户名/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("缺少 content 字段的响应报错", async () => {
    const api = new DeepSeekToolsApi({
      apiKey: "k",
      baseUrl: "https://api.deepseek.com",
      fetchImpl: jsonFetch([{ match: /fetch$/, body: { title: "only title" } }]),
    });
    await expect(api.fetchPage("https://example.com/x")).rejects.toThrow(/content/);
  });
});

// ---------- DeepSeekFetchPrimary（WebFetchPort 装饰器：官方优先，本地回退） ----------

class SpyLocalFetch implements WebFetchPort {
  calls = 0;
  constructor(
    private readonly page?: WebPage,
    private readonly err?: Error,
  ) {}
  async fetch(): Promise<WebPage> {
    this.calls++;
    if (this.err) throw this.err;
    return this.page!;
  }
}

const localPage: WebPage = {
  url: "u",
  finalUrl: "u",
  title: "本地标题",
  text: "本地正文",
  links: ["https://example.com/next"],
  contentType: "text/html",
  bytes: 8,
};

function okApi() {
  return {
    fetchPage: vi.fn(async () => ({ title: "云端代抓", content: "# 代抓正文\n\n内容" })),
  } as unknown as DeepSeekToolsApi & { fetchPage: ReturnType<typeof vi.fn> };
}

describe("DeepSeekFetchPrimary", () => {
  it("官方成功 → 不触发本地抓取", async () => {
    const local = new SpyLocalFetch(localPage);
    const port = new DeepSeekFetchPrimary(okApi(), local);
    const page = await port.fetch("https://example.com/ok");
    expect(page.title).toBe("云端代抓");
    expect(page.contentType).toBe("text/markdown");
    expect(local.calls).toBe(0);
  });

  it("官方失败（HTTP 500）→ 回退本地，返回本地页面（含站内链接）", async () => {
    const api = { fetchPage: vi.fn(async () => { throw new DeepSeekApiError("DeepSeek API HTTP 500", 500); }) } as unknown as DeepSeekToolsApi;
    const local = new SpyLocalFetch(localPage);
    const port = new DeepSeekFetchPrimary(api, local);
    const page = await port.fetch("https://blocked.example.com/page");
    expect(local.calls).toBe(1);
    expect(page.title).toBe("本地标题");
    expect(page.links).toEqual(["https://example.com/next"]);
  });

  it("官方返回空正文 → 视为失败，回退本地", async () => {
    const api = new DeepSeekToolsApi({
      apiKey: "k",
      baseUrl: "https://api.deepseek.com",
      fetchImpl: jsonFetch([{ match: /fetch$/, body: { title: "", content: "   " } }]),
    });
    const local = new SpyLocalFetch(localPage);
    const port = new DeepSeekFetchPrimary(api, local);
    const page = await port.fetch("https://empty.example.com/x");
    expect(local.calls).toBe(1);
    expect(page.text).toBe("本地正文");
  });

  it("策略性拒绝（内网 URL）→ 官方与本地都不触发，直接抛 WebFetchError", async () => {
    const api = okApi();
    const local = new SpyLocalFetch(localPage, new Error("不应被调用"));
    const port = new DeepSeekFetchPrimary(api as DeepSeekToolsApi, local);
    await expect(port.fetch("http://127.0.0.1:8000/admin")).rejects.toThrow(WebFetchError);
    expect(api.fetchPage).not.toHaveBeenCalled();
    expect(local.calls).toBe(0);
  });

  it("双方都失败 → 合并两段错误信息（官方在前，本地在后）", async () => {
    const api = { fetchPage: vi.fn(async () => { throw new DeepSeekApiError("DeepSeek API HTTP 404: 无法取得正文", 404); }) } as unknown as DeepSeekToolsApi;
    const local = new SpyLocalFetch(undefined, new WebFetchError("目标返回 HTTP 403"));
    const port = new DeepSeekFetchPrimary(api, local);
    await expect(port.fetch("https://dead.example.com/x")).rejects.toThrow(
      /DeepSeek 官方抓取失败（DeepSeek API HTTP 404.*）.*本地抓取回退也失败（目标返回 HTTP 403）/s,
    );
  });

  it("工厂：无 key / 显式关闭时原样返回本地端口；开启时返回装饰器", () => {
    const saved = { ...config.web };
    try {
      const base: WebFetchPort = { fetch: async () => localPage };
      config.web.deepseekApiKey = "";
      expect(createFetchPortWithDeepseekPrimary(base)).toBe(base);
      config.web.deepseekApiKey = "sk-test";
      config.web.deepseekFetchPrimary = false;
      expect(createFetchPortWithDeepseekPrimary(base)).toBe(base);
      config.web.deepseekFetchPrimary = true;
      expect(createFetchPortWithDeepseekPrimary(base)).not.toBe(base);
    } finally {
      Object.assign(config.web, saved);
    }
  });
});

// ---------- web_search 工具引擎链 ----------

const savedWeb = { ...config.web };
beforeEach(() => {
  Object.assign(config.web, savedWeb, {
    deepseekApiKey: "",
    searchTavilyApiKey: "",
    searchSearxngUrl: "",
    deepseekFetchPrimary: true,
  });
});
afterEach(() => {
  Object.assign(config.web, savedWeb);
  vi.unstubAllGlobals();
});

describe("web_search 引擎链接入 DeepSeek", () => {
  it("配置 key 时 deepseek 为首选引擎：结构化结果 + 元信息渲染", async () => {
    config.web.deepseekApiKey = "sk-test";
    const capture: { url?: string; init?: RequestInit } = {};
    vi.stubGlobal("fetch", jsonFetch([{ match: /v1\/tools\/search/, body: SEARCH_RESPONSE }], capture));

    const out = await createWebSearchTool().execute({ query: "DeepSeek V4 发布", limit: 5 }, ctx());
    const text = content(out);
    expect(capture.url).toContain("/v1/tools/search");
    expect(text).toContain("共 2 条结果（deepseek）");
    expect(text).toContain("[1] DeepSeek V4 模型发布");
    expect(text).toContain("https://example.com/deepseek-v4");
    expect(text).toContain("（发布: 2026-06-01 · 权威: 3/4）");
    // authority=-1 的结果不渲染权威分
    expect(text).not.toContain("权威: -1");
  });

  it("无 key 时引擎链从 baidu/bing 起步（DeepSeek 不在链内），全失败时优雅空结果", async () => {
    vi.stubGlobal("fetch", (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch);
    const out = await createWebSearchTool().execute({ query: "任意" }, ctx());
    expect(content(out)).toContain("未搜索到相关结果");
  });
});

// ---------- fetch_webpage 工具 × DeepSeek 优先 ----------

const publicLookup = (async () => [{ address: "93.184.216.34", family: 4 }]) as unknown as LookupFn;

describe("fetch_webpage × DeepSeek 优先", () => {
  it("官方提供 → 直接输出 Markdown 正文，不发起本地页面请求", async () => {
    config.web.deepseekApiKey = "sk-test";
    const directPageHits: string[] = [];
    vi.stubGlobal("fetch", (async (input: string | URL) => {
      const url = String(input);
      if (/v1\/tools\/fetch$/.test(url)) {
        return new Response(JSON.stringify({ title: "代抓标题", content: "# 代抓 Markdown 正文" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      directPageHits.push(url);
      throw new Error(`不应直接抓取目标页面: ${url}`);
    }) as unknown as typeof fetch);

    const port = createFetchPortWithDeepseekPrimary(new HttpWebFetch(undefined, publicLookup));
    const tool = createFetchWebpageTool(port);
    const out = await tool.execute({ url: "https://blocked.example.com/page" }, ctx());
    expect(directPageHits).toEqual([]);
    expect(content(out)).toContain("标题: 代抓标题");
    expect(content(out)).toContain("代抓 Markdown 正文");
  });

  it("官方失败 → 回退本地抓取（去噪正文 + 站内链接）", async () => {
    config.web.deepseekApiKey = "sk-test";
    vi.stubGlobal("fetch", (async (input: string | URL) => {
      const url = String(input);
      if (/v1\/tools\/fetch$/.test(url)) {
        return new Response(
          JSON.stringify({ error: { message: "无法取得正文", type: "invalid_request_error", param: null, code: "invalid_request_error" } }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }
      if (url === "https://site.example.com/page") {
        return new Response(
          '<html><title>本地标题</title><body><article><p>本地正文内容。</p><a href="/related">站内相关</a></article></body></html>',
          { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch);

    const port = createFetchPortWithDeepseekPrimary(new HttpWebFetch(undefined, publicLookup));
    const tool = createFetchWebpageTool(port);
    const out = await tool.execute({ url: "https://site.example.com/page" }, ctx());
    expect(content(out)).toContain("标题: 本地标题");
    expect(content(out)).toContain("本地正文内容");
    expect(content(out)).toContain("https://site.example.com/related");
  });
});
