import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  assertPublicUrl,
  isPrivateIp,
  HttpWebFetch,
  WebFetchError,
  type LookupFn,
  type WebFetchPort,
  type WebPage,
  type WebFetchOptions,
} from "../src/tools/web/fetcher.js";
import { extractReadable } from "../src/tools/web/html-cleaner.js";
import { createFetchWebpageTool } from "../src/tools/web/fetch-page.js";

/** Test stub with canned pages (the port interface lives in fetcher.ts). */
class MemoryWebFetch implements WebFetchPort {
  constructor(private readonly pages: Record<string, Omit<WebPage, "url" | "finalUrl">> = {}) {}

  seed(url: string, page: Omit<WebPage, "url" | "finalUrl">): void {
    this.pages[url] = page;
  }

  async fetch(url: string, _opts?: WebFetchOptions): Promise<WebPage> {
    const canned = this.pages[url];
    if (!canned) {
      throw new Error(`HTTP 404（stub 中没有该页面）: ${url}`);
    }
    return { ...canned, url, finalUrl: url };
  }
}
import { ResultCollector } from "../src/context/types.js";
import { config } from "../src/config/index.js";

function ctx() {
  return { uid: 1, chatSessionId: "s1", scope: {}, collector: new ResultCollector() };
}

const content = (out: unknown) => (typeof out === "string" ? out : (out as { content: string }).content);

const publicLookup = (async () => [{ address: "93.184.216.34", family: 4 }]) as unknown as LookupFn;

// ---------- SSRF guards ----------

describe("SSRF guards", () => {
  it("blocks private/loopback/metadata IP literals", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.1.1", "172.16.0.9", "169.254.169.254", "0.0.0.0", "100.64.1.1", "::1", "fe80::1", "fd00::1", "::ffff:10.0.0.1"]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700::1111"]) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });

  it("assertPublicUrl rejects non-http schemes and blocked hostnames", () => {
    for (const bad of [
      "file:///etc/passwd",
      "ftp://example.com/x",
      "http://localhost/x",
      "http://127.0.0.1:8000/x",
      "http://169.254.169.254/latest/meta-data",
      "http://foo.internal/x",
      "http://box.local/x",
    ]) {
      expect(() => assertPublicUrl(bad), bad).toThrow(WebFetchError);
    }
    expect(assertPublicUrl("https://example.com/page").hostname).toBe("example.com");
  });

  it("rejects public hostnames resolving to private IPs (DNS re-check)", async () => {
    const fakeLookup = (async (_host: string, _opts: unknown) => [
      { address: "10.0.0.5", family: 4 },
    ]) as unknown as LookupFn;
    const f = new HttpWebFetch(vi.fn(), fakeLookup);
    await expect(f.fetch("https://evil.example.com/x")).rejects.toThrow(/解析到内网/);
  });
});

// ---------- redirect hops ----------

function redirectChain(hops: Array<{ url: string; status?: number; location?: string; body?: string }>) {
  const map = new Map(hops.map((h) => [h.url, h]));
  const fetchImpl = (async (input: string | URL) => {
    const entry = map.get(String(input));
    if (!entry) throw new Error(`unexpected fetch: ${input}`);
    const status = entry.status ?? 200;
    const headers = new Headers();
    if (entry.location) headers.set("location", entry.location);
    headers.set("content-type", "text/html; charset=utf-8");
    return new Response(entry.body ?? "<html><body>ok</body></html>", { status, headers });
  }) as unknown as typeof fetch;
  return fetchImpl;
}

describe("HttpWebFetch redirects", () => {
  it("follows public redirect hops and re-validates each one", async () => {
    const fetchImpl = redirectChain([
      { url: "https://a.example.com/start", status: 302, location: "https://b.example.com/landing" },
      { url: "https://b.example.com/landing", body: "<html><title>落点</title><p>正文内容</p></html>" },
    ]);
    const f = new HttpWebFetch(fetchImpl, publicLookup);
    const page = await f.fetch("https://a.example.com/start");
    expect(page.finalUrl).toBe("https://b.example.com/landing");
    expect(page.title).toBe("落点");
    expect(page.text).toContain("正文内容");
  });

  it("a redirect bouncing into a private network is rejected", async () => {
    const fetchImpl = redirectChain([
      { url: "https://a.example.com/start", status: 302, location: "http://127.0.0.1:8008/admin" },
    ]);
    const f = new HttpWebFetch(fetchImpl, publicLookup);
    await expect(f.fetch("https://a.example.com/start")).rejects.toThrow(/内网|保留地址/);
  });

  it("redirect loops hit the hop limit", async () => {
    const fetchImpl = redirectChain([
      { url: "https://a.example.com/1", status: 302, location: "https://a.example.com/2" },
      { url: "https://a.example.com/2", status: 302, location: "https://a.example.com/1" },
    ]);
    const f = new HttpWebFetch(fetchImpl, publicLookup);
    await expect(f.fetch("https://a.example.com/1")).rejects.toThrow(/重定向次数超过上限/);
  });
});

// ---------- HTML cleaning pipeline ----------

const NOISY_PAGE = `<html>
<head>
  <title>RAG 检索实践</title>
  <meta name="description" content="一篇关于向量检索的文章">
  <style>.ad{display:none}</style>
  <script>var tracking = "secret-pixel";</script>
</head>
<body>
  <!-- 渲染前的页面注释 -->
  <nav><a href="/home">首页</a><a href="/category">分类</a></nav>
  <div class="cookie-banner">本站使用 Cookie</div>
  <header><h1>站点名</h1></header>
  <aside class="sidebar">热榜：大家都在看</aside>
  <div class="advertisement">广告位招租</div>
  <div style="display:none">隐藏的 SEO 堆砌文本</div>
  <div aria-hidden="true">屏幕阅读器专用文本</div>
  <article>
    <h1>向量检索实践</h1>
    <p>第一段：&nbsp;嵌入模型选择 &amp; 分块策略。</p>
    <h2>分块策略</h2>
    <ul>
      <li>固定长度分块</li>
      <li>语义分块</li>
    </ul>
    <table>
      <tr><th>方法</th><th>召回率</th></tr>
      <tr><td>BM25</td><td>0.72</td></tr>
    </table>
    <p>第二段：混合检索与重排序。</p>
    <a href="/related">站内相关</a>
    <a href="https://other.example.com/post/2">站外链接</a>
    <a href="#section">页内锚点</a>
  </article>
  <footer>© 2026 SomeSite · 隐私政策</footer>
</body>
</html>`;

describe("extractReadable 清洗管线", () => {
  const baseUrl = new URL("https://news.example.com/post/1");

  it("噪声元素整体移除，正文与元信息保留", () => {
    const page = extractReadable(NOISY_PAGE, baseUrl);
    expect(page.title).toBe("RAG 检索实践");
    expect(page.description).toBe("一篇关于向量检索的文章");

    expect(page.text).toContain("向量检索实践");
    expect(page.text).toContain("第一段： 嵌入模型选择 & 分块策略。"); // &nbsp;/&amp; 由解析器解码
    expect(page.text).toContain("第二段：混合检索与重排序。");

    expect(page.text).not.toContain("本站使用 Cookie");
    expect(page.text).not.toContain("广告位招租");
    expect(page.text).not.toContain("隐藏的 SEO");
    expect(page.text).not.toContain("屏幕阅读器专用");
    expect(page.text).not.toContain("热榜");
    expect(page.text).not.toContain("站点名"); // <header> 整体移除
    expect(page.text).not.toContain("© 2026");
    expect(page.text).not.toContain("首页"); // nav 整体移除
    expect(page.text).not.toContain("secret-pixel");
    expect(page.text).not.toContain("渲染前的页面注释");
  });

  it("结构保留：标题层级 / 列表 / 表格", () => {
    const { text } = extractReadable(NOISY_PAGE, baseUrl);
    expect(text).toContain("# 向量检索实践");
    expect(text).toContain("## 分块策略");
    expect(text).toContain("- 固定长度分块");
    expect(text).toContain("- 语义分块");
    expect(text).toContain("方法 | 召回率");
    expect(text).toContain("BM25 | 0.72");
  });

  it("链接来自清洗后的 DOM：噪声链接消失、锚点跳过、SSRF 预筛", () => {
    const { links } = extractReadable(NOISY_PAGE, baseUrl);
    expect(links).toEqual([
      "https://news.example.com/related",
      "https://other.example.com/post/2",
    ]);
  });

  it("主内容优先：article 之外的正文噪声不进入结果", () => {
    const page = extractReadable(
      `<html><body>
        <p>页面顶部公告：系统将于今晚维护。</p>
        <main>
          <h1>主文档标题</h1>
          <p>${"主内容句子。".repeat(60)}</p>
        </main>
        <p>底部尾巴文本。</p>
      </body></html>`,
      baseUrl,
    );
    expect(page.text).toContain("主文档标题");
    expect(page.text).toContain("主内容句子。");
    expect(page.text).not.toContain("页面顶部公告");
    expect(page.text).not.toContain("底部尾巴文本");
  });

  it("无 article/main 候选时回退全文（仅去噪）", () => {
    const { text } = extractReadable(
      `<html><body><div class="ads">广告</div><p>普通页面正文，第一行。</p><p>第二行。</p></body></html>`,
      baseUrl,
    );
    expect(text).toContain("普通页面正文，第一行。");
    expect(text).toContain("第二行。");
    expect(text).not.toContain("广告");
  });

  it("class/id 关键词按整词分词匹配，不误伤普通词汇", () => {
    const { text } = extractReadable(
      `<html><body>
        <div class="readmore">延伸阅读内容保留</div>
        <div class="advert-box">这是广告</div>
      </body></html>`,
      baseUrl,
    );
    expect(text).toContain("延伸阅读内容保留"); // "readmore" ≠ token "ad"
    expect(text).not.toContain("这是广告");
  });
});

// ---------- charset + per-host politeness ----------

const savedWeb = { ...config.web };
beforeEach(() => {
  // file-wide default: no politeness wait unless a test opts in (redirect chains
  // hit the same host repeatedly and would otherwise serialize on the interval)
  Object.assign(config.web, savedWeb, { perHostIntervalMs: 0 });
});
afterEach(() => {
  Object.assign(config.web, savedWeb);
});

describe("HttpWebFetch charset 与礼貌限速", () => {
  it("declared charset=GBK decodes correctly (naive UTF-8 would garble it)", async () => {
    // "中文内容测试" in GBK bytes (Buffer.from(str, "gbk") needs full-icu)
    const bytes = Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4, 0xc4, 0xda, 0xc8, 0xdd, 0xb2, 0xe2, 0xca, 0xd4]);
    const fetchImpl = (async () =>
      new Response(bytes, { status: 200, headers: { "content-type": "text/html; charset=gbk" } })) as unknown as typeof fetch;
    const f = new HttpWebFetch(fetchImpl, publicLookup);
    const page = await f.fetch("https://gbk.example.com/page");
    expect(page.text).toContain("中文内容测试");
  });

  it("same-host requests wait out the politeness gap; other hosts don't wait", async () => {
    config.web.perHostIntervalMs = 300;
    const times: number[] = [];
    const fetchImpl = (async () => {
      times.push(Date.now());
      return new Response("<html><body>ok</body></html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    }) as unknown as typeof fetch;
    const f = new HttpWebFetch(fetchImpl, publicLookup);

    await f.fetch("https://site1.example.com/a");
    await f.fetch("https://site1.example.com/b"); // same host → waits ~300ms
    await f.fetch("https://site2.example.com/c"); // other host → no wait

    // generous margins: wall-clock assertions must survive parallel-worker load
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(250);
    expect(times[2] - times[1]).toBeLessThan(250);
  });

  it("abort while waiting the politeness gap rejects", async () => {
    config.web.perHostIntervalMs = 5000;
    const fetchImpl = (async () =>
      new Response("<html><body>ok</body></html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })) as unknown as typeof fetch;
    const f = new HttpWebFetch(fetchImpl, publicLookup);
    await f.fetch("https://site3.example.com/a"); // primes the host timestamp
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    await expect(f.fetch("https://site3.example.com/a", { signal: controller.signal })).rejects.toThrow(/取消/);
  });
});

// ---------- tool wiring ----------

describe("fetch_webpage tool", () => {
  it("returns title/text/links; truncates long text at maxChars", async () => {
    const port = new MemoryWebFetch();
    port.seed("https://example.com/long", {
      title: "长文",
      text: "字".repeat(9000),
      links: ["https://example.com/next"],
      contentType: "text/html",
      bytes: 9000,
    });
    const tool = createFetchWebpageTool(port);
    const out = await tool.execute({ url: "https://example.com/long", maxChars: 1000 }, ctx());
    const text = content(out);
    expect(text).toContain("标题: 长文");
    expect(text).toContain("已截断：共 9000 字符");
    expect(text).toContain("https://example.com/next");
  });

  it("meta description surfaces as 摘要 line when the port provides one", async () => {
    const port = new MemoryWebFetch();
    port.seed("https://example.com/desc", {
      title: "有摘要",
      description: "这是页面摘要",
      text: "正文",
      links: [],
      contentType: "text/html",
      bytes: 100,
    });
    const tool = createFetchWebpageTool(port);
    const out = await tool.execute({ url: "https://example.com/desc" }, ctx());
    expect(content(out)).toContain("摘要: 这是页面摘要");
  });

  it("upstream failures surface as readable errors (runtime isolates them anyway)", async () => {
    const tool = createFetchWebpageTool(new MemoryWebFetch());
    await expect(tool.execute({ url: "https://example.com/missing" }, ctx())).rejects.toThrow(/404/);
  });

  it("non-http URLs are rejected before reaching the port", async () => {
    const tool = createFetchWebpageTool(new MemoryWebFetch());
    await expect(tool.execute({ url: "ftp://example.com/x" }, ctx())).rejects.toThrow();
  });
});
