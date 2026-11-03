/**
 * Literature search client — the outbound network boundary of the academic
 * workspace.
 *
 * Sources are layered by coverage: Crossref (metadata of record, and the only
 * source used for DOI verification) → OpenAlex (broad, permissive fallback) →
 * arXiv (preprints, Atom feed). Each source is a mapping adapter that normalizes
 * its own payload into the same `LiteratureHit` shape, so callers never branch
 * on the source. Tools import ONLY the `LiteratureClient` port — no other file
 * performs literature HTTP calls.
 *
 * Invariants / contract conventions:
 *  - every hit is "unverified" by construction: this layer never assigns a
 *    verification state. A search hit means "the index knows this record", never
 *    "the citation is proven"; only a resolved `lookupDoi` can support the
 *    verified state, and tools/repository own that decision;
 *  - rejections always carry human-readable text (Chinese user-facing wording,
 *    `[LITERATURE]` prefix). The tool layer turns a rejection into guidance text,
 *    so an empty result is returned as an empty array — never as a throw;
 *  - `fetch` + timeout + clock are injectable (`LiteratureClientDeps`) so unit
 *    tests are fully offline and can simulate hangs, network failures and TTL
 *    boundaries;
 *  - results pass through a bounded process-local TTL cache: search entries live
 *    5 minutes (max 100 keys, key = source | normalized query | requested
 *    limit) and DOI lookups 1 hour (max 200 keys, key = normalized DOI); only
 *    successful results are memoized (empty arrays and "unknown DOI" nulls
 *    included), failures never are, and callers always receive fresh copies so
 *    a cached hit cannot be mutated by the tool layer;
 *  - no retries and no internal rate limiting beyond the cache: a cache miss
 *    issues at most one request per source (auto mode may issue two).
 *
 * Endpoints/politeness come from `config.academic.literature` (Crossref and
 * OpenAlex are polite pools: we send a readable User-Agent and, when a contact
 * is configured, a `mailto` query parameter).
 */
import { config } from "../config/index.js";
import { createLogger } from "../logger.js";
import { normalizeDoi } from "../repository/academic.js";

const log = createLogger("LITERATURE");

/** Metadata source of a hit; "crossref" is the only source that can back DOI verification. */
export type LiteratureSource = "crossref" | "openalex" | "arxiv";

/**
 * Normalized metadata record. Only `source` / `title` / `authors` are always
 * present; every other field is best-effort and omitted (not empty-string) when
 * the upstream payload does not carry it, so consumers must test for absence
 * rather than falsiness.
 */
export interface LiteratureHit {
  source: LiteratureSource;
  title: string;
  authors: string[];
  year?: number;
  /** journal / conference / repository name */
  venue?: string;
  doi?: string;
  url?: string;
  abstract?: string;
}

/**
 * Search tuning. An omitted `source` means "auto"; an omitted `limit` falls back
 * to `config.academic.literature.maxResults` (clamped to 1..25 by the client).
 */
export interface LiteratureSearchOptions {
  limit?: number;
  /** auto = Crossref first, OpenAlex fallback; explicit = that source only */
  source?: "auto" | LiteratureSource;
}

/**
 * Port consumed by the academic tools. The composition root builds one instance
 * and every tool invocation shares it; the implementation may keep the bounded
 * process-local result cache documented in the module docblock, so two calls
 * asking the same thing can legitimately share one upstream request. Callers
 * must treat returned hits as read-only snapshots (cached results are copied).
 */
export interface LiteratureClient {
  /**
   * Search the selected source(s) and map the payload to hits. Resolves with a
   * possibly empty array; rejects with readable text on transport/payload
   * failure (see the module docblock). A blank query rejects before any I/O.
   */
  search(query: string, options?: LiteratureSearchOptions): Promise<LiteratureHit[]>;
  /**
   * DOI → metadata verified against Crossref; `source` on the result is always
   * "crossref". Returns null when the DOI is malformed (no request is sent) or
   * unknown to Crossref (HTTP 404); any other failure rejects.
   */
  lookupDoi(doi: string): Promise<LiteratureHit | null>;
}

/** Test seams; production wiring calls `createLiteratureClient()` with no arguments. */
export interface LiteratureClientDeps {
  /** injectable for tests; defaults to global fetch */
  fetchImpl?: typeof fetch;
  /** defaults to config.academic.literature.timeoutMs */
  timeoutMs?: number;
  /** clock injection for TTL tests; defaults to Date.now */
  now?: () => number;
}

/**
 * Build the live client against the endpoints configured in
 * `config.academic.literature`.
 *
 * The result is wrapped in the process-local TTL cache described in the module
 * docblock, so repeated identical calls within the window never reach the
 * network.
 *
 * The deps exist purely for tests: they let a unit test record request URLs and
 * replay fixtures offline, simulate a hanging transport, or drive the cache
 * clock. An invalid timeout injection (non-number, non-finite, <= 0) is ignored
 * in favour of the configured timeout, so a bad test knob can never disable the
 * deadline.
 */
export function createLiteratureClient(deps: LiteratureClientDeps = {}): LiteratureClient {
  const configured = config.academic.literature.timeoutMs;
  const timeoutMs =
    typeof deps.timeoutMs === "number" && Number.isFinite(deps.timeoutMs) && deps.timeoutMs > 0
      ? deps.timeoutMs
      : configured;
  const inner = new HttpLiteratureClient(deps.fetchImpl ?? fetch, timeoutMs);
  return new CachingLiteratureClient(inner, deps.now ?? Date.now);
}

// ---------------------------------------------------------------------------
// Small pure helpers (shape guards + text cleanup)
// ---------------------------------------------------------------------------

// Upstream payloads are untrusted: fields are missing, null, or typed differently
// across records and API versions, so every access goes through a narrowing
// helper instead of a cast. The helpers are total (they never throw) — a
// malformed record must degrade into a dropped field, never a failed search.

type JsonObject = Record<string, unknown>;

/** Hard clamp for one search: protects upstream quotas and the LLM context budget. */
const MIN_RESULTS = 1;
const MAX_RESULTS = 25;
/** Only used when the configured cap is itself invalid (YAML/env are not type-checked). */
const FALLBACK_RESULTS = 10;
/** Project homepage embedded in the polite-pool User-Agent. */
const SITE_URL = "https://mindbase.app";
/** Crossref fields requested by `select` (order matters only for URL assertions). */
const CROSSREF_SELECT = "DOI,title,author,issued,container-title,URL,abstract";

/** Narrow to a plain JSON object; arrays and null are rejected because both show up in payloads. */
function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : null;
}

/** Array view of an optional field (absent/null/wrong type all read as empty, so callers never guard twice). */
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** String view; non-strings read as empty so downstream `.trim()` chains stay total. */
function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Finite-number view; NaN/Infinity and numeric strings are treated as absent. */
function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 2024 / "2024" / "2024-01-02" → 2024 (anything else → undefined); year is optional metadata, never guessed. */
function asYear(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string") {
    const match = /^(\d{4})/.exec(value.trim());
    if (match?.[1]) return Number.parseInt(match[1], 10);
  }
  return undefined;
}

/** Crossref titles/venues are arrays; take the first non-empty string (single values still encode as one-element arrays). */
function firstString(value: unknown): string {
  for (const item of asArray(value)) {
    const text = asString(item).trim();
    if (text) return text;
  }
  return "";
}

/**
 * Decode the XML/HTML entities that show up in Crossref JATS + Atom payloads
 * (named entities plus decimal/hex character references). Unknown entities are
 * left verbatim so a malformed payload stays visible instead of being mangled.
 */
function decodeEntities(raw: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return raw.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1]?.toLowerCase() === "x";
      const code = hex ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return named[body.toLowerCase()] ?? match;
  });
}

/** Collapse newlines/indentation (Crossref + arXiv love pretty-printing); whitespace-normalized text is also what later title matching expects. */
function cleanInlineText(raw: string): string {
  return decodeEntities(raw).replace(/\s+/g, " ").trim();
}

/** Crossref abstracts are JATS: strip tags FIRST, then decode — decoding first could turn text content into markup that would then be stripped. */
function stripMarkup(raw: string): string {
  return cleanInlineText(raw.replace(/<[^>]*>/g, " "));
}

/** Normalizes any thrown value into error text (non-Error values are stringified); never throws itself. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Config values may be padded or end with "/" — normalize so URL joins never produce "//". */
function trimBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * Polite-pool User-Agent (`MindBase/1.0 (+<site>)`). The `mailto` suffix is only
 * appended when a contact is configured: Crossref/OpenAlex serve identifiable
 * clients better, but sending an empty `mailto:` would look broken.
 */
function buildUserAgent(mailto: string): string {
  const contact = mailto.trim();
  return contact ? `MindBase/1.0 (+${SITE_URL}; mailto:${contact})` : `MindBase/1.0 (+${SITE_URL})`;
}

/**
 * Requested result count, clamped to 1..25:
 * omitted/invalid request → configured cap; invalid configured cap (<= 0, NaN)
 * → FALLBACK_RESULTS; fractional values are truncated (7.9 → 7).
 */
function resolveLimit(limit: number | undefined): number {
  const configured = asNumber(config.academic.literature.maxResults) ?? FALLBACK_RESULTS;
  const requested = asNumber(limit) ?? configured;
  return Math.min(MAX_RESULTS, Math.max(MIN_RESULTS, Math.trunc(requested)));
}

// ---------------------------------------------------------------------------
// Source mappers (raw API payload → LiteratureHit)
// ---------------------------------------------------------------------------

/**
 * Crossref work item → hit.
 *
 * Payload quirks handled here: `title` / `container-title` are arrays, `issued` is
 * { "date-parts": [[year, month?, day?]] }, `abstract` is JATS XML, and authors
 * come either as { given, family } pairs or as a single `name` (organizations).
 *
 * Returns null when the record carries no usable title: title is the only field
 * treated as mandatory (it is also the dedupe fallback) and a titleless record
 * can never be shown to the LLM. DOI keeps the upstream casing — normalization
 * is the repository's job, so this layer must not silently rewrite identity.
 */
function mapCrossrefItem(raw: unknown): LiteratureHit | null {
  const item = asObject(raw);
  if (!item) return null;
  const title = stripMarkup(firstString(item.title));
  if (!title) return null;
  const authors = asArray(item.author)
    .map((author) => {
      const record = asObject(author);
      if (!record) return "";
      const name = [asString(record.given).trim(), asString(record.family).trim()].filter(Boolean).join(" ");
      return name || asString(record.name).trim();
    })
    .filter((name) => name.length > 0);
  const issued = asObject(item.issued);
  const dateParts = asArray(issued?.["date-parts"]);
  const year = asYear(asArray(dateParts[0])[0]);
  const venue = stripMarkup(firstString(item["container-title"]));
  const doi = asString(item.DOI).trim();
  const url = asString(item.URL).trim();
  const abstract = stripMarkup(asString(item.abstract));
  return {
    source: "crossref",
    title,
    authors,
    year,
    venue: venue || undefined,
    doi: doi || undefined,
    url: url || undefined,
    abstract: abstract || undefined,
  };
}

/**
 * OpenAlex work item → hit.
 *
 * `doi` arrives as a resolver URL ("https://doi.org/10.x/y"), so the prefix is
 * stripped to keep the same bare-DOI shape as Crossref (otherwise the two sources
 * would produce different dedupe identities for the same paper).
 * `abstract_inverted_index` is deliberately ignored: reconstructing it is lossy
 * and costly, and "no abstract" is a valid state for a search hit.
 * Returns null when no title is present (same rule as Crossref).
 */
function mapOpenAlexItem(raw: unknown): LiteratureHit | null {
  const item = asObject(raw);
  if (!item) return null;
  const title = cleanInlineText(asString(item.title));
  if (!title) return null;
  const authors = asArray(item.authorships)
    .map((authorship) => asString(asObject(asObject(authorship)?.author)?.display_name).trim())
    .filter((name) => name.length > 0);
  const year = asYear(item.publication_year);
  const venue = asString(asObject(asObject(item.primary_location)?.source)?.display_name).trim();
  const doi = asString(item.doi)
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
  const url = asString(item.id).trim();
  return {
    source: "openalex",
    title,
    authors,
    year,
    venue: venue || undefined,
    doi: doi || undefined,
    url: url || undefined,
  };
}

/** First `<tag ...>…</tag>` text content inside an Atom entry (non-greedy; "" when absent). */
function xmlTag(body: string, tag: string): string {
  return new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(body)?.[1] ?? "";
}

/**
 * arXiv Atom feed → hits.
 *
 * Regex parsing (rather than an XML parser) keeps this dependency-free and lets
 * the unit tests feed a fixture string. Only `<entry>` elements are read — feed
 * metadata is ignored — and `venue` is fixed to "arXiv" because the feed carries
 * no journal name. An entry without a title is skipped; an unparsable feed
 * yields [] rather than throwing (the HTTP layer already validated the status).
 */
function parseArxivFeed(xml: string): LiteratureHit[] {
  const hits: LiteratureHit[] = [];
  for (const entry of xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)) {
    const body = entry[1] ?? "";
    const title = cleanInlineText(xmlTag(body, "title"));
    if (!title) continue;
    const authors = [...body.matchAll(/<name\b[^>]*>([\s\S]*?)<\/name>/gi)]
      .map((match) => cleanInlineText(match[1] ?? ""))
      .filter((name) => name.length > 0);
    const year = asYear(xmlTag(body, "published"));
    const url = cleanInlineText(xmlTag(body, "id"));
    const abstract = cleanInlineText(xmlTag(body, "summary"));
    const doi = cleanInlineText(xmlTag(body, "arxiv:doi"));
    hits.push({
      source: "arxiv",
      title,
      authors,
      year,
      venue: "arXiv",
      url: url || undefined,
      abstract: abstract || undefined,
      doi: doi || undefined,
    });
  }
  return hits;
}

// ---------------------------------------------------------------------------
// HTTP implementation
// ---------------------------------------------------------------------------

/**
 * Live implementation of the port, on top of `fetch` + `AbortController`.
 *
 * Holds only the injected transport and the fixed deadline, so one instance can
 * be shared by every tool invocation. Endpoint / mailto / result-cap are read
 * from config per call — that is what lets the unit tests patch the config
 * snapshot between cases.
 */
class HttpLiteratureClient implements LiteratureClient {
  constructor(
    private readonly fetchImpl: typeof fetch,
    private readonly timeoutMs: number,
  ) {}

  /**
   * Search entry point.
   *
   * - a blank (whitespace-only) query rejects before any I/O;
   * - `limit` is clamped by resolveLimit; omitted `source` means "auto";
   * - an explicit source issues exactly one request and never falls back: a
   *   zero-hit result is a valid answer, only transport failure rejects;
   * - auto = Crossref first; an error OR zero mapped hits falls back to OpenAlex.
   *   Only when the fallback also throws do we reject, and the message carries
   *   both reasons so the tool layer can show why both sources failed.
   */
  async search(query: string, options: LiteratureSearchOptions = {}): Promise<LiteratureHit[]> {
    const keywords = query.trim();
    if (!keywords) throw new Error("[LITERATURE] 检索关键词不能为空");
    const limit = resolveLimit(options.limit);
    const source = options.source ?? "auto";

    if (source === "crossref") return this.searchCrossref(keywords, limit);
    if (source === "openalex") return this.searchOpenAlex(keywords, limit);
    if (source === "arxiv") return this.searchArxiv(keywords, limit);

    // auto: Crossref first; an error or zero hits falls back to OpenAlex.
    // Only when neither source yields a usable response do we throw (with both reasons).
    let crossrefReason = "未知原因";
    try {
      const hits = await this.searchCrossref(keywords, limit);
      if (hits.length > 0) return hits;
      crossrefReason = "返回 0 条结果";
    } catch (err) {
      crossrefReason = errorMessage(err);
    }
    try {
      return await this.searchOpenAlex(keywords, limit);
    } catch (err) {
      throw new Error(
        `[LITERATURE] Crossref 与 OpenAlex 检索均失败：Crossref: ${crossrefReason}；OpenAlex: ${errorMessage(err)}`,
      );
    }
  }

  /**
   * Resolve a DOI against Crossref and map the work record to a hit.
   *
   * Only Crossref can prove a DOI: a hit from any other source must not be
   * reported as verified. Blank/malformed DOI → null WITHOUT a request; HTTP 404
   * → null ("unknown to Crossref", not an error); every other failure (non-2xx,
   * unparsable JSON, missing `message`) rejects, so an upstream outage can never
   * be mistaken for "this DOI does not exist".
   */
  async lookupDoi(doi: string): Promise<LiteratureHit | null> {
    const normalized = normalizeDoi(doi);
    if (!normalized) return null;
    const url = `${trimBaseUrl(config.academic.literature.crossrefBaseUrl)}/works/${encodeURIComponent(normalized)}`;
    const res = await this.requestText(url, "application/json", "Crossref");
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`[LITERATURE] DOI 核验失败（Crossref HTTP ${res.status}）：${doi}`);
    const message = asObject(asObject(this.parseJson(res.text))?.message);
    if (!message) throw new Error(`[LITERATURE] Crossref DOI 响应缺少 message：${doi}`);
    return mapCrossrefItem(message);
  }

  // ---------- per-source search ----------

  /** One Crossref `/works` query. `select` narrows the payload to the mapped fields only (smaller body, stable mapping). */
  private async searchCrossref(query: string, limit: number): Promise<LiteratureHit[]> {
    const base = trimBaseUrl(config.academic.literature.crossrefBaseUrl);
    const params = [`query=${encodeURIComponent(query)}`, `rows=${limit}`, `select=${CROSSREF_SELECT}`];
    const mailto = config.academic.literature.mailto.trim();
    if (mailto) params.push(`mailto=${encodeURIComponent(mailto)}`);
    const url = `${base}/works?${params.join("&")}`;
    const body = await this.fetchJson(url, "Crossref");
    const hits = asArray(asObject(asObject(body)?.message)?.items)
      .map(mapCrossrefItem)
      .filter((hit): hit is LiteratureHit => hit !== null);
    log.info(`[LITERATURE] source=crossref hits=${hits.length} limit=${limit}`);
    return hits;
  }

  /** One OpenAlex `/works` query; pagination is not implemented — `per-page` == the caller's limit. */
  private async searchOpenAlex(query: string, limit: number): Promise<LiteratureHit[]> {
    const base = trimBaseUrl(config.academic.literature.openalexBaseUrl);
    const params = [`search=${encodeURIComponent(query)}`, `per-page=${limit}`];
    const mailto = config.academic.literature.mailto.trim();
    if (mailto) params.push(`mailto=${encodeURIComponent(mailto)}`);
    const url = `${base}/works?${params.join("&")}`;
    const body = await this.fetchJson(url, "OpenAlex");
    const hits = asArray(asObject(body)?.results)
      .map(mapOpenAlexItem)
      .filter((hit): hit is LiteratureHit => hit !== null);
    log.info(`[LITERATURE] source=openalex hits=${hits.length} limit=${limit}`);
    return hits;
  }

  /**
   * One arXiv Atom query. Uses `requestText` directly (no JSON step), hence its own
   * non-2xx check; the URL is embedded in the error because this endpoint is
   * query-string driven and the failure is otherwise hard to reproduce by eye.
   */
  private async searchArxiv(query: string, limit: number): Promise<LiteratureHit[]> {
    const base = trimBaseUrl(config.academic.literature.arxivBaseUrl);
    const url = `${base}/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${limit}`;
    const res = await this.requestText(url, "application/atom+xml", "arXiv");
    if (!res.ok) throw new Error(`[LITERATURE] arXiv 检索失败（HTTP ${res.status}）：${url}`);
    const hits = parseArxivFeed(res.text);
    log.info(`[LITERATURE] source=arxiv hits=${hits.length} limit=${limit}`);
    return hits;
  }

  // ---------- transport ----------

  /** `requestText` + 2xx check + JSON parse; `label` is the source name used in error texts. */
  private async fetchJson(url: string, label: string): Promise<unknown> {
    const res = await this.requestText(url, "application/json", label);
    if (!res.ok) throw new Error(`[LITERATURE] ${label} 检索失败（HTTP ${res.status}）：${url}`);
    return this.parseJson(res.text, label);
  }

  /**
   * JSON parse with a source-labeled failure: a proxy/HTML error page returned
   * with 200 must be reported as a parse failure, never as "zero results".
   */
  private parseJson(text: string, label = "Crossref"): unknown {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`[LITERATURE] ${label} 返回了无法解析的 JSON`);
    }
  }

  /**
   * GET with an AbortController deadline.
   *
   * The explicit race against the timer (instead of relying on the abort signal)
   * guarantees a rejection even when the injected fetch ignores the signal — the
   * tests do exactly that. Non-2xx is NOT an error here: callers decide (JSON
   * sources throw, `lookupDoi` maps 404 to null).
   *
   * The loser of the race is pre-caught (`work.catch`) so a late abort can never
   * surface as an unhandled rejection, and the timer is always cleared in the
   * finally block so the process does not stay alive on a resolved request.
   */
  private async requestText(
    url: string,
    accept: string,
    label: string,
  ): Promise<{ status: number; ok: boolean; text: string }> {
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error("timeout"));
      }, this.timeoutMs);
    });
    const work = (async () => {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          "User-Agent": buildUserAgent(config.academic.literature.mailto),
          Accept: accept,
        },
        signal: controller.signal,
      });
      const text = await response.text();
      return { status: response.status, ok: response.ok, text };
    })();
    // The loser of the race must never surface as an unhandled rejection.
    work.catch(() => undefined);
    try {
      return await Promise.race([work, deadline]);
    } catch (err) {
      if (timedOut) throw new Error(`[LITERATURE] ${label} 请求超时（${this.timeoutMs}ms）：${url}`);
      throw new Error(`[LITERATURE] ${label} 请求失败：${errorMessage(err)}（${url}）`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}


// ---------------------------------------------------------------------------
// Bounded process-local TTL cache
// ---------------------------------------------------------------------------

/** Search memoization window: the same query/source/limit inside 5 min is a cache hit. */
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
/** Hard cap on cached search keys (oldest insertion is evicted first). */
const SEARCH_CACHE_MAX_ENTRIES = 100;
/** DOI verification window: a DOI is stable for far longer than a search query. */
const DOI_CACHE_TTL_MS = 60 * 60 * 1000;
/** Hard cap on cached DOI keys (oldest insertion is evicted first). */
const DOI_CACHE_MAX_ENTRIES = 200;

/** One memoized value plus its absolute expiry (epoch ms). */
interface CacheRecord<T> {
  value: T;
  expiresAt: number;
}

/**
 * Minimal insertion-ordered TTL cache (Map order = insertion order, so eviction
 * removes the first key). Deliberately tiny: no dependency, no timers - expired
 * records are dropped lazily on read, capacity is enforced on write, and the
 * clock is injected so tests can pin TTL boundaries without waiting.
 */
class TtlCache<T> {
  private readonly records = new Map<string, CacheRecord<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number,
  ) {}

  /** Miss and expiry both read as undefined; an expired record is deleted eagerly. */
  get(key: string): CacheRecord<T> | undefined {
    const record = this.records.get(key);
    if (!record) return undefined;
    if (this.now() >= record.expiresAt) {
      this.records.delete(key);
      return undefined;
    }
    return record;
  }

  /** Write a fresh record; at the cap the oldest insertion is evicted first. */
  set(key: string, value: T): void {
    if (this.records.size >= this.maxEntries) {
      const oldest = this.records.keys().next();
      if (!oldest.done) this.records.delete(oldest.value);
    }
    this.records.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }
}

/**
 * Copy of a hit that is safe to hand to callers. The authors array is the only
 * mutable nested field (everything else is a primitive), so a shallow object
 * copy plus a fresh authors array fully isolates the cached snapshot.
 */
function cloneHit(hit: LiteratureHit): LiteratureHit {
  return { ...hit, authors: [...hit.authors] };
}

/**
 * Cache decorator around the HTTP client.
 *
 * - search: key = source | normalized query (trim+lowercase) | requested limit.
 *   The requested (pre-clamp) value is used on purpose: callers asking for
 *   different sizes get different entries, and clamp semantics stay an internal
 *   concern of the HTTP layer.
 * - lookupDoi: key = normalizeDoi(doi), so "https://doi.org/10.1/ABC" and
 *   "10.1/abc" share one entry and one request.
 * - Only fulfilled calls are memoized: a rejection propagates untouched and
 *   leaves no negative entry, so a transient outage can recover on retry. Empty
 *   arrays and the "unknown DOI" null ARE cached - both are authoritative
 *   answers that would otherwise re-hit the network.
 * - Every return value is a copy, so the tool layer cannot mutate a snapshot.
 */
class CachingLiteratureClient implements LiteratureClient {
  private readonly searchCache: TtlCache<LiteratureHit[]>;
  private readonly doiCache: TtlCache<LiteratureHit | null>;

  constructor(
    private readonly inner: LiteratureClient,
    private readonly now: () => number,
  ) {
    this.searchCache = new TtlCache<LiteratureHit[]>(SEARCH_CACHE_TTL_MS, SEARCH_CACHE_MAX_ENTRIES, now);
    this.doiCache = new TtlCache<LiteratureHit | null>(DOI_CACHE_TTL_MS, DOI_CACHE_MAX_ENTRIES, now);
  }

  async search(query: string, options: LiteratureSearchOptions = {}): Promise<LiteratureHit[]> {
    const key = this.searchKey(query, options);
    const cached = this.searchCache.get(key);
    if (cached) return cached.value.map(cloneHit);

    // Failures (blank query, upstream error) propagate before anything is stored.
    const hits = await this.inner.search(query, options);
    this.searchCache.set(key, hits.map(cloneHit));
    return hits.map(cloneHit);
  }

  async lookupDoi(doi: string): Promise<LiteratureHit | null> {
    const key = normalizeDoi(doi);
    const cached = this.doiCache.get(key);
    if (cached) return cached.value === null ? null : cloneHit(cached.value);

    const hit = await this.inner.lookupDoi(doi);
    this.doiCache.set(key, hit === null ? null : cloneHit(hit));
    return hit === null ? null : cloneHit(hit);
  }

  /** Cache identity of one search: source + normalized query + requested limit. */
  private searchKey(query: string, options: LiteratureSearchOptions): string {
    const source = options.source ?? "auto";
    const limit = options.limit === undefined ? "default" : String(options.limit);
    return "search|" + source + "|" + query.trim().toLowerCase() + "|" + limit;
  }
}

