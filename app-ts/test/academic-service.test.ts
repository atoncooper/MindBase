import { describe, expect, it, vi } from "vitest";
import { MemoryAcademicStore } from "../src/repository/memory/academic.js";
import { AcademicService } from "../src/services/academic.js";
import type { LiteratureClient, LiteratureHit, LiteratureSearchOptions } from "../src/services/literature-client.js";

/**
 * Service-level tests for the /academic/* REST surface (plan/1.0.17 Phase 2):
 * ownership, validation, counters, literature verification semantics, manuscript
 * CRUD/export and event writing. Offline: memory repositories + fake client.
 */

class FakeLiteratureClient implements LiteratureClient {
  hits: LiteratureHit[] = [];
  dois = new Map<string, LiteratureHit>();
  failSearch = false;
  failDoi = false;

  async search(_query: string, options?: LiteratureSearchOptions): Promise<LiteratureHit[]> {
    if (this.failSearch) throw new Error("network down");
    return this.hits.slice(0, options?.limit ?? 5).map((hit) => ({ ...hit, authors: [...hit.authors] }));
  }

  async lookupDoi(doi: string): Promise<LiteratureHit | null> {
    if (this.failDoi) throw new Error("network down");
    const hit = this.dois.get(doi);
    return hit ? { ...hit, authors: [...hit.authors] } : null;
  }
}

function setup() {
  const store = new MemoryAcademicStore();
  const client = new FakeLiteratureClient();
  const service = new AcademicService({
    projects: store,
    literature: store,
    documents: store,
    events: store,
    client,
  });
  return { store, client, service };
}

const UID = "u1";

describe("academic service: projects", () => {
  it("creates a project with default stage state, zero counters and a created event", async () => {
    const { service } = setup();
    const detail = await service.createProject(UID, { title: "联邦学习隐私预算", field: "机器学习" });
    expect(detail.project.title).toBe("联邦学习隐私预算");
    expect(detail.project.stage).toBe("topic");
    expect(detail.project.stages.topic.status).toBe("active");
    expect(detail.project.stages.design.status).toBe("locked");
    expect(detail.project.literatureCount).toBe(0);
    expect(detail.project.documentCount).toBe(0);
    expect(detail.events.some((event) => event.type === "project.created")).toBe(true);
    expect(detail.project).not.toHaveProperty("uid");
  });

  it("lists projects newest-first with counters", async () => {
    // Pin the clock: two projects created in the same millisecond would tie on
    // updatedAt/createdAt, making the newest-first assertion depend on UUID order.
    let clock = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock++);
    try {
      const { service } = setup();
      const first = await service.createProject(UID, { title: "A" });
      const second = await service.createProject(UID, { title: "B" });
      await service.addLiterature(UID, first.project.id, { title: "Paper", doi: "10.1/x" });
      const { projects } = await service.listProjects(UID);
      expect(projects.map((p) => p.title)).toEqual(["B", "A"]);
      expect(projects.find((p) => p.id === first.project.id)?.literatureCount).toBe(1);
      expect(second.project.literatureCount).toBe(0);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("updates stage/plans/advice with key-merge semantics and clears on empty values", async () => {
    const { service } = setup();
    const { project } = await service.createProject(UID, { title: "A" });
    const patched = await service.updateProject(UID, project.id, {
      stage: "design",
      stages: { design: { status: "active" } },
      plans: { design: [{ id: "t1", title: "完成研究设计", done: false }] },
      advice: { topic: "先做文献综述" },
    });
    expect(patched.project.stage).toBe("design");
    expect(patched.project.stages.design.status).toBe("active");
    expect(patched.plans.design?.[0].title).toBe("完成研究设计");
    expect(patched.advice.topic).toBe("先做文献综述");

    const cleared = await service.updateProject(UID, project.id, { plans: { design: [] }, advice: { topic: "" } });
    expect(cleared.plans.design).toEqual([]);
    expect(cleared.advice.topic).toBe("");
  });

  it("rejects invalid input and treats foreign/missing projects as 404", async () => {
    const { service } = setup();
    await expect(service.createProject(UID, { title: "   " })).rejects.toMatchObject({ status: 400 });
    await expect(service.createProject(UID, { title: "A", paperType: "blog" })).rejects.toMatchObject({ status: 400 });
    const { project } = await service.createProject(UID, { title: "A" });
    await expect(service.getProject("u2", project.id)).rejects.toMatchObject({ status: 404 });
    await expect(service.getProject(UID, "missing")).rejects.toMatchObject({ status: 404 });
    await expect(service.updateProject(UID, project.id, {})).rejects.toMatchObject({ status: 400 });
    await expect(service.updateProject(UID, project.id, { stage: "bogus" })).rejects.toMatchObject({ status: 400 });
  });

  it("deletes an owned project", async () => {
    const { service } = setup();
    const { project } = await service.createProject(UID, { title: "A" });
    expect(await service.deleteProject(UID, project.id)).toEqual({ deleted: true });
    await expect(service.getProject(UID, project.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe("academic service: literature", () => {
  it("adds, dedupes, paginates and totals", async () => {
    const { service } = setup();
    const { project } = await service.createProject(UID, { title: "A" });
    const first = await service.addLiterature(UID, project.id, { title: "Paper One", year: 2024, doi: "10.1/a" });
    expect(first.duplicate).toBe(false);
    const again = await service.addLiterature(UID, project.id, { title: "Paper One", year: 2024, doi: "https://doi.org/10.1/A" });
    expect(again.duplicate).toBe(true);
    for (let i = 0; i < 4; i++) await service.addLiterature(UID, project.id, { title: "P" + i, doi: "10.1/p" + i });
    const page = await service.listLiterature(UID, project.id, { limit: 2, offset: 0 });
    expect(page.total).toBe(5);
    expect(page.entries).toHaveLength(2);
    const second = await service.listLiterature(UID, project.id, { limit: 2, offset: 2 });
    expect(second.entries).toHaveLength(2);
    expect(second.entries[0].id).not.toBe(page.entries[0].id);
    expect(page.entries[0].importedAt).toBeGreaterThanOrEqual(page.entries[1].importedAt);
  });

  it("verifies a DOI only when Crossref returns the same title", async () => {
    const { service, client } = setup();
    const { project } = await service.createProject(UID, { title: "A" });
    const { entry } = await service.addLiterature(UID, project.id, { title: "Attention Is All You Need", year: 2017, doi: "10.1/attn" });
    client.dois.set("10.1/attn", { source: "crossref", title: "Attention is all you need", authors: ["A"], doi: "10.1/attn" });
    const ok = await service.verifyLiterature(UID, project.id, entry.citeKey);
    expect(ok.verified).toBe(true);
    expect(ok.entry.verified).toBe(true);
    const list = await service.listLiterature(UID, project.id, {});
    expect(list.entries[0].verified).toBe(true);
  });

  it("keeps unverified when Crossref misses, titles differ or the service fails", async () => {
    const { service, client } = setup();
    const { project } = await service.createProject(UID, { title: "A" });
    const { entry } = await service.addLiterature(UID, project.id, { title: "Some Paper", doi: "10.1/missing" });
    const miss = await service.verifyLiterature(UID, project.id, entry.id);
    expect(miss.verified).toBe(false);
    expect(miss.message).toContain("未收录");

    client.dois.set("10.1/missing", { source: "crossref", title: "Completely Different Work", authors: ["B"], doi: "10.1/missing" });
    const mismatch = await service.verifyLiterature(UID, project.id, entry.id);
    expect(mismatch.verified).toBe(false);
    expect(mismatch.message).toContain("标题不一致");

    client.failDoi = true;
    const failed = await service.verifyLiterature(UID, project.id, entry.id);
    expect(failed.verified).toBe(false);
    expect(failed.message).toContain("不可用");
  });

  it("explains why a DOI-less paper cannot be verified and 404s unknown refs", async () => {
    const { service } = setup();
    const { project } = await service.createProject(UID, { title: "A" });
    const { entry } = await service.addLiterature(UID, project.id, { title: "No DOI paper" });
    const result = await service.verifyLiterature(UID, project.id, entry.citeKey);
    expect(result.verified).toBe(false);
    expect(result.message).toContain("没有 DOI");
    await expect(service.verifyLiterature(UID, project.id, "10.9/unknown")).rejects.toMatchObject({ status: 404 });
  });

  it("exports BibTeX, removes entries and searches via the client", async () => {
    const { service, client } = setup();
    const { project } = await service.createProject(UID, { title: "A" });
    await service.addLiterature(UID, project.id, { title: "Paper", authors: ["San Zhang"], year: 2024, doi: "10.1/x" });
    const { bibtex } = await service.exportBibtex(UID, project.id);
    expect(bibtex).toContain("@article{zhang2024");
    expect(bibtex).toContain("doi = {10.1/x}");
    expect(await service.removeLiterature(UID, project.id, "10.1/x")).toEqual({ deleted: true });
    await expect(service.removeLiterature(UID, project.id, "10.1/x")).rejects.toMatchObject({ status: 404 });

    client.hits = [{ source: "crossref", title: "Hit", authors: ["A"], year: 2020 }];
    const { hits } = await service.searchLiterature(UID, { q: "graph", limit: 3 });
    expect(hits).toHaveLength(1);
    client.failSearch = true;
    await expect(service.searchLiterature(UID, { q: "graph" })).rejects.toMatchObject({ status: 502 });
  });
});

describe("academic service: documents", () => {
  it("creates the default six-section outline and reports word counts", async () => {
    const { service } = setup();
    const { project } = await service.createProject(UID, { title: "A" });
    const { document } = await service.createDocument(UID, project.id, { kind: "draft", title: "初稿" });
    expect(document.sections).toHaveLength(6);
    expect(document.sections.map((section) => section.key)).toContain("introduction");

    const saved = await service.saveSection(UID, document.id, { title: "引言", content: "联邦学习面临隐私预算分配问题。" });
    const intro = saved.document.sections.find((section) => section.key === "introduction");
    expect(intro?.content).toContain("隐私预算");

    const { documents } = await service.listDocuments(UID, project.id);
    expect(documents[0].sectionCount).toBe(6);
    expect(documents[0].wordCount).toBeGreaterThan(10);
  });

  it("upserts by key, deletes sections and exports markdown/latex", async () => {
    const { service } = setup();
    const { project } = await service.createProject(UID, { title: "A" });
    const { document } = await service.createDocument(UID, project.id, { kind: "draft", title: "初稿" });
    await service.saveSection(UID, document.id, { key: "method", title: "方法", content: "方法正文 50%" });
    const second = await service.saveSection(UID, document.id, { key: "method", title: "方法", content: "方法正文更新" });
    expect(second.document.sections.filter((section) => section.key === "method")).toHaveLength(1);

    const md = await service.exportDocument(UID, document.id, "markdown");
    expect(md.text).toContain("# 初稿");
    expect(md.text).toContain("方法正文更新");
    const tex = await service.exportDocument(UID, document.id, "latex");
    expect(tex.text).toContain("\\documentclass");
    expect(tex.text).toContain("\\section{方法}");

    const afterDelete = await service.deleteSection(UID, document.id, "method");
    expect(afterDelete.document.sections.some((section) => section.key === "method")).toBe(false);
    await expect(service.exportDocument(UID, document.id, "pdf")).rejects.toMatchObject({ status: 400 });
  });

  it("hides documents owned by another user", async () => {
    const { service } = setup();
    const { project } = await service.createProject(UID, { title: "A" });
    const { document } = await service.createDocument(UID, project.id, { kind: "draft", title: "初稿" });
    await expect(service.getDocument("u2", document.id)).rejects.toMatchObject({ status: 404 });
    await expect(service.saveSection("u2", document.id, { title: "方法" })).rejects.toMatchObject({ status: 404 });
  });
});

describe("academic service: events", () => {
  it("records user mutations and honors the read limit", async () => {
    const { service } = setup();
    const { project } = await service.createProject(UID, { title: "A" });
    await service.updateProject(UID, project.id, { stage: "design" });
    const { events } = await service.listEvents(UID, project.id, { limit: 1 });
    expect(events).toHaveLength(1);
    const all = await service.listEvents(UID, project.id, { limit: 50 });
    expect(all.events.map((event) => event.type)).toEqual(expect.arrayContaining(["project.created", "stage.updated"]));
  });
});
