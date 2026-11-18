import { describe, expect, it } from "vitest";
import { ResultCollector, type ToolRunContext } from "../src/context/types.js";
import {
  ACADEMIC_CITATION_STYLES,
  type AcademicActor,
  type AcademicEvent,
  type AcademicEventRepository,
  type AcademicLiteratureEntry,
  type AcademicLiteratureInput,
} from "../src/repository/academic.js";
import { MemoryAcademicStore } from "../src/repository/memory/academic.js";
import type { LiteratureClient, LiteratureHit, LiteratureSearchOptions } from "../src/clients/literature-client.js";
import { createAcademicLiteratureTool } from "../src/tools/academic/literature.js";
import {
  DEFAULT_MATRIX_ABSTRACT_CHARS,
  READING_STATUS_LABELS,
  buildLiteratureMatrix,
  sortLiteratureEntries,
} from "../src/services/research/literature-synthesis.js";
import {
  formatBibliography,
  formatCitation,
  type CitationEntry,
} from "../src/services/research/citation-format.js";

/**
 * -L1 literature intelligence tests :
 * academic_literature get/update/remove/synthesize, the review matrix and the
 * citation renderers. Offline: the real MemoryAcademicStore (repository
 * contract), a recording fake event feed and a fake literature client.
 */

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeCtx(uid?: string): ToolRunContext {
  return { uid, scope: {}, collector: new ResultCollector() };
}

function contentOf(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object" && "content" in output) {
    const content = (output as { content?: unknown }).content;
    return typeof content === "string" ? content : "";
  }
  return "";
}

class FakeEventRepository implements AcademicEventRepository {
  readonly events: AcademicEvent[] = [];
  private seq = 0;

  async append(
    uid: string,
    projectId: string,
    type: string,
    payload: Record<string, unknown> = {},
    actor: AcademicActor = "user",
  ): Promise<AcademicEvent> {
    const event: AcademicEvent = {
      id: "e" + (this.seq += 1),
      uid,
      projectId,
      type,
      payload,
      actor,
      createdAt: Date.now(),
    };
    this.events.push(event);
    return structuredClone(event);
  }

  async listEvents(uid: string, projectId: string, limit = 20): Promise<AcademicEvent[]> {
    return this.events
      .filter((event) => event.uid === uid && event.projectId === projectId)
      .slice(-limit)
      .reverse()
      .map((event) => structuredClone(event));
  }
}

class FakeLiteratureClient implements LiteratureClient {
  async search(_query: string, _options?: LiteratureSearchOptions): Promise<LiteratureHit[]> {
    return [];
  }

  async lookupDoi(_doi: string): Promise<LiteratureHit | null> {
    return null;
  }
}

const UID = "u1";

function setup() {
  const store = new MemoryAcademicStore();
  const events = new FakeEventRepository();
  const client = new FakeLiteratureClient();
  const tool = createAcademicLiteratureTool({ literature: store, projects: store, events, client });
  return { store, events, client, tool };
}

type Setup = ReturnType<typeof setup>;

async function seedProject(tools: Setup, uid = UID): Promise<string> {
  const project = await tools.store.create(uid, { title: "文献智能测试项目" });
  return project.id;
}

async function seedEntry(
  tools: Setup,
  projectId: string,
  input: AcademicLiteratureInput,
): Promise<AcademicLiteratureEntry> {
  const result = await tools.store.add(UID, projectId, input);
  return result.entry;
}

const GRAPH_PAPER: AcademicLiteratureInput = {
  citeKey: "zhang2024",
  title: "Deep Learning for Graphs",
  authors: ["San Zhang", "Si Li"],
  year: 2024,
  venue: "Journal of Tests",
  doi: "10.1000/graph.2024",
  abstract: "A".repeat(400),
  tags: ["综述", "图学习"],
  notes: "重点看第三章",
  readingStatus: "reading",
  keywords: ["GNN"],
};

// ---------------------------------------------------------------------------
// academic_literature: get
// ---------------------------------------------------------------------------

describe("academic_literature: get", () => {
 it("renders a detail view resolved by citeKey, entry id and DOI URL", async () => {
    const tools = setup();
    const ctx = makeCtx(UID);
    const projectId = await seedProject(tools);
    const entry = await seedEntry(tools, projectId, GRAPH_PAPER);

    const byCiteKey = contentOf(await tools.tool.execute({ action: "get", projectId, ref: "zhang2024" }, ctx));
    expect(byCiteKey).toContain("【文献详情】[zhang2024]");
    expect(byCiteKey).toContain("Deep Learning for Graphs");
    expect(byCiteKey).toContain("San Zhang, Si Li");
    expect(byCiteKey).toContain("年份：2024");
    expect(byCiteKey).toContain("期刊/会议：Journal of Tests");
    expect(byCiteKey).toContain("DOI：10.1000/graph.2024");
    expect(byCiteKey).toContain("标签：综述、图学习");
    expect(byCiteKey).toContain("阅读状态：" + READING_STATUS_LABELS.reading);
    expect(byCiteKey).toContain("关键词：GNN");
    expect(byCiteKey).toContain("核验：未核验");
    expect(byCiteKey).toContain("笔记：重点看第三章");
    // The detail view keeps a longer abstract than the matrix but still truncates it.
    expect(byCiteKey).toContain("摘要：" + "A".repeat(300) + "…");
    expect(byCiteKey).not.toContain("A".repeat(301));
    expect(byCiteKey).toContain("action=update");

    const byId = contentOf(await tools.tool.execute({ action: "get", projectId, ref: entry.id }, ctx));
    expect(byId).toContain("[zhang2024]");

    const byDoiUrl = contentOf(
      await tools.tool.execute({ action: "get", projectId, ref: "https://doi.org/10.1000/graph.2024" }, ctx),
    );
    expect(byDoiUrl).toContain("[zhang2024]");
  });

 it("degrades to guidance for unknown refs, missing projects and foreign owners", async () => {
    const tools = setup();
    const ctx = makeCtx(UID);
    const projectId = await seedProject(tools);

    expect(
      contentOf(await tools.tool.execute({ action: "get", projectId, ref: "nope" }, ctx)),
    ).toContain("文献库中没有");
    expect(
      contentOf(await tools.tool.execute({ action: "get", projectId: "missing", ref: "nope" }, ctx)),
    ).toContain("项目不存在或无权访问");
    expect(
      contentOf(await tools.tool.execute({ action: "get", projectId, ref: "nope" }, makeCtx("u2"))),
    ).toContain("项目不存在或无权访问");
    expect(
      contentOf(await tools.tool.execute({ action: "get", ref: "nope" }, ctx)),
    ).toContain("缺少 project_id");
  });
});

// ---------------------------------------------------------------------------
// academic_literature: update
// ---------------------------------------------------------------------------

describe("academic_literature: update", () => {
 it("patches tags/reading status/notes, records the event and confirms in Chinese", async () => {
    const tools = setup();
    const ctx = makeCtx(UID);
    const projectId = await seedProject(tools);
    await seedEntry(tools, projectId, GRAPH_PAPER);

    const text = contentOf(
      await tools.tool.execute(
        {
          action: "update",
          projectId,
          ref: "zhang2024",
          tags: ["重点", "方法"],
          readingStatus: "read",
          notes: "已完成精读，方法是 GNN 编码器。",
        },
        ctx,
      ),
    );
    expect(text).toContain("已更新文献 [zhang2024]");
    expect(text).toContain("标签：重点、方法");
    expect(text).toContain("阅读状态：" + READING_STATUS_LABELS.read);
    expect(text).toContain("笔记：已保存");
    expect(text).toContain("action=get");

    const stored = await tools.store.get(UID, projectId, "zhang2024");
    expect(stored?.tags).toEqual(["重点", "方法"]);
    expect(stored?.readingStatus).toBe("read");
    expect(stored?.notes).toBe("已完成精读，方法是 GNN 编码器。");
    // Identity fields stay immutable through the patch path.
    expect(stored?.title).toBe("Deep Learning for Graphs");
    expect(stored?.doi).toBe("10.1000/graph.2024");

    const event = tools.events.events.find((item) => item.type === "literature.updated");
    expect(event?.payload).toEqual({ citeKey: "zhang2024", fields: ["tags", "notes", "readingStatus"] });
    expect(event?.actor).toBe("agent");
  });

 it("resolves a DOI ref and clears fields with empty values", async () => {
    const tools = setup();
    const ctx = makeCtx(UID);
    const projectId = await seedProject(tools);
    await seedEntry(tools, projectId, GRAPH_PAPER);

    const text = contentOf(
      await tools.tool.execute(
        { action: "update", projectId, ref: "10.1000/graph.2024", tags: [], keywords: [], notes: "" },
        ctx,
      ),
    );
    expect(text).toContain("标签：已清空");
    expect(text).toContain("关键词：已清空");
    expect(text).toContain("笔记：已清空");

    const stored = await tools.store.get(UID, projectId, "zhang2024");
    expect(stored?.tags).toEqual([]);
    expect(stored?.keywords).toEqual([]);
    expect(stored?.notes).toBe("");
  });

 it("rejects a call without editable fields and never writes an event", async () => {
    const tools = setup();
    const ctx = makeCtx(UID);
    const projectId = await seedProject(tools);
    await seedEntry(tools, projectId, GRAPH_PAPER);

    const text = contentOf(
      await tools.tool.execute({ action: "update", projectId, ref: "zhang2024" }, ctx),
    );
    expect(text).toContain("至少一个字段");
    expect(tools.events.events).toHaveLength(0);
  });

 it("does not write for unknown refs or foreign projects", async () => {
    const tools = setup();
    const ctx = makeCtx(UID);
    const projectId = await seedProject(tools);
    await seedEntry(tools, projectId, GRAPH_PAPER);

    expect(
      contentOf(
        await tools.tool.execute({ action: "update", projectId, ref: "nope", tags: ["x"] }, ctx),
      ),
    ).toContain("文献库中没有");
    expect(
      contentOf(
        await tools.tool.execute(
          { action: "update", projectId, ref: "zhang2024", tags: ["x"] },
          makeCtx("u2"),
        ),
      ),
    ).toContain("项目不存在或无权访问");
    expect(tools.events.events).toHaveLength(0);
    const stored = await tools.store.get(UID, projectId, "zhang2024");
    expect(stored?.tags).toEqual(["综述", "图学习"]);
  });
});

// ---------------------------------------------------------------------------
// academic_literature: remove
// ---------------------------------------------------------------------------

describe("academic_literature: remove", () => {
 it("removes by citeKey and by DOI, recording literature.removed", async () => {
    const tools = setup();
    const ctx = makeCtx(UID);
    const projectId = await seedProject(tools);
    await seedEntry(tools, projectId, GRAPH_PAPER);
    await seedEntry(tools, projectId, { citeKey: "wang2023", title: "A Survey", authors: ["Wu Wang"], year: 2023 });

    const first = contentOf(
      await tools.tool.execute({ action: "remove", projectId, ref: "zhang2024" }, ctx),
    );
    expect(first).toContain("已从项目文献库删除");
    expect(first).toContain("[zhang2024]");
    expect(first).toContain("不可撤销");
    expect(await tools.store.get(UID, projectId, "zhang2024")).toBeNull();
    expect(tools.events.events.find((event) => event.type === "literature.removed")?.payload).toEqual({
      citeKey: "zhang2024",
    });

    const second = contentOf(
      await tools.tool.execute({ action: "remove", projectId, ref: "10.1000/graph.2024" }, ctx),
    );
    // The DOI was already removed with the first entry; removing it again is guidance, not a crash.
    expect(second).toContain("文献库中没有");

    expect(await tools.store.count(UID, projectId)).toBe(1);
  });

 it("keeps the library unchanged for unknown refs, missing projects and foreign owners", async () => {
    const tools = setup();
    const ctx = makeCtx(UID);
    const projectId = await seedProject(tools);
    await seedEntry(tools, projectId, GRAPH_PAPER);

    expect(
      contentOf(await tools.tool.execute({ action: "remove", projectId, ref: "nope" }, ctx)),
    ).toContain("文献库中没有");
    expect(
      contentOf(await tools.tool.execute({ action: "remove", projectId, ref: "zhang2024" }, makeCtx("u2"))),
    ).toContain("项目不存在或无权访问");
    expect(
      contentOf(await tools.tool.execute({ action: "remove", ref: "zhang2024" }, ctx)),
    ).toContain("缺少 project_id");
    expect(await tools.store.count(UID, projectId)).toBe(1);
    expect(tools.events.events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// academic_literature: synthesize
// ---------------------------------------------------------------------------

describe("academic_literature: synthesize", () => {
 it("returns guidance for an empty library without pushing an artifact", async () => {
    const tools = setup();
    const ctx = makeCtx(UID);
    const projectId = await seedProject(tools);

    const text = contentOf(await tools.tool.execute({ action: "synthesize", projectId }, ctx));
    expect(text).toContain("文献库为空");
    expect(text).toContain("action=import");
    expect(ctx.collector.artifacts).toHaveLength(0);
  });

 it("builds the Markdown matrix, pushes the synthesize artifact and reports counters", async () => {
    const tools = setup();
    const ctx = makeCtx(UID);
    const projectId = await seedProject(tools);
    const older = await seedEntry(tools, projectId, {
      citeKey: "li2020",
      title: "Older Work",
      authors: ["Si Li"],
      year: 2020,
      venue: "Old Venue",
      abstract: "older abstract",
      tags: ["基础"],
    });
    await seedEntry(tools, projectId, GRAPH_PAPER);
    await seedEntry(tools, projectId, {
      citeKey: "nodate",
      title: "Undated Preprint",
      authors: ["Wu Wang"],
      tags: ["预印本"],
      readingStatus: "read",
    });
    await tools.store.setVerified(UID, projectId, older.id, true);

    const text = contentOf(await tools.tool.execute({ action: "synthesize", projectId }, ctx));
    expect(text).toContain("项目文献对比矩阵（共 3 篇，已核验 1 篇，已读 1 篇）");
    expect(text).toContain("| citeKey | 标题 | 年份 | 期刊/会议 | 核验 | 阅读状态 | 标签 | 摘要要点 |");
    expect(text).toContain("li2020");
    expect(text).toContain("zhang2024");
    expect(text).toContain("nodate");
    expect(text).toContain("已核验");
    expect(text).toContain("未读");
    expect(text).toContain("已读");

    const artifact = ctx.collector.artifacts.at(-1);
    expect(artifact?.kind).toBe("academic_literature");
    const data = artifact?.data as {
      action: string;
      projectId: string;
      entries: AcademicLiteratureEntry[];
      total: number;
      markdown: string;
    };
    expect(data.action).toBe("synthesize");
    expect(data.projectId).toBe(projectId);
    expect(data.total).toBe(3);
    expect(data.entries).toHaveLength(3);
    expect(data.entries.map((entry) => entry.year)).toEqual([2020, 2024, undefined]);
    expect(data.markdown).toContain("| li2020 |");
    expect(data.markdown).toContain("| zhang2024 |");
  });

 it("treats missing and foreign projects as not found", async () => {
    const tools = setup();
    const projectId = await seedProject(tools);
    await seedEntry(tools, projectId, GRAPH_PAPER);

    expect(
      contentOf(await tools.tool.execute({ action: "synthesize", projectId: "missing" }, makeCtx(UID))),
    ).toContain("项目不存在或无权访问");
    expect(
      contentOf(await tools.tool.execute({ action: "synthesize", projectId }, makeCtx("u2"))),
    ).toContain("项目不存在或无权访问");
    expect(
      contentOf(await tools.tool.execute({ action: "synthesize" }, makeCtx(UID))),
    ).toContain("缺少 project_id");
  });
});

// ---------------------------------------------------------------------------
// identity boundary
// ---------------------------------------------------------------------------

describe("academic_literature: identity boundary", () => {
 it("refuses the new actions without a uid and never writes", async () => {
    const tools = setup();
    const projectId = await seedProject(tools);
    const anon = makeCtx(undefined);
    for (const args of [
      { action: "get", projectId, ref: "zhang2024" },
      { action: "update", projectId, ref: "zhang2024", tags: ["x"] },
      { action: "remove", projectId, ref: "zhang2024" },
      { action: "synthesize", projectId },
    ] as const) {
      const text = contentOf(await tools.tool.execute(args, anon));
      expect(text).toContain("没有用户身份");
    }
    expect(anon.collector.artifacts).toHaveLength(0);
    expect(tools.events.events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildLiteratureMatrix (pure function)
// ---------------------------------------------------------------------------

function matrixEntry(overrides: Partial<AcademicLiteratureEntry> & { citeKey: string }): AcademicLiteratureEntry {
  return {
    id: overrides.citeKey,
    uid: UID,
    projectId: "p1",
    title: overrides.citeKey,
    authors: [],
    source: "manual",
    verified: false,
    importedAt: 1,
    ...overrides,
  };
}

describe("buildLiteratureMatrix", () => {
 it("escapes table separators and line breaks and truncates abstracts", () => {
    const matrix = buildLiteratureMatrix([
      matrixEntry({
        citeKey: "zhang2024",
        title: "A | B\nC",
        authors: ["San Zhang"],
        year: 2024,
        venue: "V | W",
        abstract: "x".repeat(250),
        tags: ["tag|1", "tag2"],
      }),
    ]);
    const lines = matrix.split("\n");
    expect(lines[0]).toBe("| citeKey | 标题 | 年份 | 期刊/会议 | 核验 | 阅读状态 | 标签 | 摘要要点 |");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain("A \\| B<br>C");
    expect(lines[2]).toContain("V \\| W");
    expect(lines[2]).toContain("tag\\|1、tag2");
    expect(lines[2]).toContain("未核验");
    expect(lines[2]).toContain("未读");
    expect(lines[2]).toContain("x".repeat(DEFAULT_MATRIX_ABSTRACT_CHARS) + "…");
    expect(lines[2]).not.toContain("x".repeat(DEFAULT_MATRIX_ABSTRACT_CHARS + 1));

    const short = buildLiteratureMatrix(
      [matrixEntry({ citeKey: "k", abstract: "abcdefghijklmnopqrstuvwxyz" })],
      { abstractChars: 10 },
    );
    expect(short).toContain("abcdefghij…");
  });

 it("orders by year ascending with undated entries last and returns '' for an empty library", () => {
    const sorted = sortLiteratureEntries([
      matrixEntry({ citeKey: "c", year: 2024 }),
      matrixEntry({ citeKey: "a", year: 2020 }),
      matrixEntry({ citeKey: "b" }),
    ]);
    expect(sorted.map((entry) => entry.citeKey)).toEqual(["a", "c", "b"]);

    const matrix = buildLiteratureMatrix(sorted);
    expect(matrix.indexOf("| a |")).toBeLessThan(matrix.indexOf("| c |"));
    expect(matrix.indexOf("| c |")).toBeLessThan(matrix.indexOf("| b |"));
    expect(buildLiteratureMatrix([])).toBe("");
  });

 it("renders placeholders instead of guessing missing metadata", () => {
    const matrix = buildLiteratureMatrix([matrixEntry({ citeKey: "bare", title: "Bare Title" })]);
    expect(matrix).toContain("| bare | Bare Title | — | — | 未核验 | 未读 | — | — |");
  });
});

// ---------------------------------------------------------------------------
// citation-format (pure functions)
// ---------------------------------------------------------------------------

const FULL_ENTRY: CitationEntry = {
  citeKey: "zhang2024",
  title: "Deep Learning for Graphs",
  authors: ["San Zhang", "Si Li"],
  year: 2024,
  venue: "Journal of Tests",
  doi: "10.1000/graph.2024",
};

describe("citation formatting", () => {
 it("renders the four supported styles", () => {
    expect(formatCitation(FULL_ENTRY, "plain")).toBe(
      "San Zhang, Si Li. Deep Learning for Graphs. Journal of Tests, 2024. DOI: 10.1000/graph.2024.",
    );
    expect(formatCitation(FULL_ENTRY, "apa")).toBe(
      "Zhang, S., & Li, S. (2024). Deep Learning for Graphs. Journal of Tests. https://doi.org/10.1000/graph.2024",
    );
    expect(formatCitation(FULL_ENTRY, "ieee")).toBe(
      'S. Zhang and S. Li, "Deep Learning for Graphs," Journal of Tests, 2024, doi: 10.1000/graph.2024.',
    );
    expect(formatCitation(FULL_ENTRY, "gb7714")).toBe(
      "ZHANG San, LI Si. Deep Learning for Graphs[J]. Journal of Tests, 2024. DOI: 10.1000/graph.2024.",
    );
    // Every declared style must render a non-empty reference.
    for (const style of ACADEMIC_CITATION_STYLES) {
      expect(formatCitation(FULL_ENTRY, style).length).toBeGreaterThan(0);
    }
  });

 it("applies the per-style author rules", () => {
    const three = { ...FULL_ENTRY, authors: ["San Zhang", "Si Li", "Wu Wang"] };
    expect(formatCitation(three, "apa")).toContain("Zhang, S., Li, S., & Wang, W. (2024).");
    expect(formatCitation(three, "ieee")).toContain("S. Zhang, S. Li, and W. Wang,");
    expect(formatCitation(three, "gb7714")).toContain("ZHANG San, LI Si, WANG Wu.");

    const four = { ...FULL_ENTRY, authors: ["San Zhang", "Si Li", "Wu Wang", "Hao Zhao"] };
    expect(formatCitation(four, "gb7714")).toContain("ZHANG San, LI Si, WANG Wu, 等.");

    const mononym = { ...FULL_ENTRY, authors: ["张三"] };
    expect(formatCitation(mononym, "apa")).toContain("张三. (2024).");
    expect(formatCitation(mononym, "ieee")).toContain("张三,");
  });

 it("degrades missing fields instead of inventing them", () => {
    const bare: CitationEntry = { citeKey: "bare", title: "Deep Learning for Graphs", authors: [] };
    expect(formatCitation(bare, "plain")).toBe("Deep Learning for Graphs.");
    expect(formatCitation(bare, "apa")).toBe("Deep Learning for Graphs.");
    expect(formatCitation(bare, "ieee")).toBe('"Deep Learning for Graphs."');
    expect(formatCitation(bare, "gb7714")).toBe("Deep Learning for Graphs[J].");
    for (const style of ACADEMIC_CITATION_STYLES) {
      const rendered = formatCitation(bare, style);
      expect(rendered).not.toContain("undefined");
      expect(rendered).not.toContain("null");
      expect(rendered).not.toContain("DOI");
    }

    // A missing year is omitted rather than rendered as a placeholder year.
    const noYear = { ...FULL_ENTRY, year: undefined };
    expect(formatCitation(noYear, "apa")).not.toContain("(2024)");
    expect(formatCitation(noYear, "apa")).toContain("Zhang, S., & Li, S. Deep Learning for Graphs.");

    // A missing DOI falls back to the stored URL, never to a fabricated DOI.
    const urlOnly = { ...FULL_ENTRY, doi: undefined, url: "https://example.org/paper" };
    expect(formatCitation(urlOnly, "plain")).toContain("https://example.org/paper");
    expect(formatCitation(urlOnly, "plain")).not.toContain("DOI");
  });

 it("sorts bibliographies by citeKey and numbers only IEEE", () => {
    const entries: CitationEntry[] = [
      { citeKey: "wang2023", title: "B", authors: ["Wu Wang"], year: 2023 },
      { citeKey: "zhang2024", title: "A", authors: ["San Zhang"], year: 2024 },
      { citeKey: "li2022", title: "C", authors: ["Si Li"], year: 2022 },
    ];

    const plainLines = formatBibliography(entries, "plain").split("\n");
    expect(plainLines).toHaveLength(3);
    expect(plainLines[0]).toContain("C");
    expect(plainLines[1]).toContain("B");
    expect(plainLines[2]).toContain("A");
    expect(plainLines[0]).not.toMatch(/^\[/);

    const ieeeLines = formatBibliography(entries, "ieee").split("\n");
    expect(ieeeLines[0]).toBe('[1] S. Li, "C," 2022.');
    expect(ieeeLines[1]).toBe('[2] W. Wang, "B," 2023.');
    expect(ieeeLines[2]).toBe('[3] S. Zhang, "A," 2024.');

    // Sorting is case-insensitive but stable.
    const mixedCase = formatBibliography(
      [
        { citeKey: "B2", title: "b", authors: [] },
        { citeKey: "a1", title: "a", authors: [] },
      ],
      "apa",
    ).split("\n");
    expect(mixedCase[0]).toContain("a.");
    expect(mixedCase[1]).toContain("b.");

    expect(formatBibliography([], "ieee")).toBe("");
  });
});
