import { z } from "zod";
import { defineTool } from "../base.js";
import type { ToolRunContext } from "../../context/types.js";
import {
  normalizeDoi,
  type AcademicEventRepository,
  type AcademicLiteratureEntry,
  type AcademicLiteratureInput,
  type AcademicLiteratureRepository,
  type AcademicLiteratureSource,
  type AcademicProjectRepository,
} from "../../repository/academic.js";
import type {
  LiteratureClient,
  LiteratureHit,
  LiteratureSearchOptions,
} from "../../services/literature-client.js";

/**
 * academic_literature: the project literature library.
 *
 * Layer: agent tool layer. Search/verify go through the injected
 * LiteratureClient (Crossref/OpenAlex/arXiv); persistence goes through
 * AcademicLiteratureRepository. No client or adapter is constructed here.
 *
 * Evidence discipline (red lines):
 *  - metadata only comes from the search API or user-provided BibTeX/CSL - the
 *    model never invents DOI/authors/year;
 *  - every search hit is UNVERIFIED by construction; only verify (DOI resolved
 *    by Crossref AND a title match) flips that state, so "database says it
 *    exists" is never confused with "the citation is proven";
 *  - imports are deduplicated by DOI first and by normalized title+year
 *    otherwise; the rule lives in the repository so both adapters agree;
 *  - network failures degrade to guidance text, never throw through the loop.
 *
 * Multi-tenant: uid from ToolRunContext, never in the schema. search is the only
 * action that does not need project_id.
 */

/** Repositories and the literature search client injected by the composition root. */
export interface AcademicLiteratureToolDeps {
  literature: AcademicLiteratureRepository;
  projects: AcademicProjectRepository;
  events: AcademicEventRepository;
  client: LiteratureClient;
}

/**
 * Guidance fallbacks returned instead of throwing: no uid, a foreign project,
 * or a missing projectId must degrade into text the ReAct loop can recover
 * from (usually by re-prompting the user).
 */
const NO_USER_TEXT = "当前会话没有用户身份，无法访问学术工作区。";
const NO_PROJECT_TEXT = "项目不存在或无权访问。";
const MISSING_PROJECT_TEXT =
  "缺少 project_id：请先用 academic_project(action=list) 查看研究项目，或 action=create 新建项目。";

/** Chinese display names for literature sources (product text; do not translate). */
const SOURCE_LABELS: Record<string, string> = {
  crossref: "Crossref",
  openalex: "OpenAlex",
  arxiv: "arXiv",
  manual: "手工录入",
  bibtex: "BibTeX 导入",
  csl: "CSL 导入",
};

/**
 * Page sizes. One `limit` schema field serves both actions, so each action clamps
 * it to its own range: search stays a short candidate list (default 5, max 10),
 * while list pages the library (default 30, max 100) instead of pouring every
 * entry into the prompt.
 */
const SEARCH_DEFAULT_LIMIT = 5;
const SEARCH_MAX_LIMIT = 10;
const LIST_DEFAULT_LIMIT = 30;
const LIST_MAX_LIMIT = 100;

/** Clamp an optional numeric count into [1, max], falling back to the action default. */
function clampCount(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 1), max);
}

/**
 * One parsed import entry (internal shape, mapped onto AcademicLiteratureInput).
 * Fields mirror the union of BibTeX and CSL so both parsers can share the
 * import loop; missing fields stay undefined and are simply not persisted.
 */
interface ParsedLiterature {
  citeKey?: string;
  title: string;
  authors: string[];
  year?: number;
  venue?: string;
  doi?: string;
  url?: string;
  abstract?: string;
}

/** Human-readable message for a thrown/unknown error, used only to build degrade-to-text answers. */
function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

/**
 * Loose DOI shape check for a normalized ref. Callers pass the output of
 * normalizeDoi, so URL/prefixed forms are already reduced to the bare 10.x/...
 * body; this only decides whether the ref itself may be treated as a DOI for
 * lookup. It is a shape heuristic, not proof that the DOI exists.
 */
function looksLikeDoi(value: string): boolean {
  return /^10\.\d{4,9}\/\S+$/.test(value);
}

/** Comparison normalization: lowercase, strip punctuation/whitespace, keep CJK characters. */
function normTitle(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

/**
 * Crossref title vs library title: prefix/substring differences are accepted.
 *
 * This is a heuristic, not proof: it can only confirm a DOI that already
 * resolved, and is never sufficient to promote an entry to verified by itself
 * (see the verify branch). Empty titles return true so missing metadata does
 * not block a verification that is otherwise sound.
 */
function titlesMatch(left: string, right: string): boolean {
  const a = normTitle(left);
  const b = normTitle(right);
  if (!a || !b) return true;
  return a === b || a.includes(b) || b.includes(a);
}

// ---------------------------------------------------------------------------
// BibTeX parsing (regex + brace scanning; handles {nested {braces}} in titles)
// ---------------------------------------------------------------------------

/** Strip LaTeX braces/escapes from a field body and collapse whitespace. */
function cleanBibValue(raw: string): string {
  return raw
    .replace(/[{}]/g, "")
    .replace(/\\&/g, "&")
    .replace(/\\%/g, "%")
    .replace(/\\_/g, "_")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Read one BibTeX field. Accepted value forms are {...} (brace-scanned so
 * nested braces in titles survive), "...", or a bare token ending at the next
 * comma; returns an empty string when the field is absent.
 */
function bibField(body: string, name: string): string {
  const pattern = new RegExp("(?:^|[,\\s])" + name + "\\s*=\\s*", "i");
  const match = pattern.exec(body);
  if (!match) return "";
  const start = match.index + match[0].length;
  const first = body[start];
  if (first === "{") {
    let depth = 1;
    let i = start + 1;
    while (i < body.length && depth > 0) {
      if (body[i] === "{") depth += 1;
      else if (body[i] === "}") depth -= 1;
      i += 1;
    }
    return cleanBibValue(body.slice(start + 1, i - 1));
  }
  if (first === '"') {
    const end = body.indexOf('"', start + 1);
    if (end < 0) return "";
    return cleanBibValue(body.slice(start + 1, end));
  }
  const comma = body.indexOf(",", start);
  return comma < 0 ? cleanBibValue(body.slice(start)) : cleanBibValue(body.slice(start, comma));
}

/** "Last, First" to "First Last"; an already "First Last" value is returned unchanged. */
function normalizeBibAuthor(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  if (value.includes(",")) {
    const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
    if (parts.length >= 2) return parts.slice(1).join(" ") + " " + parts[0];
  }
  return value;
}

/**
 * Parse every @type{...} entry; @comment/@preamble/@string are skipped.
 *
 * Entry bodies are located by brace-depth scanning rather than a regex because
 * titles routinely nest braces. Entries without a title are dropped (the
 * library requires one) and an unbalanced body aborts the scan instead of
 * looping forever.
 */
function parseBibtex(text: string): ParsedLiterature[] {
  const out: ParsedLiterature[] = [];
  const entryPattern = /@([a-zA-Z]+)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(text)) !== null) {
    const type = (match[1] ?? "").toLowerCase();
    let depth = 1;
    let i = entryPattern.lastIndex;
    while (i < text.length && depth > 0) {
      if (text[i] === "{") depth += 1;
      else if (text[i] === "}") depth -= 1;
      i += 1;
    }
    if (depth !== 0) break;
    const body = text.slice(entryPattern.lastIndex, i - 1);
    entryPattern.lastIndex = i;
    if (type === "comment" || type === "preamble" || type === "string") continue;
    const comma = body.indexOf(",");
    if (comma < 0) continue;
    const citeKey = body.slice(0, comma).trim();
    const fields = body.slice(comma + 1);
    const title = bibField(fields, "title");
    if (!title) continue;
    const authorsRaw = bibField(fields, "author");
    const authors = authorsRaw
      ? authorsRaw.split(/\s+and\s+/i).map(normalizeBibAuthor).filter((author) => author.length > 0)
      : [];
    const yearRaw = bibField(fields, "year");
    const yearValue = yearRaw ? Number.parseInt(yearRaw, 10) : Number.NaN;
    const doi = normalizeDoi(bibField(fields, "doi"));
    out.push({
      citeKey: citeKey || undefined,
      title,
      authors,
      year: Number.isFinite(yearValue) ? yearValue : undefined,
      venue: bibField(fields, "journal") || bibField(fields, "booktitle") || undefined,
      doi: doi || undefined,
      url: bibField(fields, "url") || undefined,
      abstract: bibField(fields, "abstract") || undefined,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// CSL-JSON parsing (array or {items:[...]})
// ---------------------------------------------------------------------------

interface CslAuthorLike {
  family?: unknown;
  given?: unknown;
  literal?: unknown;
}

/** Defensive string read: CSL values are unknown and may be non-strings. */
function cslString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Map one CSL-JSON item onto ParsedLiterature. Supports literal (organisation)
 * authors, family/given person names, and issued.date-parts years; returns null
 * when the title is missing, because nothing citable remains.
 */
function parseCslItem(item: Record<string, unknown>): ParsedLiterature | null {
  const title = cslString(item.title);
  if (!title) return null;
  const authors: string[] = [];
  const rawAuthors = Array.isArray(item.author) ? item.author : [];
  for (const raw of rawAuthors) {
    if (!raw || typeof raw !== "object") continue;
    const author = raw as CslAuthorLike;
    const literal = cslString(author.literal);
    if (literal) {
      authors.push(literal);
      continue;
    }
    const name = [cslString(author.given), cslString(author.family)].filter(Boolean).join(" ");
    if (name) authors.push(name);
  }
  let year: number | undefined;
  const issued = item.issued;
  if (issued && typeof issued === "object") {
    const parts = (issued as { "date-parts"?: unknown })["date-parts"];
    if (Array.isArray(parts) && Array.isArray(parts[0]) && typeof parts[0][0] === "number") {
      year = parts[0][0];
    }
  }
  const doi = normalizeDoi(cslString(item.DOI) || cslString(item.doi));
  return {
    citeKey: cslString(item.id) || undefined,
    title,
    authors,
    year,
    venue: cslString(item["container-title"]) || cslString(item.publisher) || undefined,
    doi: doi || undefined,
    url: cslString(item.URL) || cslString(item.url) || undefined,
    abstract: cslString(item.abstract) || undefined,
  };
}

/**
 * Accept both a bare CSL array and {items:[...]}; unparsable JSON degrades to
 * an empty list that the caller turns into import guidance.
 */
function parseCsl(text: string): ParsedLiterature[] {
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    return [];
  }
  let items: unknown[] | null = null;
  if (Array.isArray(data)) items = data;
  else if (data && typeof data === "object" && Array.isArray((data as { items?: unknown }).items)) {
    items = (data as { items: unknown[] }).items;
  }
  if (!items) return [];
  const out: ParsedLiterature[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const parsed = parseCslItem(item as Record<string, unknown>);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * Guess the import format. JSON is probed first so a CSL payload is not
 * mistaken for BibTeX; a failed JSON parse falls through to the BibTeX probe
 * instead of failing the import outright.
 */
function detectFormat(text: string): "bibtex" | "csl" | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      JSON.parse(trimmed);
      return "csl";
    } catch {
      // not JSON — fall through to the BibTeX probe
    }
  }
  if (/@[a-zA-Z]+\s*\{/.test(trimmed)) return "bibtex";
  return null;
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

/** First six authors inline; more are truncated with the Chinese et-al marker, and missing authors render as the Chinese unknown-author label. */
function authorLine(authors: string[]): string {
  if (authors.length === 0) return "作者未知";
  const shown = authors.slice(0, 6).join(", ");
  return authors.length > 6 ? shown + " 等" : shown;
}

/**
 * Library entry rendering: citeKey, title, metadata line, then verification
 * state + source. Verification state is always printed so the model cannot
 * silently upgrade an unverified citation while writing.
 */
function renderEntry(entry: AcademicLiteratureEntry, index: number): string {
  const meta: string[] = [authorLine(entry.authors)];
  if (entry.year) meta.push(String(entry.year));
  if (entry.venue) meta.push(entry.venue);
  if (entry.doi) meta.push("DOI: " + entry.doi);
  const lines = [(index + 1) + ". [" + entry.citeKey + "] 《" + entry.title + "》", "   " + meta.join("｜")];
  lines.push(
    "   " +
      (entry.verified ? "已核验" : "未核验") +
      "｜来源：" +
      (SOURCE_LABELS[entry.source] ?? entry.source),
  );
  return lines.join("\n");
}

/**
 * Search-candidate rendering for search output. Hits are not in the library
 * yet and are always shown as unverified; no citeKey is shown because none exists
 * until the entry is added.
 */
function renderHit(hit: LiteratureHit, index: number): string {
  const meta: string[] = [authorLine(hit.authors)];
  if (hit.year) meta.push(String(hit.year));
  if (hit.venue) meta.push(hit.venue);
  if (hit.doi) meta.push("DOI: " + hit.doi);
  const lines = [(index + 1) + ". 《" + hit.title + "》", "   " + meta.join("｜")];
  lines.push("   来源：" + (SOURCE_LABELS[hit.source] ?? hit.source) + "｜未核验");
  if (hit.url) lines.push("   URL: " + hit.url);
  return lines.join("\n");
}

/**
 * Serialize one library entry as an @article. The entry citeKey is reused as
 * the BibTeX key so export round-trips through import without renaming
 * citations; optional fields are omitted rather than emitted empty.
 */
function toBibtex(entry: AcademicLiteratureEntry): string {
  const fields: string[] = ["  title = {" + entry.title + "}"];
  if (entry.authors.length > 0) fields.push("  author = {" + entry.authors.join(" and ") + "}");
  if (entry.year) fields.push("  year = {" + entry.year + "}");
  if (entry.venue) fields.push("  journal = {" + entry.venue + "}");
  if (entry.doi) fields.push("  doi = {" + entry.doi + "}");
  if (entry.url) fields.push("  url = {" + entry.url + "}");
  return "@article{" + entry.citeKey + ",\n" + fields.join(",\n") + "\n}";
}

/** Emit a typed literature artifact for the web client (search hits, entry lists, exports). */
function pushLiteratureArtifact(ctx: ToolRunContext, data: Record<string, unknown>): void {
  ctx.collector.pushArtifacts([{ kind: "academic_literature", data }]);
}

/** Tool input schema. uid is intentionally absent: identity comes from ToolRunContext. */
const literatureInputSchema = z.object({
  action: z
    .enum(["search", "list", "import", "add", "verify", "export_bibtex"])
    .describe(
      "search=检索候选文献（Crossref/OpenAlex/arXiv，不需要项目）；list=列出项目已导入文献；import=导入 BibTeX/CSL-JSON 文本；verify=按 DOI 核验文献真实性；export_bibtex=导出项目文献库 BibTeX",
    ),
  query: z.string().min(1).max(300).optional().describe("检索词（search 必填）：标题、作者或关键词，英文检索命中率更高"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("条数：search 可选，默认 5，上限 10；list 可选，默认 30，上限 100（分页显示，末行给出总数）"),
  source: z
    .enum(["auto", "crossref", "openalex", "arxiv"])
    .optional()
    .describe("检索源（search 可选，默认 auto = Crossref 优先、OpenAlex 兜底）"),
  projectId: z.string().min(1).optional().describe("项目 id（search 之外必填）"),
  text: z.string().min(3).optional().describe("待导入的 BibTeX 或 CSL-JSON 原文（import 必填）"),
  ref: z.string().min(1).optional().describe("文献 id、citeKey 或 DOI（verify 必填）"),
  title: z.string().min(1).max(500).optional().describe("文献标题（add 必填）"),
  authors: z.array(z.string().min(1)).max(50).optional().describe("作者列表（add 可选，如 [\"San Zhang\"]）"),
  year: z.number().int().min(1500).max(2100).optional().describe("出版年份（add 可选）"),
  venue: z.string().max(300).optional().describe("期刊/会议名（add 可选）"),
  doi: z.string().max(300).optional().describe("DOI（add 可选，只能用检索结果或用户提供的值）"),
  url: z.string().max(1000).optional().describe("链接（add 可选）"),
});

/**
 * Build the academic_literature tool.
 *
 * Actions: search / list / import / add / verify / export_bibtex. Returns
 * Chinese text for the ReAct loop plus an academic_literature artifact
 * describing what happened (search hits, imported entries, verification
 * result, exported BibTeX).
 *
 * Side effects: library writes, project event appends, and outbound calls to
 * the literature client for search/verify. Expected failures (no results,
 * unresolvable DOI, network outage) are returned as guidance text so the agent
 * can adapt; operational failures never throw.
 */
export function createAcademicLiteratureTool(deps: AcademicLiteratureToolDeps) {
  return defineTool({
    name: "academic_literature",
    description:
      "研究项目文献库（学术引用的事实来源）。" +
      "action=search：按标题/作者/关键词检索 Crossref（可切 OpenAlex/arXiv 预印本），返回标题、作者、年份、期刊、DOI、URL，默认 5 条；" +
      "action=list：列出项目已导入文献（citeKey/标题/年份/核验状态），默认显示前 30 篇（limit 可调，上限 100）；" +
      "action=import：导入 BibTeX 或 CSL-JSON 文本（自动去重，重复项跳过，写项目事件），需要 project_id；" +
      "action=add：把一条已确认的检索候选或用户给出的文献元数据加入项目库（标题必填，其余字段可选；不编造字段），需要 project_id；" +
      "action=verify：按文献 id / citeKey / DOI 核验（DOI 命中 Crossref 才标记已核验）；" +
      "action=export_bibtex：导出项目全部文献的 BibTeX 文本。" +
      "纪律：检索结果是未核验候选，未导入项目库不能引用；正文只允许引用库内 citeKey；" +
      "不得编造 DOI、作者、年份，Crossref 未收录时必须如实说明未核验。",
    inputSchema: literatureInputSchema,
    async execute(args, ctx) {
      const uid = ctx.uid;
      if (!uid) return NO_USER_TEXT;
      const projectId = args.projectId?.trim() ?? "";

      switch (args.action) {
        case "search": {
          const query = (args.query ?? "").trim();
          if (!query) return "search 需要 query：给出标题、作者或关键词（英文检索命中率更高）。";
          const options: LiteratureSearchOptions = {};
          // One shared limit field: search keeps its short candidate-list range (1-10).
          if (args.limit !== undefined) {
            options.limit = clampCount(args.limit, SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT);
          }
          if (args.source !== undefined) options.source = args.source;
          let hits: LiteratureHit[];
          // Network failure is operational, not a bug: degrade to guidance so the loop can retry or switch keywords.
          try {
            hits = await deps.client.search(query, options);
          } catch (error) {
            return "文献检索失败：" + errorText(error) + "。可稍后重试，或换更通用的英文关键词。";
          }
          if (hits.length === 0) {
            return (
              "没有检索到相关文献（检索词：「" +
              query +
              "」）。可换更通用的英文关键词重试，或让用户提供 BibTeX/CSL 文本手动导入。"
            );
          }
          const lines = [
            "检索到 " +
              hits.length +
              " 条候选文献（检索词：「" +
              query +
              "」，来源：" +
              (args.source ?? "auto") +
              "，均未核验）：",
          ];
          hits.forEach((hit, index) => lines.push(renderHit(hit, index)));
          lines.push(
            "",
            "提示：候选结果尚未进入项目文献库，不能直接引用；确认后可 action=add 逐条入库（需要 project_id），" +
              "或用 action=import 导入 BibTeX/CSL，action=verify 可核验 DOI 真实性。",
          );
          pushLiteratureArtifact(ctx, { action: "search", query, hits });
          return lines.join("\n");
        }

        case "list": {
          if (!projectId) return MISSING_PROJECT_TEXT;
          const project = await deps.projects.get(uid, projectId);
          if (!project) return NO_PROJECT_TEXT;
          const limit = clampCount(args.limit, LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);
          // Two cheap calls instead of one unbounded render: count() gives the real
          // library size while list() is only sliced to the page, so a large library
          // can no longer pour every entry body into the prompt. The repository
          // contract has no offset yet, so the page is always the first N entries.
          const [total, entries] = await Promise.all([
            deps.literature.count(uid, projectId),
            deps.literature.list(uid, projectId),
          ]);
          const librarySize = Math.max(total, entries.length);
          if (librarySize === 0) {
            return "项目文献库还没有文献。可用 action=import 导入 BibTeX/CSL，或 action=search 检索候选文献。";
          }
          const page = entries.slice(0, limit);
          const verified = entries.filter((entry) => entry.verified).length;
          const lines = ["项目文献库共 " + librarySize + " 篇（已核验 " + verified + " 篇）："];
          page.forEach((entry, index) => lines.push(renderEntry(entry, index)));
          if (page.length < librarySize) {
            lines.push(
              "",
              "共 " +
                librarySize +
                " 篇，已显示前 " +
                page.length +
                " 篇（action=list limit 可调，范围 1-100）。",
            );
          }
          lines.push("", "引用时只使用方括号里的 citeKey；未核验文献必须标注或先核验。");
          pushLiteratureArtifact(ctx, { action: "list", projectId, entries: page, total: librarySize, limit });
          return lines.join("\n");
        }

        case "import": {
          if (!projectId) return MISSING_PROJECT_TEXT;
          const text = (args.text ?? "").trim();
          if (!text) return "import 需要 text：粘贴 BibTeX 或 CSL-JSON 文本。";
          const project = await deps.projects.get(uid, projectId);
          if (!project) return NO_PROJECT_TEXT;
          const format = detectFormat(text);
          if (!format) {
            return (
              "导入失败：无法识别文本格式。支持 BibTeX（@article{citeKey, title={...}, ...}）" +
              "或 CSL-JSON（数组或 {\"items\":[...]}）。"
            );
          }
          const parsed = format === "bibtex" ? parseBibtex(text) : parseCsl(text);
          if (parsed.length === 0) {
            return "导入失败：未能解析出文献条目。请检查 BibTeX/CSL-JSON 是否完整（至少含标题字段）。";
          }

          const source: AcademicLiteratureSource = format;
          // The repository owns dedupe (DOI first, then normalized title+year) and
          // uniquifies suggested citeKeys, so a single addMany call replaces the old
          // "read the whole library, then N adds" loop: a batch now costs one library
          // scan instead of one per entry, with no pre-read just to seed the key pool.
          const inputs: AcademicLiteratureInput[] = parsed.map((item) => {
            const input: AcademicLiteratureInput = { title: item.title, source };
            // The BibTeX/CSL key is only a suggestion; the repository derives one when absent.
            const suggested = item.citeKey?.trim();
            if (suggested) input.citeKey = suggested;
            if (item.authors.length > 0) input.authors = item.authors;
            if (item.year !== undefined) input.year = item.year;
            if (item.venue) input.venue = item.venue;
            if (item.doi) input.doi = item.doi;
            if (item.url) input.url = item.url;
            if (item.abstract) input.abstract = item.abstract;
            return input;
          });
          const results = await deps.literature.addMany(uid, projectId, inputs);
          // Results keep input order; a duplicate carries the pre-existing row (verified state untouched).
          const added: AcademicLiteratureEntry[] = [];
          const duplicates: string[] = [];
          for (const result of results) {
            if (result.duplicate) duplicates.push(result.entry.citeKey);
            else added.push(result.entry);
          }
          // One event per import batch (parsed/added/duplicates), not one per entry, to keep the timeline readable.
          await deps.events.append(
            uid,
            projectId,
            "literature.imported",
            { source: format, parsed: parsed.length, added: added.length, duplicates: duplicates.length },
            "agent",
          );

          const lines = [
            "导入完成（来源：" +
              format +
              "）：解析 " +
              parsed.length +
              " 篇，新增 " +
              added.length +
              " 篇，重复 " +
              duplicates.length +
              " 篇。",
          ];
          if (added.length > 0) {
            lines.push("新增文献：");
            added.forEach((entry) => lines.push("- [" + entry.citeKey + "] 《" + entry.title + "》"));
          }
          if (duplicates.length > 0) {
            lines.push("重复项已跳过（按 DOI 或标题+年份判重）：" + duplicates.join("、"));
          }
          lines.push("", "新导入文献为未核验状态：引用前可用 action=verify 核验，未核验引用需标注。");
          pushLiteratureArtifact(ctx, {
            action: "import",
            projectId,
            source: format,
            added,
            duplicates,
          });
          return lines.join("\n");
        }

        case "add": {
          if (!projectId) return MISSING_PROJECT_TEXT;
          const project = await deps.projects.get(uid, projectId);
          if (!project) return NO_PROJECT_TEXT;
          const title = (args.title ?? "").trim();
          if (!title) {
            return "add 需要 title：给出文献标题；作者/年份/期刊/DOI/URL 可按已知信息补充，不确定的字段留空，不要编造。";
          }
          // The repository derives and uniquifies the citeKey from its own write-time
          // index, so this path never reads the library first (that read was O(N) per add).
          const input: AcademicLiteratureInput = {
            title,
            source: "manual",
          };
          const authors = (args.authors ?? [])
            .map((author) => author.trim())
            .filter((author) => author.length > 0);
          if (authors.length > 0) input.authors = authors;
          if (args.year !== undefined) input.year = args.year;
          if (args.venue) input.venue = args.venue.trim();
          const doi = normalizeDoi(args.doi);
          if (doi) input.doi = doi;
          if (args.url) input.url = args.url.trim();
          const result = await deps.literature.add(uid, projectId, input);
          await deps.events.append(
            uid,
            projectId,
            "literature.added",
            { citeKey: result.entry.citeKey, duplicate: result.duplicate, source: "manual" },
            "agent",
          );
          pushLiteratureArtifact(ctx, {
            action: "add",
            projectId,
            entry: result.entry,
            duplicate: result.duplicate,
          });
          if (result.duplicate) {
            return (
              "项目文献库中已有该文献：[" +
              result.entry.citeKey +
              "]《" +
              result.entry.title +
              "》，未重复加入（核验状态保持不变）。"
            );
          }
          return (
            "已加入项目文献库：[" +
            result.entry.citeKey +
            "]《" +
            result.entry.title +
            "》｜未核验。可继续 action=verify 核验，或 action=list 查看文献库。"
          );
        }

        case "verify": {
          if (!projectId) return MISSING_PROJECT_TEXT;
          const ref = (args.ref ?? "").trim();
          if (!ref) return "verify 需要 ref：文献 id、citeKey 或 DOI。";
          const project = await deps.projects.get(uid, projectId);
          if (!project) return NO_PROJECT_TEXT;

          // Resolve in order: library id, citeKey, then DOI - verify accepts any of the three as ref.
          let entry = await deps.literature.get(uid, projectId, ref);
          if (!entry) entry = await deps.literature.findByDoi(uid, projectId, ref);
          // The DOI may come from the stored entry or from the ref itself; a bare DOI is a valid verification target.
          const refDoi = normalizeDoi(ref);
          const doi = normalizeDoi(entry?.doi) || (looksLikeDoi(refDoi) ? refDoi : "");
          // Without a DOI there is nothing to look up: the entry stays unverified and the model is told to rely on human checks.
          if (!doi) {
            if (!entry) {
              return (
                "文献库中没有「" + ref + "」。可先用 action=list 查看已导入文献（支持文献 id / citeKey / DOI）。"
              );
            }
            return (
              "「" +
              entry.title +
              "」（" +
              entry.citeKey +
              "）没有 DOI，无法在线核验，仍视为未核验。请人工核对出处后再引用。"
            );
          }

          const label = entry ? "《" + entry.title + "》" : doi;
          let hit: LiteratureHit | null;
          // Verification is best-effort: a transient outage must not flip state or crash the loop.
          try {
            hit = await deps.client.lookupDoi(doi);
          } catch (error) {
            return (
              "核验失败：文献服务暂时不可用（" +
              errorText(error) +
              "），" +
              label +
              "仍未核验，可稍后重试。"
            );
          }
          // A Crossref miss means keep unverified; "not found" is information, not an error.
          if (!hit) {
            return (
              "未核验：DOI " +
              doi +
              " 未被 Crossref 收录（或 DOI 有误），" +
              label +
              "保持未核验状态。请核对 DOI，或由用户人工确认文献真实性后再引用。"
            );
          }
          // A resolved DOI that is not in the library is still useful evidence, but nothing is written: the user must import it explicitly.
          if (!entry) {
            const detail: string[] = [authorLine(hit.authors)];
            if (hit.year) detail.push(String(hit.year));
            if (hit.venue) detail.push(hit.venue);
            pushLiteratureArtifact(ctx, { action: "verify", projectId, hit });
            return (
              "DOI " +
              doi +
              " 在 Crossref 命中：《" +
              hit.title +
              "》（" +
              detail.join("｜") +
              "）。该条目尚未导入项目文献库，如需引用请先用 action=import 导入对应 BibTeX/CSL。"
            );
          }
          // A DOI can resolve to a different work than the stored metadata (typo, wrong copy/paste). A title mismatch therefore blocks promotion: a false negative is better than a fabricated citation.
          if (!titlesMatch(entry.title, hit.title)) {
            return (
              "核验提示：DOI " +
              doi +
              " 命中了 Crossref，但与库内标题不一致——库内《" +
              entry.title +
              "》，Crossref《" +
              hit.title +
              "》。为避免错误引用，暂不标记核验；请先修正文献元数据（导入正确条目）后重新核验。"
            );
          }
          // Only now does verified flip; the title check above separates "the database has it" from "this entry is proven".
          const updated = await deps.literature.setVerified(uid, projectId, entry.id, true);
          if (!updated) return NO_PROJECT_TEXT;
          await deps.events.append(
            uid,
            projectId,
            "literature.verified",
            { citeKey: updated.citeKey, doi },
            "agent",
          );
          const detail: string[] = [authorLine(hit.authors)];
          if (hit.year) detail.push(String(hit.year));
          if (hit.venue) detail.push(hit.venue);
          pushLiteratureArtifact(ctx, { action: "verify", projectId, entry: updated });
          return (
            "已核验：《" +
            updated.title +
            "》（citeKey: " +
            updated.citeKey +
            "，DOI: " +
            doi +
            "）。Crossref 元数据：" +
            detail.join("｜") +
            "。正文可用 [" +
            updated.citeKey +
            "] 引用。"
          );
        }

        case "export_bibtex": {
          if (!projectId) return MISSING_PROJECT_TEXT;
          const project = await deps.projects.get(uid, projectId);
          if (!project) return NO_PROJECT_TEXT;
          const entries = await deps.literature.list(uid, projectId);
          if (entries.length === 0) {
            return "项目文献库为空，无法导出 BibTeX。可先用 action=import 导入文献。";
          }
          // Blank-line separated so the export is directly pasteable as a .bib file.
          const bibtex = entries.map(toBibtex).join("\n\n");
          const unverified = entries.filter((entry) => !entry.verified).length;
          const note =
            "共 " +
            entries.length +
            " 篇" +
            (unverified > 0 ? "（其中 " + unverified + " 篇未核验，引用时务必标注）" : "（全部已核验）") +
            "。";
          pushLiteratureArtifact(ctx, {
            action: "export_bibtex",
            projectId,
            count: entries.length,
            bibtex,
          });
          return bibtex + "\n\n" + note;
        }

        // Unreachable through zod validation, but older/unknown clients still get guidance instead of a throw.
        default: {
          const action = String((args as { action?: unknown }).action ?? "");
          return (
            "未知 action：" +
            action +
            "（可用：search / list / import / verify / export_bibtex）"
          );
        }
      }
    },
  });
}
