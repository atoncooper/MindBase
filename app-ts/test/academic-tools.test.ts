import { describe, expect, it } from "vitest";
import { ResultCollector, type ToolRunContext } from "../src/context/types.js";
import {
  ACADEMIC_STAGES,
  citeKeyFor,
  initialStageStates,
  literatureDedupeKey,
  normalizeDoi,
  slugKey,
  wordCount,
  type AcademicActor,
  type AcademicDocument,
  type AcademicDocumentKind,
  type AcademicDocumentRepository,
  type AcademicEvent,
  type AcademicEventRepository,
  type AcademicLiteratureAddResult,
  type AcademicLiteratureEntry,
  type AcademicLiteratureInput,
  type AcademicLiteratureRepository,
  type AcademicProject,
  type AcademicProjectCreate,
  type AcademicProjectPatch,
  type AcademicProjectRepository,
  type AcademicSection,
  type AcademicSectionInput,
  type AcademicStage,
} from "../src/repository/academic.js";
import type { LiteratureClient, LiteratureHit, LiteratureSearchOptions } from "../src/services/literature-client.js";
import { createAcademicProjectTool } from "../src/tools/academic/project.js";
import { createAcademicLiteratureTool } from "../src/tools/academic/literature.js";
import { createAcademicManuscriptTool } from "../src/tools/academic/manuscript.js";

/**
 * Academic tools (plan/1.0.17 Phase 1): local fakes only — no Mongo, no network.
 * The memory/Mongo adapters are implemented in parallel, so the repositories here
 * are deliberately self-contained doubles of repository/academic.ts.
 */

function clone<T>(value: T): T {
  return structuredClone(value);
}

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

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeProjectRepository implements AcademicProjectRepository {
  readonly projects = new Map<string, AcademicProject>();
  private seq = 0;

  async create(uid: string, input: AcademicProjectCreate): Promise<AcademicProject> {
    const now = Date.now();
    const id = "p" + (this.seq += 1);
    const project: AcademicProject = {
      id,
      uid,
      title: input.title,
      paperType: input.paperType ?? "journal",
      field: input.field ?? "",
      targetJournal: input.targetJournal,
      deadline: input.deadline,
      stage: "topic",
      stages: initialStageStates(now),
      plans: {},
      advice: {},
      createdAt: now,
      updatedAt: now,
    };
    this.projects.set(uid + "/" + id, project);
    return clone(project);
  }

  async list(uid: string): Promise<AcademicProject[]> {
    return [...this.projects.values()].filter((project) => project.uid === uid).map((project) => clone(project));
  }

  async get(uid: string, projectId: string): Promise<AcademicProject | null> {
    const project = this.projects.get(uid + "/" + projectId);
    return project ? clone(project) : null;
  }

  async update(uid: string, projectId: string, patch: AcademicProjectPatch): Promise<AcademicProject | null> {
    const key = uid + "/" + projectId;
    const project = this.projects.get(key);
    if (!project) return null;
    const next: AcademicProject = {
      ...project,
      stages: { ...project.stages },
      plans: { ...project.plans },
      advice: { ...project.advice },
      updatedAt: Date.now(),
    };
    if (patch.title !== undefined) next.title = patch.title;
    if (patch.paperType !== undefined) next.paperType = patch.paperType;
    if (patch.field !== undefined) next.field = patch.field;
    if (patch.targetJournal !== undefined) next.targetJournal = patch.targetJournal;
    if (patch.deadline !== undefined) next.deadline = patch.deadline;
    if (patch.stage !== undefined) next.stage = patch.stage;
    for (const stage of ACADEMIC_STAGES) {
      const state = patch.stages?.[stage];
      if (state) next.stages[stage] = state;
      const plan = patch.plans?.[stage];
      if (plan) next.plans[stage] = plan;
      const advice = patch.advice?.[stage];
      if (advice !== undefined) next.advice[stage] = advice;
    }
    this.projects.set(key, next);
    return clone(next);
  }

  async remove(uid: string, projectId: string): Promise<boolean> {
    return this.projects.delete(uid + "/" + projectId);
  }
}

class FakeLiteratureRepository implements AcademicLiteratureRepository {
  readonly entries = new Map<string, AcademicLiteratureEntry>();
  /** Number of bulk batches received; the import path must use exactly one addMany call. */
  addManyCalls = 0;
  private seq = 0;

  async add(
    uid: string,
    projectId: string,
    input: AcademicLiteratureInput,
  ): Promise<{ entry: AcademicLiteratureEntry; duplicate: boolean }> {
    const identity = literatureDedupeKey(input);
    for (const entry of this.entries.values()) {
      if (entry.uid !== uid || entry.projectId !== projectId) continue;
      if (literatureDedupeKey(entry) === identity) return { entry: clone(entry), duplicate: true };
    }
    const existingKeys = [...this.entries.values()]
      .filter((entry) => entry.uid === uid && entry.projectId === projectId)
      .map((entry) => entry.citeKey);
    const suggested = input.citeKey?.trim() || citeKeyFor(input, existingKeys);
    let citeKey = suggested;
    if (existingKeys.some((key) => key.toLowerCase() === suggested.toLowerCase())) {
      citeKey = citeKeyFor(input, existingKeys);
    }
    const id = "l" + (this.seq += 1);
    const entry: AcademicLiteratureEntry = {
      id,
      uid,
      projectId,
      citeKey,
      title: input.title,
      authors: input.authors ?? [],
      year: input.year,
      venue: input.venue,
      doi: input.doi,
      url: input.url,
      abstract: input.abstract,
      source: input.source ?? "manual",
      verified: false,
      importedAt: Date.now(),
    };
    this.entries.set(uid + "/" + id, entry);
    return { entry: clone(entry), duplicate: false };
  }

  async addMany(
    uid: string,
    projectId: string,
    inputs: AcademicLiteratureInput[],
  ): Promise<AcademicLiteratureAddResult[]> {
    this.addManyCalls += 1;
    const results: AcademicLiteratureAddResult[] = [];
    // Sequential adds reproduce the contract's "duplicates within the batch resolve
    // to the first occurrence" rule while keeping the double trivial.
    for (const input of inputs) results.push(await this.add(uid, projectId, input));
    return results;
  }

  async count(uid: string, projectId: string): Promise<number> {
    let total = 0;
    for (const entry of this.entries.values()) {
      if (entry.uid === uid && entry.projectId === projectId) total += 1;
    }
    return total;
  }

  async list(uid: string, projectId: string): Promise<AcademicLiteratureEntry[]> {
    return [...this.entries.values()]
      .filter((entry) => entry.uid === uid && entry.projectId === projectId)
      .map((entry) => clone(entry));
  }

  async get(uid: string, projectId: string, ref: string): Promise<AcademicLiteratureEntry | null> {
    for (const entry of this.entries.values()) {
      if (entry.uid !== uid || entry.projectId !== projectId) continue;
      if (entry.id === ref || entry.citeKey.toLowerCase() === ref.toLowerCase()) return clone(entry);
    }
    return null;
  }

  async findByDoi(uid: string, projectId: string, doi: string): Promise<AcademicLiteratureEntry | null> {
    const target = normalizeDoi(doi);
    for (const entry of this.entries.values()) {
      if (entry.uid !== uid || entry.projectId !== projectId) continue;
      if (normalizeDoi(entry.doi) === target) return clone(entry);
    }
    return null;
  }

  async setVerified(
    uid: string,
    projectId: string,
    ref: string,
    verified: boolean,
  ): Promise<AcademicLiteratureEntry | null> {
    const found = await this.get(uid, projectId, ref);
    if (!found) return null;
    const entry = this.entries.get(uid + "/" + found.id);
    if (!entry) return null;
    entry.verified = verified;
    entry.verifiedAt = verified ? Date.now() : undefined;
    return clone(entry);
  }

  async remove(uid: string, projectId: string, ref: string): Promise<boolean> {
    const found = await this.get(uid, projectId, ref);
    if (!found) return false;
    return this.entries.delete(uid + "/" + found.id);
  }
}

class FakeDocumentRepository implements AcademicDocumentRepository {
  readonly documents = new Map<string, AcademicDocument>();
  private seq = 0;

  async createDocument(
    uid: string,
    projectId: string,
    input: { kind: AcademicDocumentKind; title: string; sections?: AcademicSectionInput[] },
  ): Promise<AcademicDocument> {
    const now = Date.now();
    const id = "d" + (this.seq += 1);
    const sections: AcademicSection[] = (input.sections ?? []).map((section, index) => ({
      key: section.key?.trim() || slugKey(section.title) || "section-" + (index + 1),
      title: section.title,
      content: section.content ?? "",
      order: section.order ?? index,
      updatedAt: now,
    }));
    const doc: AcademicDocument = {
      id,
      uid,
      projectId,
      kind: input.kind,
      title: input.title,
      sections,
      createdAt: now,
      updatedAt: now,
    };
    this.documents.set(uid + "/" + id, doc);
    return clone(doc);
  }

  async listDocuments(uid: string, projectId: string): Promise<AcademicDocument[]> {
    return [...this.documents.values()]
      .filter((doc) => doc.uid === uid && doc.projectId === projectId)
      .map((doc) => clone(doc));
  }

  async countDocuments(uid: string, projectId: string): Promise<number> {
    let total = 0;
    for (const doc of this.documents.values()) {
      if (doc.uid === uid && doc.projectId === projectId) total += 1;
    }
    return total;
  }

  async getDocument(uid: string, documentId: string): Promise<AcademicDocument | null> {
    const doc = this.documents.get(uid + "/" + documentId);
    return doc ? clone(doc) : null;
  }

  async updateDocument(uid: string, documentId: string, patch: { title?: string }): Promise<AcademicDocument | null> {
    const key = uid + "/" + documentId;
    const doc = this.documents.get(key);
    if (!doc) return null;
    const next: AcademicDocument = { ...doc, updatedAt: Date.now() };
    if (patch.title !== undefined) next.title = patch.title;
    this.documents.set(key, next);
    return clone(next);
  }

  async upsertSection(
    uid: string,
    documentId: string,
    input: AcademicSectionInput,
  ): Promise<AcademicDocument | null> {
    const key = uid + "/" + documentId;
    const doc = this.documents.get(key);
    if (!doc) return null;
    const now = Date.now();
    const sections = doc.sections.map((section) => ({ ...section }));
    const index = input.key ? sections.findIndex((section) => section.key === input.key) : -1;
    if (index >= 0) {
      const existing = sections[index];
      sections[index] = {
        key: existing.key,
        title: input.title,
        content: input.content !== undefined ? input.content : existing.content,
        order: input.order !== undefined ? input.order : existing.order,
        updatedAt: now,
      };
    } else {
      sections.push({
        key: input.key?.trim() || slugKey(input.title) || "section-" + (sections.length + 1),
        title: input.title,
        content: input.content ?? "",
        order: input.order ?? sections.length,
        updatedAt: now,
      });
    }
    const next: AcademicDocument = { ...doc, sections, updatedAt: now };
    this.documents.set(key, next);
    return clone(next);
  }

  async deleteSection(uid: string, documentId: string, sectionKey: string): Promise<AcademicDocument | null> {
    const key = uid + "/" + documentId;
    const doc = this.documents.get(key);
    if (!doc) return null;
    const next: AcademicDocument = {
      ...doc,
      sections: doc.sections.filter((section) => section.key !== sectionKey),
      updatedAt: Date.now(),
    };
    this.documents.set(key, next);
    return clone(next);
  }
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
    return clone(event);
  }

  async listEvents(uid: string, projectId: string, limit = 20): Promise<AcademicEvent[]> {
    return this.events
      .filter((event) => event.uid === uid && event.projectId === projectId)
      .slice(-limit)
      .reverse()
      .map((event) => clone(event));
  }
}

class FakeLiteratureClient implements LiteratureClient {
  hits: LiteratureHit[] = [];
  readonly dois = new Map<string, LiteratureHit>();
  fail = false;

  async search(_query: string, options?: LiteratureSearchOptions): Promise<LiteratureHit[]> {
    if (this.fail) throw new Error("network down");
    return this.hits.slice(0, options?.limit ?? 5).map((hit) => clone(hit));
  }

  async lookupDoi(doi: string): Promise<LiteratureHit | null> {
    if (this.fail) throw new Error("network down");
    const hit = this.dois.get(normalizeDoi(doi));
    return hit ? clone(hit) : null;
  }
}

function setup() {
  const projects = new FakeProjectRepository();
  const literature = new FakeLiteratureRepository();
  const documents = new FakeDocumentRepository();
  const events = new FakeEventRepository();
  const client = new FakeLiteratureClient();
  return {
    projects,
    literature,
    documents,
    events,
    client,
    projectTool: createAcademicProjectTool({ projects, events, literature, documents }),
    literatureTool: createAcademicLiteratureTool({ literature, projects, events, client }),
    manuscriptTool: createAcademicManuscriptTool({ documents, projects, events }),
  };
}

type TestTools = ReturnType<typeof setup>;

async function seedProject(tools: TestTools, ctx: ToolRunContext, title = "图神经网络推荐研究"): Promise<string> {
  const out = await tools.projectTool.execute({ action: "create", title, field: "计算机科学", paperType: "journal" }, ctx);
  const match = /project_id: (p\d+)/.exec(contentOf(out));
  if (!match) throw new Error("project id not found in: " + contentOf(out));
  return match[1];
}

const BIBTEX_SAMPLE = [
  "@article{zhang2024,",
  "  title = {Deep Learning for Graphs},",
  "  author = {San Zhang and Si Li},",
  "  year = {2024},",
  "  journal = {Journal of Tests},",
  "  doi = {10.1000/graph.2024}",
  "}",
  "",
  "@article{wang2023,",
  "  title = {A Survey of Graph Learning},",
  "  author = {Wu Wang},",
  "  year = {2023},",
  "  journal = {Survey Journal}",
  "}",
].join("\n");

// ---------------------------------------------------------------------------

describe("academic tools: identity boundary", () => {
  it("refuses every action when ctx.uid is missing and never writes", async () => {
    const tools = setup();
    const anon = makeCtx(undefined);

    const projectText = contentOf(await tools.projectTool.execute({ action: "list" }, anon));
    const literatureText = contentOf(
      await tools.literatureTool.execute({ action: "search", query: "graph neural network" }, anon),
    );
    const manuscriptText = contentOf(await tools.manuscriptTool.execute({ action: "documents", projectId: "p1" }, anon));

    for (const text of [projectText, literatureText, manuscriptText]) {
      expect(text).toContain("没有用户身份");
    }
    expect(tools.projects.projects.size).toBe(0);
    expect(tools.events.events).toHaveLength(0);
    expect(anon.collector.artifacts).toHaveLength(0);
  });
});

describe("academic_project", () => {
  it("creates a project, records the event and pushes an artifact", async () => {
    const tools = setup();
    const ctx = makeCtx("u1");
    const projectId = await seedProject(tools, ctx);

    expect(projectId).toMatch(/^p\d+$/);
    const project = tools.projects.projects.get("u1/" + projectId);
    expect(project?.title).toBe("图神经网络推荐研究");
    expect(project?.stage).toBe("topic");
    expect(project?.stages.topic.status).toBe("active");

    const event = tools.events.events[0];
    expect(event?.type).toBe("project.created");
    expect(event?.actor).toBe("agent");
    expect(event?.projectId).toBe(projectId);
    expect(ctx.collector.artifacts[0]?.kind).toBe("academic_project");

    const listText = contentOf(await tools.projectTool.execute({ action: "list" }, ctx));
    expect(listText).toContain("图神经网络推荐研究");
    expect(listText).toContain(projectId);
  });

  it("brief reports stages, plans, advice and recent events", async () => {
    const tools = setup();
    const ctx = makeCtx("u1");
    const projectId = await seedProject(tools, ctx);
    await tools.projectTool.execute(
      { action: "plan_set", projectId, stage: "topic", tasks: ["确定研究问题", "检索综述文献"] },
      ctx,
    );
    await tools.projectTool.execute(
      { action: "save_advice", projectId, stage: "topic", advice: "先把范围收窄到图推荐，不要同时做多任务。" },
      ctx,
    );

    const text = contentOf(await tools.projectTool.execute({ action: "brief", projectId }, ctx));
    expect(text).toContain("项目：「图神经网络推荐研究」");
    expect(text).toContain("阶段进展");
    expect(text).toContain("选题");
    expect(text).toContain("0/2 完成");
    expect(text).toContain("先把范围收窄到图推荐");
    expect(text).toContain("创建项目");
    expect(text).toContain("最近事件");
  });

  it("brief counts literature and documents without loading their contents", async () => {
    const tools = setup();
    const ctx = makeCtx("u1");
    const projectId = await seedProject(tools, ctx);
    await tools.literatureTool.execute({ action: "import", projectId, text: BIBTEX_SAMPLE }, ctx);
    await tools.manuscriptTool.execute({ action: "create_document", projectId, title: "投稿初稿" }, ctx);

    // Counting must go through the O(1) projections: a brief that paged in the whole
    // library or the document bodies would regress here.
    let literatureListed = false;
    let documentsListed = false;
    tools.literature.list = async () => {
      literatureListed = true;
      return [];
    };
    tools.documents.listDocuments = async () => {
      documentsListed = true;
      return [];
    };

    const text = contentOf(await tools.projectTool.execute({ action: "brief", projectId }, ctx));
    expect(text).toContain("文献 2 篇 / 稿件 1 篇");
    expect(literatureListed).toBe(false);
    expect(documentsListed).toBe(false);
  });

  it("validates stage_update: forward ok, backward requires a reason", async () => {
    const tools = setup();
    const ctx = makeCtx("u1");
    const projectId = await seedProject(tools, ctx);

    const advance = contentOf(
      await tools.projectTool.execute({ action: "stage_update", projectId, stage: "design" }, ctx),
    );
    expect(advance).toContain("研究设计");
    const advanced = tools.projects.projects.get("u1/" + projectId);
    expect(advanced?.stage).toBe("design");
    expect(advanced?.stages.design.status).toBe("active");
    const advanceEvent = tools.events.events.find((event) => event.type === "stage.updated");
    expect(advanceEvent?.payload.direction).toBe("advance");
    expect(advanceEvent?.payload.previousStage).toBe("topic");

    const rewindWithoutReason = contentOf(
      await tools.projectTool.execute({ action: "stage_update", projectId, stage: "topic" }, ctx),
    );
    expect(rewindWithoutReason).toContain("reason");
    expect(tools.projects.projects.get("u1/" + projectId)?.stage).toBe("design");

    const rewind = contentOf(
      await tools.projectTool.execute(
        { action: "stage_update", projectId, stage: "topic", reason: "审稿意见要求补充选题依据" },
        ctx,
      ),
    );
    expect(rewind).toContain("回退");
    const rewound = tools.projects.projects.get("u1/" + projectId);
    expect(rewound?.stage).toBe("topic");
    expect(rewound?.stages.topic.note).toContain("审稿意见");
    const rewindEvent = tools.events.events.filter((event) => event.type === "stage.updated").pop();
    expect(rewindEvent?.payload.direction).toBe("rewind");
    expect(rewindEvent?.payload.reason).toContain("审稿意见");
  });

  it("rejects missing and foreign project ids without throwing", async () => {
    const tools = setup();
    const ctx = makeCtx("u1");
    const projectId = await seedProject(tools, ctx);

    expect(contentOf(await tools.projectTool.execute({ action: "brief" }, ctx))).toContain("缺少 project_id");
    expect(
      contentOf(await tools.projectTool.execute({ action: "brief", projectId: "p999" }, ctx)),
    ).toContain("项目不存在或无权访问");

    const foreign = makeCtx("u2");
    expect(
      contentOf(await tools.projectTool.execute({ action: "brief", projectId }, foreign)),
    ).toContain("项目不存在或无权访问");
  });

  it("writes and reads a stage plan without losing done state", async () => {
    const tools = setup();
    const ctx = makeCtx("u1");
    const projectId = await seedProject(tools, ctx);

    await tools.projectTool.execute(
      { action: "plan_set", projectId, stage: "topic", tasks: ["确定研究问题", "检索综述文献"] },
      ctx,
    );
    const stored = tools.projects.projects.get("u1/" + projectId);
    stored?.plans.topic?.forEach((task) => {
      task.done = true;
    });

    const getText = contentOf(
      await tools.projectTool.execute({ action: "plan_get", projectId, stage: "topic" }, ctx),
    );
    expect(getText).toContain("确定研究问题");

    await tools.projectTool.execute(
      { action: "plan_set", projectId, stage: "topic", tasks: ["确定研究问题", "检索综述文献"] },
      ctx,
    );
    const reset = tools.projects.projects.get("u1/" + projectId);
    expect(reset?.plans.topic?.map((task) => task.done)).toEqual([true, true]);
    expect(tools.events.events.some((event) => event.type === "plan.updated")).toBe(true);
  });
});

describe("academic_literature", () => {
  it("formats search hits as unverified candidates (no project needed)", async () => {
    const tools = setup();
    tools.client.hits = [
      {
        source: "crossref",
        title: "Attention Is All You Need",
        authors: ["Ashish Vaswani", "Noam Shazeer"],
        year: 2017,
        venue: "NeurIPS",
        doi: "10.1000/xyz",
        url: "https://doi.org/10.1000/xyz",
      },
    ];
    const ctx = makeCtx("u1");
    const text = contentOf(
      await tools.literatureTool.execute({ action: "search", query: "attention transformer", limit: 3 }, ctx),
    );
    expect(text).toContain("《Attention Is All You Need》");
    expect(text).toContain("Ashish Vaswani");
    expect(text).toContain("2017");
    expect(text).toContain("DOI: 10.1000/xyz");
    expect(text).toContain("未核验");
    expect(text).toContain("不能直接引用");
    expect(ctx.collector.artifacts[0]?.kind).toBe("academic_literature");
    expect((ctx.collector.artifacts[0]?.data as { action: string }).action).toBe("search");
  });

  it("degrades a search failure to guidance text", async () => {
    const tools = setup();
    tools.client.fail = true;
    const text = contentOf(
      await tools.literatureTool.execute({ action: "search", query: "graph" }, makeCtx("u1")),
    );
    expect(text).toContain("检索失败");
    expect(text).toContain("network down");
  });

  it("adds a confirmed candidate to the library and dedupes a repeat add", async () => {
    const tools = setup();
    const ctx = makeCtx("u1");
    const projectId = await seedProject(tools, ctx);

    const added = contentOf(
      await tools.literatureTool.execute(
        {
          action: "add",
          projectId,
          title: "Attention Is All You Need",
          authors: ["Ashish Vaswani"],
          year: 2017,
          venue: "NeurIPS",
          doi: "https://doi.org/10.1000/xyz",
        },
        ctx,
      ),
    );
    expect(added).toContain("已加入项目文献库");
    expect(added).toContain("[vaswani2017]");
    const entries = await tools.literature.list("u1", projectId);
    expect(entries).toHaveLength(1);
    expect(entries[0].doi).toBe("10.1000/xyz");
    expect(entries[0].verified).toBe(false);
    const addEvent = tools.events.events.find((event) => event.type === "literature.added");
    expect(addEvent?.payload.citeKey).toBe("vaswani2017");

    const again = contentOf(
      await tools.literatureTool.execute(
        { action: "add", projectId, title: "Attention Is All You Need", year: 2017, doi: "10.1000/xyz" },
        ctx,
      ),
    );
    expect(again).toContain("已有该文献");
    expect(await tools.literature.list("u1", projectId)).toHaveLength(1);
  });

  it("imports BibTeX, dedupes a second import and records the event", async () => {
    const tools = setup();
    const ctx = makeCtx("u1");
    const projectId = await seedProject(tools, ctx);

    const first = contentOf(
      await tools.literatureTool.execute({ action: "import", projectId, text: BIBTEX_SAMPLE }, ctx),
    );
    expect(first).toContain("新增 2 篇");
    expect(first).toContain("重复 0 篇");
    const importEvent = tools.events.events.find((event) => event.type === "literature.imported");
    expect(importEvent?.payload.added).toBe(2);
    expect(importEvent?.payload.source).toBe("bibtex");

    const entries = await tools.literature.list("u1", projectId);
    expect(entries).toHaveLength(2);
    expect(entries.every((entry) => entry.verified === false)).toBe(true);
    expect(entries.map((entry) => entry.title)).toContain("Deep Learning for Graphs");

    const second = contentOf(
      await tools.literatureTool.execute({ action: "import", projectId, text: BIBTEX_SAMPLE }, ctx),
    );
    expect(second).toContain("新增 0 篇");
    expect(second).toContain("重复 2 篇");
    expect(await tools.literature.list("u1", projectId)).toHaveLength(2);

    const listText = contentOf(await tools.literatureTool.execute({ action: "list", projectId }, ctx));
    expect(listText).toContain("未核验");
    expect(listText).toContain("Deep Learning for Graphs");
  });

  it("imports CSL-JSON arrays", async () => {
    const tools = setup();
    const ctx = makeCtx("u1");
    const projectId = await seedProject(tools, ctx);
    const csl = JSON.stringify([
      {
        id: "csl2020",
        title: "A CSL Paper",
        author: [{ given: "Ada", family: "Lovelace" }],
        issued: { "date-parts": [[2020]] },
        "container-title": "CSL Journal",
        DOI: "10.1000/csl.2020",
      },
    ]);
    const text = contentOf(
      await tools.literatureTool.execute({ action: "import", projectId, text: csl }, ctx),
    );
    expect(text).toContain("新增 1 篇");
    const entries = await tools.literature.list("u1", projectId);
    expect(entries[0]?.authors).toEqual(["Ada Lovelace"]);
    expect(entries[0]?.year).toBe(2020);
    expect(entries[0]?.source).toBe("csl");
  });

  it("pages the library list with a total count and a limit annotation", async () => {
    const tools = setup();
    const ctx = makeCtx("u1");
    const projectId = await seedProject(tools, ctx);
    await tools.literatureTool.execute({ action: "import", projectId, text: BIBTEX_SAMPLE }, ctx);
    const csl = JSON.stringify([{ id: "csl2020", title: "A CSL Paper" }]);
    await tools.literatureTool.execute({ action: "import", projectId, text: csl }, ctx);

    const firstPage = contentOf(await tools.literatureTool.execute({ action: "list", projectId, limit: 1 }, ctx));
    expect(firstPage).toContain("项目文献库共 3 篇");
    expect(firstPage).toContain("已显示前 1 篇");
    expect(firstPage).toContain("action=list limit 可调");
    expect(firstPage).toContain("Deep Learning for Graphs");
    expect(firstPage).not.toContain("A Survey of Graph Learning");

    const full = contentOf(await tools.literatureTool.execute({ action: "list", projectId }, ctx));
    expect(full).toContain("共 3 篇");
    expect(full).not.toContain("已显示前");
    expect(full).toContain("A Survey of Graph Learning");
    const artifact = ctx.collector.artifacts.filter((item) => item.kind === "academic_literature").pop();
    expect((artifact?.data as { total?: number }).total).toBe(3);
  });

  it("imports a batch with one addMany call and no pre-read of the library", async () => {
    const tools = setup();
    const ctx = makeCtx("u1");
    const projectId = await seedProject(tools, ctx);

    // The bulk path must not list() the library first just to seed a cite-key pool.
    let libraryReads = 0;
    const originalList = tools.literature.list.bind(tools.literature);
    tools.literature.list = async (uid: string, projectIdArg: string) => {
      libraryReads += 1;
      return originalList(uid, projectIdArg);
    };

    const first = contentOf(
      await tools.literatureTool.execute({ action: "import", projectId, text: BIBTEX_SAMPLE }, ctx),
    );
    expect(first).toContain("解析 2 篇，新增 2 篇，重复 0 篇");
    expect(tools.literature.addManyCalls).toBe(1);
    expect(libraryReads).toBe(0);

    const again = contentOf(
      await tools.literatureTool.execute({ action: "import", projectId, text: BIBTEX_SAMPLE }, ctx),
    );
    expect(again).toContain("解析 2 篇，新增 0 篇，重复 2 篇");
    expect(tools.literature.addManyCalls).toBe(2);
    expect(libraryReads).toBe(0);

    const importedEvents = tools.events.events.filter((event) => event.type === "literature.imported");
    expect(importedEvents[0]?.payload).toMatchObject({ parsed: 2, added: 2, duplicates: 0 });
    expect(importedEvents[1]?.payload).toMatchObject({ parsed: 2, added: 0, duplicates: 2 });
  });

  it("verify: Crossref hit flips verified, unknown DOI stays unverified", async () => {
    const tools = setup();
    const ctx = makeCtx("u1");
    const projectId = await seedProject(tools, ctx);
    await tools.literatureTool.execute({ action: "import", projectId, text: BIBTEX_SAMPLE }, ctx);
    const before = await tools.literature.list("u1", projectId);
    const target = before.find((entry) => entry.doi === "10.1000/graph.2024");
    expect(target).toBeDefined();

    const miss = contentOf(
      await tools.literatureTool.execute({ action: "verify", projectId, ref: target?.citeKey ?? "" }, ctx),
    );
    expect(miss).toContain("未核验");
    expect(miss).toContain("未被 Crossref 收录");
    expect((await tools.literature.list("u1", projectId)).every((entry) => !entry.verified)).toBe(true);

    tools.client.dois.set(
      "10.1000/graph.2024",
      {
        source: "crossref",
        title: "Deep Learning for Graphs",
        authors: ["San Zhang", "Si Li"],
        year: 2024,
        venue: "Journal of Tests",
        doi: "10.1000/graph.2024",
      },
    );
    const hit = contentOf(
      await tools.literatureTool.execute({ action: "verify", projectId, ref: target?.citeKey ?? "" }, ctx),
    );
    expect(hit).toContain("已核验");
    expect(hit).toContain("citeKey: " + (target?.citeKey ?? ""));
    const verified = (await tools.literature.list("u1", projectId)).find((entry) => entry.id === target?.id);
    expect(verified?.verified).toBe(true);
    expect(tools.events.events.some((event) => event.type === "literature.verified")).toBe(true);

    const unknown = contentOf(
      await tools.literatureTool.execute({ action: "verify", projectId, ref: "10.9999/nope" }, ctx),
    );
    expect(unknown).toContain("未被 Crossref 收录");

    const missing = contentOf(
      await tools.literatureTool.execute({ action: "verify", projectId, ref: "nosuchcitekey" }, ctx),
    );
    expect(missing).toContain("文献库中没有");
  });

  it("verify: network failure is reported, never thrown", async () => {
    const tools = setup();
    const ctx = makeCtx("u1");
    const projectId = await seedProject(tools, ctx);
    await tools.literatureTool.execute({ action: "import", projectId, text: BIBTEX_SAMPLE }, ctx);
    tools.client.fail = true;
    const text = contentOf(
      await tools.literatureTool.execute({ action: "verify", projectId, ref: "10.1000/graph.2024" }, ctx),
    );
    expect(text).toContain("核验失败");
    expect(text).toContain("仍未核验");
  });

  it("exports BibTeX with author joined by 'and'", async () => {
    const tools = setup();
    const ctx = makeCtx("u1");
    const projectId = await seedProject(tools, ctx);
    await tools.literatureTool.execute({ action: "import", projectId, text: BIBTEX_SAMPLE }, ctx);
    const text = contentOf(
      await tools.literatureTool.execute({ action: "export_bibtex", projectId }, ctx),
    );
    expect(text).toContain("@article{zhang2024");
    expect(text).toContain("author = {San Zhang and Si Li}");
    expect(text).toContain("journal = {Journal of Tests}");
    expect(text).toContain("doi = {10.1000/graph.2024}");
    expect(ctx.collector.artifacts.some((artifact) => artifact.kind === "academic_literature")).toBe(true);
  });
});

describe("academic_manuscript", () => {
  it("creates a document with the default six sections and an artifact", async () => {
    const tools = setup();
    const ctx = makeCtx("u1");
    const projectId = await seedProject(tools, ctx);
    const text = contentOf(
      await tools.manuscriptTool.execute(
        { action: "create_document", projectId, title: "投稿初稿", kind: "draft" },
        ctx,
      ),
    );
    expect(text).toContain("已创建写作文档《投稿初稿》");
    const docs = await tools.documents.listDocuments("u1", projectId);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.sections.map((section) => section.key)).toEqual([
      "abstract",
      "introduction",
      "related-work",
      "method",
      "experiment",
      "conclusion",
    ]);
    expect(ctx.collector.artifacts.some((artifact) => artifact.kind === "academic_manuscript")).toBe(true);
    expect(tools.events.events.some((event) => event.type === "manuscript.document_created")).toBe(true);
  });

  it("saves a section, reads it back and lists documents", async () => {
    const tools = setup();
    const ctx = makeCtx("u1");
    const projectId = await seedProject(tools, ctx);
    const createText = contentOf(
      await tools.manuscriptTool.execute({ action: "create_document", projectId, title: "投稿初稿" }, ctx),
    );
    const documentId = /document_id: (d\d+)/.exec(createText)?.[1] ?? "";
    expect(documentId).toMatch(/^d\d+$/);
    const content = "我们提出 50% & 参数_x 的方法。";
    const expectedWords = wordCount(content);

    const saveText = contentOf(
      await tools.manuscriptTool.execute(
        { action: "save", projectId, documentId, title: "方法", content },
        ctx,
      ),
    );
    expect(saveText).toContain("已保存章节「方法」");
    expect(saveText).toContain("key: method");
    expect(saveText).toContain(expectedWords + " 字");
    const saveEvent = tools.events.events.find((event) => event.type === "manuscript.section_saved");
    expect(saveEvent?.payload.wordCount).toBe(expectedWords);

    const readText = contentOf(
      await tools.manuscriptTool.execute({ action: "read", projectId, documentId, key: "method" }, ctx),
    );
    expect(readText).toContain("【方法】");
    expect(readText).toContain(content);

    const docsText = contentOf(await tools.manuscriptTool.execute({ action: "documents", projectId }, ctx));
    expect(docsText).toContain(documentId);
    expect(docsText).toContain("初稿");
    expect(docsText).toContain("章节 6");
  });

  it("exports markdown and an escaped LaTeX article", async () => {
    const tools = setup();
    const ctx = makeCtx("u1");
    const projectId = await seedProject(tools, ctx);
    const createText = contentOf(
      await tools.manuscriptTool.execute(
        { action: "create_document", projectId, title: "图学习综述" },
        ctx,
      ),
    );
    const documentId = /document_id: (d\d+)/.exec(createText)?.[1] ?? "";
    const content = "我们提出 50% & 参数_x 的方法。";
    await tools.manuscriptTool.execute(
      { action: "save", projectId, documentId, title: "方法", content },
      ctx,
    );

    const markdown = contentOf(
      await tools.manuscriptTool.execute({ action: "export_markdown", projectId, documentId }, ctx),
    );
    expect(markdown).toContain("# 图学习综述");
    expect(markdown).toContain("## 方法");
    expect(markdown).toContain(content);

    const latex = contentOf(
      await tools.manuscriptTool.execute({ action: "export_latex", projectId, documentId }, ctx),
    );
    expect(latex).toContain("\\documentclass[11pt]{article}");
    expect(latex).toContain("\\section{方法}");
    expect(latex).toContain("50\\% \\& 参数\\_x");
    expect(latex).toContain("\\end{document}");
    expect(ctx.collector.artifacts.some((artifact) => artifact.kind === "academic_manuscript")).toBe(true);
  });

  it("outline_update reorders without overwriting section content", async () => {
    const tools = setup();
    const ctx = makeCtx("u1");
    const projectId = await seedProject(tools, ctx);
    const createText = contentOf(
      await tools.manuscriptTool.execute({ action: "create_document", projectId, title: "修改稿" }, ctx),
    );
    const documentId = /document_id: (d\d+)/.exec(createText)?.[1] ?? "";
    await tools.manuscriptTool.execute(
      { action: "save", projectId, documentId, title: "方法", content: "方法正文必须保留。" },
      ctx,
    );

    const outlineText = contentOf(
      await tools.manuscriptTool.execute(
        {
          action: "outline_update",
          projectId,
          documentId,
          sections: [
            { key: "method", title: "研究方法" },
            { key: "conclusion", title: "结论与展望" },
            { key: "appendix", title: "附录" },
          ],
        },
        ctx,
      ),
    );
    expect(outlineText).toContain("正文未被覆盖");
    const readText = contentOf(
      await tools.manuscriptTool.execute({ action: "read", projectId, documentId, key: "method" }, ctx),
    );
    expect(readText).toContain("方法正文必须保留。");
    const doc = await tools.documents.getDocument("u1", documentId);
    expect(doc?.sections.find((section) => section.key === "method")?.title).toBe("研究方法");
    expect(doc?.sections.some((section) => section.key === "appendix")).toBe(true);
    expect(tools.events.events.some((event) => event.type === "manuscript.outline_updated")).toBe(true);
  });

  it("enforces project and document ownership", async () => {
    const tools = setup();
    const ctx = makeCtx("u1");
    const projectId = await seedProject(tools, ctx);
    const createText = contentOf(
      await tools.manuscriptTool.execute({ action: "create_document", projectId, title: "初稿" }, ctx),
    );
    const documentId = /document_id: (d\d+)/.exec(createText)?.[1] ?? "";

    expect(
      contentOf(await tools.manuscriptTool.execute({ action: "documents", projectId: "p999" }, ctx)),
    ).toContain("项目不存在或无权访问");

    const other = await seedProject(tools, makeCtx("u1"), "另一个项目");
    expect(
      contentOf(
        await tools.manuscriptTool.execute({ action: "read", projectId: other, documentId, key: "abstract" }, ctx),
      ),
    ).toContain("文档不存在或无权访问");

    const foreign = makeCtx("u2");
    expect(
      contentOf(await tools.manuscriptTool.execute({ action: "documents", projectId }, foreign)),
    ).toContain("项目不存在或无权访问");
  });
});
