import { afterEach, describe, expect, it } from "vitest";
import { createLiteratureClient } from "../src/clients/literature-client.js";
import { config } from "../src/config/index.js";

type Call = { url: string; init?: RequestInit };

/** Fake transport: records every request, never touches the network. */
function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { impl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function headerValue(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

/** Simulates real fetch: the pending request rejects once the signal aborts (timeout). */
function hangingFetch() {
  return stubFetch(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
          once: true,
        });
      }),
  );
}

const literatureConfig = config.academic.literature;
const configSnapshot = { ...literatureConfig };

afterEach(() => {
  Object.assign(literatureConfig, configSnapshot);
});

// ---------------------------------------------------------------------------
// Fixtures (shapes copied from the live APIs, trimmed to the mapped fields)
// ---------------------------------------------------------------------------

const crossrefWork = {
  DOI: "10.1000/ABC",
  title: ["A Study of <i>Graphs</i>"],
  author: [{ given: "San", family: "Zhang" }, { family: "Li" }, { name: "MindBase Consortium" }],
  issued: { "date-parts": [[2024, 5, 1]] },
  "container-title": ["Nature"],
  URL: "https://doi.org/10.1000/abc",
  abstract: "<jats:p>We <jats:italic>study</jats:italic> graphs &amp; more.</jats:p>",
};

const crossrefList = (items: unknown[]) => ({ status: "ok", "message-type": "work-list", message: { items } });

const openalexWork = {
  id: "https://openalex.org/W42",
  title: "Open  Alex   Paper",
  publication_year: 2023,
  doi: "https://doi.org/10.5555/XYZ",
  authorships: [{ author: { display_name: "Alice Smith" } }, { author: { display_name: "Bob Jones" } }],
  primary_location: { source: { display_name: "Journal of Tests" } },
  abstract_inverted_index: { ignored: [0] },
};

const arxivFeed = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">',
  "  <entry>",
  "    <id>http://arxiv.org/abs/2401.00001v1</id>",
  "    <published>2024-01-05T00:00:00Z</published>",
  "    <title>Deep   Learning",
  "      &amp; Graphs</title>",
  "    <summary>We study &lt;graphs&gt; and",
  "      uncertainty.</summary>",
  "    <author><name>Alice Smith</name></author>",
  "    <author><name>Bob Jones</name></author>",
  "  </entry>",
  "  <entry>",
  "    <id>http://arxiv.org/abs/2302.00002v2</id>",
  "    <published>2023-02-01T00:00:00Z</published>",
  "    <title>Second Paper</title>",
  "    <summary>Abstract two.</summary>",
  "    <arxiv:doi>10.1234/ABC</arxiv:doi>",
  "    <author><name>Carol Lee</name></author>",
  "  </entry>",
  "</feed>",
].join(String.fromCharCode(10));

// ---------------------------------------------------------------------------
// Crossref
// ---------------------------------------------------------------------------

describe("Crossref search", () => {
  it("maps works (title/authors/year/venue/DOI/URL/JATS abstract)", async () => {
    literatureConfig.mailto = "";
    const { impl, calls } = stubFetch(() =>
      jsonResponse(crossrefList([crossrefWork, { DOI: "10.1000/no-title" }])),
    );
    const client = createLiteratureClient({ fetchImpl: impl });

    const hits = await client.search("graph neural networks", { limit: 5, source: "crossref" });

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      source: "crossref",
      title: "A Study of Graphs",
      authors: ["San Zhang", "Li", "MindBase Consortium"],
      year: 2024,
      venue: "Nature",
      doi: "10.1000/ABC",
      url: "https://doi.org/10.1000/abc",
    });
    expect(hits[0].abstract).toBe("We study graphs & more.");

    const url = calls[0].url;
    expect(url.startsWith("https://api.crossref.org/works?")).toBe(true);
    expect(url).toContain("query=graph%20neural%20networks");
    expect(url).toContain("&rows=5");
    expect(url).toContain("&select=DOI,title,author,issued,container-title,URL,abstract");
    expect(url).not.toContain("mailto=");
    expect(headerValue(calls[0].init, "user-agent")).toBe("MindBase/1.0 (+https://mindbase.app)");
    expect(headerValue(calls[0].init, "accept")).toBe("application/json");
  });

  it("adds mailto to the query + UA when configured", async () => {
    literatureConfig.mailto = "research@mindbase.app";
    const { impl, calls } = stubFetch(() => jsonResponse(crossrefList([crossrefWork])));
    const client = createLiteratureClient({ fetchImpl: impl });

    await client.search("graphs", { source: "crossref" });

    expect(calls[0].url).toContain("&mailto=research%40mindbase.app");
    expect(headerValue(calls[0].init, "user-agent")).toBe(
      "MindBase/1.0 (+https://mindbase.app; mailto:research@mindbase.app)",
    );
  });

  it("clamps the limit to 1..25 and defaults to config maxResults", async () => {
    literatureConfig.mailto = "";
    literatureConfig.maxResults = 10;
    const { impl, calls } = stubFetch(() => jsonResponse(crossrefList([])));
    const client = createLiteratureClient({ fetchImpl: impl });

    async function rowsFor(limit?: number): Promise<string | undefined> {
      const options = limit === undefined ? { source: "crossref" as const } : { source: "crossref" as const, limit };
      await client.search("q", options);
      return /(?:^|[?&])rows=([0-9]+)/.exec(calls[calls.length - 1].url)?.[1];
    }

    expect(await rowsFor(0)).toBe("1");
    expect(await rowsFor(-3)).toBe("1");
    expect(await rowsFor(999)).toBe("25");
    expect(await rowsFor(7.9)).toBe("7");
    expect(await rowsFor(undefined)).toBe("10");
    expect(calls).toHaveLength(5);
  });

  it("throws a readable error on non-2xx", async () => {
    const { impl } = stubFetch(() => new Response("upstream down", { status: 503 }));
    const client = createLiteratureClient({ fetchImpl: impl });

    await expect(client.search("q", { source: "crossref" })).rejects.toThrow(/Crossref 检索失败.*HTTP 503/);
  });

  it("throws a readable error on invalid JSON", async () => {
    const { impl } = stubFetch(() => new Response("not-json", { status: 200 }));
    const client = createLiteratureClient({ fetchImpl: impl });

    await expect(client.search("q", { source: "crossref" })).rejects.toThrow(/无法解析的 JSON/);
  });

  it("rejects a blank query without touching the network", async () => {
    const { impl, calls } = stubFetch(() => jsonResponse(crossrefList([])));
    const client = createLiteratureClient({ fetchImpl: impl });

    await expect(client.search("   ")).rejects.toThrow(/检索关键词不能为空/);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// OpenAlex
// ---------------------------------------------------------------------------

describe("OpenAlex search", () => {
  it("maps works and strips the DOI resolver prefix", async () => {
    const { impl, calls } = stubFetch(() =>
      jsonResponse({ results: [openalexWork, { id: "https://openalex.org/W0", title: null }] }),
    );
    const client = createLiteratureClient({ fetchImpl: impl });

    const hits = await client.search("open alex", { limit: 2, source: "openalex" });

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      source: "openalex",
      title: "Open Alex Paper",
      authors: ["Alice Smith", "Bob Jones"],
      year: 2023,
      venue: "Journal of Tests",
      doi: "10.5555/XYZ",
      url: "https://openalex.org/W42",
    });
    expect(hits[0].abstract).toBeUndefined();
    expect(calls[0].url).toBe("https://api.openalex.org/works?search=open%20alex&per-page=2");
  });
});

// ---------------------------------------------------------------------------
// auto = Crossref first, OpenAlex fallback
// ---------------------------------------------------------------------------

describe("auto source selection", () => {
  it("falls back to OpenAlex when Crossref errors", async () => {
    const { impl, calls } = stubFetch((url) =>
      url.includes("api.crossref.org")
        ? new Response("boom", { status: 503 })
        : jsonResponse({ results: [openalexWork] }),
    );
    const client = createLiteratureClient({ fetchImpl: impl });

    const hits = await client.search("deep learning", { limit: 3 });

    expect(hits).toHaveLength(1);
    expect(hits[0].source).toBe("openalex");
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain("api.crossref.org");
    expect(calls[1].url).toContain("api.openalex.org/works?search=deep%20learning&per-page=3");
  });

  it("falls back to OpenAlex when Crossref returns no hits", async () => {
    const { impl, calls } = stubFetch((url) =>
      url.includes("api.crossref.org")
        ? jsonResponse(crossrefList([]))
        : jsonResponse({ results: [openalexWork] }),
    );
    const client = createLiteratureClient({ fetchImpl: impl });

    const hits = await client.search("graphs");

    expect(hits).toHaveLength(1);
    expect(hits[0].source).toBe("openalex");
    expect(calls).toHaveLength(2);
  });

  it("throws with both reasons when both sources fail", async () => {
    const { impl } = stubFetch((url) =>
      url.includes("api.crossref.org") ? new Response("down", { status: 503 }) : new Response("down", { status: 500 }),
    );
    const client = createLiteratureClient({ fetchImpl: impl });

    const failure = await client.search("q").then(
      () => null,
      (err: Error) => err,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toContain("Crossref 与 OpenAlex 检索均失败");
    expect(failure?.message).toContain("HTTP 503");
    expect(failure?.message).toContain("HTTP 500");
  });

  it("never falls back for an explicit source", async () => {
    const { impl, calls } = stubFetch(() => jsonResponse(crossrefList([])));
    const client = createLiteratureClient({ fetchImpl: impl });

    const hits = await client.search("q", { source: "crossref" });

    expect(hits).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// arXiv
// ---------------------------------------------------------------------------

describe("arXiv search", () => {
  it("parses Atom entries with a regex (no XML dependency)", async () => {
    const { impl, calls } = stubFetch(
      () => new Response(arxivFeed, { status: 200, headers: { "content-type": "application/atom+xml" } }),
    );
    const client = createLiteratureClient({ fetchImpl: impl });

    const hits = await client.search("quantum computing", { limit: 3, source: "arxiv" });

    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({
      source: "arxiv",
      title: "Deep Learning & Graphs",
      authors: ["Alice Smith", "Bob Jones"],
      year: 2024,
      url: "http://arxiv.org/abs/2401.00001v1",
      venue: "arXiv",
    });
    expect(hits[0].abstract).toBe("We study <graphs> and uncertainty.");
    expect(hits[0].doi).toBeUndefined();
    expect(hits[1].title).toBe("Second Paper");
    expect(hits[1].year).toBe(2023);
    expect(hits[1].doi).toBe("10.1234/ABC");

    expect(calls[0].url).toBe(
      "https://export.arxiv.org/api/query?search_query=all:quantum%20computing&start=0&max_results=3",
    );
    expect(headerValue(calls[0].init, "accept")).toBe("application/atom+xml");
  });

  it("throws a readable error on non-2xx", async () => {
    const { impl } = stubFetch(() => new Response("down", { status: 500 }));
    const client = createLiteratureClient({ fetchImpl: impl });

    await expect(client.search("q", { source: "arxiv" })).rejects.toThrow(/arXiv 检索失败.*HTTP 500/);
  });
});

// ---------------------------------------------------------------------------
// DOI verification (lookupDoi)
// ---------------------------------------------------------------------------

describe("lookupDoi", () => {
  it("normalizes the DOI and returns null on 404", async () => {
    const { impl, calls } = stubFetch(() => jsonResponse({ status: "error" }, 404));
    const client = createLiteratureClient({ fetchImpl: impl });

    expect(await client.lookupDoi("https://doi.org/10.1000/ABC")).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.crossref.org/works/10.1000%2Fabc");
  });

  it("returns verified Crossref metadata for a known DOI", async () => {
    const work = {
      DOI: "10.1000/abc",
      title: ["Verified Paper"],
      author: [{ given: "San", family: "Zhang" }],
      issued: { "date-parts": [[2022]] },
      "container-title": ["Science"],
      URL: "https://doi.org/10.1000/abc",
      abstract: "<jats:p>ok</jats:p>",
    };
    const { impl } = stubFetch(() => jsonResponse({ status: "ok", message: work }));
    const client = createLiteratureClient({ fetchImpl: impl });

    const hit = await client.lookupDoi("10.1000/abc");

    expect(hit).toMatchObject({
      source: "crossref",
      title: "Verified Paper",
      authors: ["San Zhang"],
      year: 2022,
      venue: "Science",
      doi: "10.1000/abc",
    });
    expect(hit?.abstract).toBe("ok");
  });

  it("returns null for a blank/malformed DOI without any request", async () => {
    const { impl, calls } = stubFetch(() => jsonResponse({ status: "ok", message: crossrefWork }));
    const client = createLiteratureClient({ fetchImpl: impl });

    expect(await client.lookupDoi("   ")).toBeNull();
    expect(await client.lookupDoi("https://doi.org/")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("throws on non-404 failures", async () => {
    const { impl } = stubFetch(() => new Response("down", { status: 500 }));
    const client = createLiteratureClient({ fetchImpl: impl });

    await expect(client.lookupDoi("10.1000/abc")).rejects.toThrow(/DOI 核验失败.*HTTP 500/);
  });
});

// ---------------------------------------------------------------------------
// Transport: timeouts + network failures
// ---------------------------------------------------------------------------

describe("transport guards", () => {
  it("rejects with a timeout error using the injected timeoutMs", async () => {
    const { impl } = hangingFetch();
    const client = createLiteratureClient({ fetchImpl: impl, timeoutMs: 20 });

    await expect(client.search("q", { source: "crossref" })).rejects.toThrow(/Crossref 请求超时（20ms）/);
  });

  it("uses config.academic.literature.timeoutMs by default", async () => {
    literatureConfig.timeoutMs = 25;
    const { impl } = hangingFetch();
    const client = createLiteratureClient({ fetchImpl: impl });

    await expect(client.search("q", { source: "crossref" })).rejects.toThrow(/请求超时（25ms）/);
  });

  it("wraps network failures in a readable error", async () => {
    const { impl } = stubFetch(() => Promise.reject(new TypeError("fetch failed")));
    const client = createLiteratureClient({ fetchImpl: impl });

    await expect(client.search("q", { source: "crossref" })).rejects.toThrow(/Crossref 请求失败.*fetch failed/);
  });
});


// ---------------------------------------------------------------------------
// TTL cache (process-local, bounded, successful results only)
// ---------------------------------------------------------------------------

describe("TTL cache", () => {
  it("serves an identical search from cache and returns isolated copies", async () => {
    literatureConfig.mailto = "";
    const { impl, calls } = stubFetch(() => jsonResponse(crossrefList([crossrefWork])));
    const client = createLiteratureClient({ fetchImpl: impl });

    const first = await client.search("Graph Models", { limit: 5, source: "crossref" });
    const second = await client.search("  graph models  ", { limit: 5, source: "crossref" });

    expect(calls).toHaveLength(1);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(second[0]).not.toBe(first[0]);

    // Mutating a returned snapshot must never poison the cached entry.
    first[0].authors.push("Mutated");
    first[0].title = "Mutated";

    const third = await client.search("graph models", { limit: 5, source: "crossref" });
    expect(calls).toHaveLength(1);
    expect(third[0]?.title).toBe("A Study of Graphs");
    expect(third[0]?.authors).not.toContain("Mutated");
  });

  it("expires a search entry exactly at the 5 minute deadline", async () => {
    literatureConfig.mailto = "";
    let now = 1_000_000;
    const { impl, calls } = stubFetch(() => jsonResponse(crossrefList([crossrefWork])));
    const client = createLiteratureClient({ fetchImpl: impl, now: () => now });

    await client.search("graphs", { source: "crossref" });
    expect(calls).toHaveLength(1);

    now += 5 * 60 * 1000 - 1;
    await client.search("graphs", { source: "crossref" });
    expect(calls).toHaveLength(1);

    now += 1;
    await client.search("graphs", { source: "crossref" });
    expect(calls).toHaveLength(2);
  });

  it("keys cache entries by source and requested limit", async () => {
    literatureConfig.mailto = "";
    const { impl, calls } = stubFetch((url) =>
      url.includes("openalex")
        ? jsonResponse({ results: [openalexWork] })
        : jsonResponse(crossrefList([crossrefWork])),
    );
    const client = createLiteratureClient({ fetchImpl: impl });

    await client.search("q", { limit: 5, source: "crossref" });
    await client.search("q", { limit: 6, source: "crossref" });
    await client.search("q", { limit: 5, source: "openalex" });
    await client.search("q", { limit: 5 });
    expect(calls).toHaveLength(4);

    // The same three explicit identities are all served from cache now.
    await client.search("q", { limit: 5, source: "crossref" });
    await client.search("q", { limit: 6, source: "crossref" });
    await client.search("q", { limit: 5, source: "openalex" });
    expect(calls).toHaveLength(4);
  });

  it("never caches a rejection so a transient failure can recover", async () => {
    let attempt = 0;
    const { impl, calls } = stubFetch(() => {
      attempt += 1;
      return attempt === 1
        ? new Response("upstream down", { status: 503 })
        : jsonResponse(crossrefList([crossrefWork]));
    });
    const client = createLiteratureClient({ fetchImpl: impl });

    await expect(client.search("graphs", { source: "crossref" })).rejects.toThrow(/HTTP 503/);
    const hits = await client.search("graphs", { source: "crossref" });

    expect(hits).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it("caches an empty result so a repeated empty query stays offline", async () => {
    literatureConfig.mailto = "";
    const { impl, calls } = stubFetch(() => jsonResponse(crossrefList([])));
    const client = createLiteratureClient({ fetchImpl: impl });

    expect(await client.search("no such paper", { source: "crossref" })).toEqual([]);
    expect(await client.search("no such paper", { source: "crossref" })).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("caches lookupDoi null and refetches after the 1 hour TTL", async () => {
    let now = 42;
    const { impl, calls } = stubFetch(() => jsonResponse({ status: "error" }, 404));
    const client = createLiteratureClient({ fetchImpl: impl, now: () => now });

    // The resolver-URL form and the bare DOI normalize to the same cache key.
    expect(await client.lookupDoi("https://doi.org/10.1000/ABC")).toBeNull();
    expect(await client.lookupDoi("10.1000/abc")).toBeNull();
    expect(calls).toHaveLength(1);

    now += 60 * 60 * 1000;
    expect(await client.lookupDoi("10.1000/abc")).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("evicts the oldest search entry at the 100-key cap", async () => {
    literatureConfig.mailto = "";
    const { impl, calls } = stubFetch(() => jsonResponse(crossrefList([])));
    const client = createLiteratureClient({ fetchImpl: impl });

    for (let index = 0; index <= 100; index += 1) {
      await client.search("query " + index, { source: "crossref" });
    }
    expect(calls).toHaveLength(101);

    // The first query was evicted by the cap, so it is a miss again.
    await client.search("query 0", { source: "crossref" });
    expect(calls).toHaveLength(102);

    // The newest query is still cached.
    await client.search("query 100", { source: "crossref" });
    expect(calls).toHaveLength(102);
  });
});

