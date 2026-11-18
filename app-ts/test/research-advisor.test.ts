import { describe, expect, it } from "vitest";
import { MemoryAcademicStore } from "../src/repository/memory/academic.js";
import { ResearchAdvisorService, type ResearchAdvisorDeps } from "../src/services/research/research-advisor.js";
import { ResearchStageGateService } from "../src/services/research/research-stage-gates.js";
import { createAcademicProjectTool } from "../src/tools/academic/project.js";
import type { AcademicValidationReport } from "../src/services/research/research-validation.js";

const ctx = { uid: "u1", collector: { pushArtifacts: () => {} } } as never;

function advisor(
  store: MemoryAcademicStore,
  options: { validation?: { validate: () => Promise<AcademicValidationReport> }; gates?: boolean } = {},
) {
  const deps: ResearchAdvisorDeps = { projects: store, documents: store, literature: store };
  if (options.validation) deps.validation = options.validation;
  if (options.gates) {
    deps.gates = new ResearchStageGateService({
      projects: store,
      documents: store,
      literature: store,
      events: store,
    });
  }
  return new ResearchAdvisorService(deps);
}

function failingReport(): AcademicValidationReport {
  return {
    pass: false,
    citations: { total: 1, missing: ["missing-key"], unverified: [] },
    runs: { total: 0, unreproducible: [], invalidRefs: [] },
    results: { sections: [], withoutEvidenceRef: [] },
    sectionsWithNumbers: [],
    sectionsMissingRunRef: [],
  };
}

describe("ResearchAdvisorService ", () => {
 it("suggests a stage plan and more literature for a fresh project", async () => {
    const store = new MemoryAcademicStore();
    const project = await store.create("u1", { title: "graph rag", researchQuestion: "如何…" });
    const result = await advisor(store).suggest("u1", project.id);
    expect(result.stage).toBe("topic");
    const titles = result.suggestions.map((item) => item.title).join("\\n");
    expect(titles).toContain("生成执行计划");
    expect(titles).toContain("补充文献");
    expect(result.suggestions.length).toBeLessThanOrEqual(3);
  });

 it("drops the literature/draft suggestions once the project has them", async () => {
    const store = new MemoryAcademicStore();
    const project = await store.create("u1", { title: "t" });
    for (const title of ["A", "B", "C"]) {
      await store.add("u1", project.id, { title, authors: ["Z"], year: 2024 });
    }
    const doc = await store.createDocument("u1", project.id, { kind: "draft", title: "初稿" });
    for (const key of ["intro", "method", "results"]) {
      await store.upsertSection("u1", doc.id, { key, title: key, content: "正文内容" });
    }
    const result = await advisor(store).suggest("u1", project.id);
    const titles = result.suggestions.map((item) => item.title).join("\\n");
    expect(titles).not.toContain("补充文献");
    expect(titles).not.toContain("创建初稿");
  });

 it("surfaces a failing integrity report as a next action", async () => {
    const store = new MemoryAcademicStore();
    const project = await store.create("u1", { title: "t" });
    await store.update("u1", project.id, {
      plans: { topic: [{ id: "t1", title: "明确研究问题", done: true }] },
    });
    for (const title of ["A", "B", "C"]) await store.add("u1", project.id, { title, authors: ["Z"], year: 2024 });
    const doc = await store.createDocument("u1", project.id, { kind: "draft", title: "初稿" });
    for (const key of ["intro", "method", "results"]) {
      await store.upsertSection("u1", doc.id, { key, title: key, content: "正文内容" });
    }
    const result = await advisor(store, {
      gates: true,
      validation: { validate: async () => failingReport() },
    }).suggest("u1", project.id);
    expect(result.suggestions.map((item) => item.title).join("\\n")).toContain("运行校验");
  });

 it("warns about a deadline within two weeks", async () => {
    const store = new MemoryAcademicStore();
    const due = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const project = await store.create("u1", { title: "t", deadline: due });
    const result = await advisor(store).suggest("u1", project.id);
    expect(result.suggestions.map((item) => item.title).join("\\n")).toContain("临近截止");
  });

 it("404s on a foreign project", async () => {
    const store = new MemoryAcademicStore();
    const project = await store.create("u1", { title: "t" });
    await expect(advisor(store).suggest("u2", project.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe("academic_project update action ", () => {
 it("persists research metadata through the agent tool", async () => {
    const store = new MemoryAcademicStore();
    const project = await store.create("u1", { title: "t" });
    const tool = createAcademicProjectTool({
      projects: store,
      events: store,
      literature: store,
      documents: store,
    });
    const result = await tool.execute(
      {
        action: "update",
        projectId: project.id,
        researchQuestion: "核心问题是什么？",
        objectives: ["目标一", "目标二"],
        keywords: ["GNN", "RAG"],
        methodology: "对照实验",
        language: "zh",
        citationStyle: "apa",
      } as never,
      ctx,
    );
    expect(String(result)).toContain("已更新项目");
    const stored = await store.get("u1", project.id);
    expect(stored?.researchQuestion).toBe("核心问题是什么？");
    expect(stored?.objectives).toEqual(["目标一", "目标二"]);
    expect(stored?.keywords).toEqual(["GNN", "RAG"]);
    expect(stored?.citationStyle).toBe("apa");
  });
});
