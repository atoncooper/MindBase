import { describe, expect, it } from "vitest";
import { MemoryAcademicStore } from "../src/repository/memory/academic.js";
import { MemoryAcademicEvidenceStore } from "../src/repository/memory/academic-evidence.js";
import { AcademicService } from "../src/services/research/academic.js";
import { ResearchValidationService } from "../src/services/research/research-validation.js";
import { ResearchStageGateService } from "../src/services/research/research-stage-gates.js";
import { ResearchAdvisorService } from "../src/services/research/research-advisor.js";

/**
 * 科研 Golden Path 评测：创建项目 → 计划 → 文献 → 实验证据 → 稿件 → 校验 → 导出。
 * 断言引用/证据/指标/导出/建议的核心不变量，防止后续改动破坏主流程。
 */
describe("research golden path (eval)", () => {
  it("runs the full project lifecycle with verifiable citations and evidence", async () => {
    const store = new MemoryAcademicStore();
    const evidence = new MemoryAcademicEvidenceStore();
    const academic = new AcademicService({
      projects: store,
      literature: store,
      documents: store,
      events: store,
      client: {} as never,
    });
    const validation = new ResearchValidationService(store, store, store, evidence);
    const gates = new ResearchStageGateService({
      projects: store,
      documents: store,
      literature: store,
      events: store,
      evidence,
      validation,
    });
    const advisor = new ResearchAdvisorService({
      projects: store,
      documents: store,
      literature: store,
      gates,
      evidence,
      validation,
    });

    const created = await academic.createProject("u1", {
      title: "图神经网络推荐系统研究",
      researchQuestion: "GNN 能否提升冷启动推荐效果？",
      objectives: ["构建基线", "验证提升"],
      keywords: ["GNN", "推荐系统"],
      citationStyle: "ieee",
    });
    const projectId = created.project.id;

    await academic.updateProject("u1", projectId, {
      plans: { topic: [{ id: "t1", title: "明确研究问题", done: true }] },
    });

    for (const [title, doi] of [
      ["A Survey", "10.1/a"],
      ["GNN for Rec", "10.1/b"],
      ["Cold Start", "10.1/c"],
    ] as const) {
      const added = await academic.addLiterature("u1", projectId, {
        title,
        authors: ["San Zhang"],
        year: 2024,
        doi,
      });
      await store.setVerified("u1", projectId, added.entry.id, true);
    }

    const run = await evidence.recordRun("u1", projectId, {
      name: "baseline",
      language: "python",
      script: "print('accuracy=0.92')",
      status: "succeeded",
      exitCode: 0,
      stdoutPreview: "accuracy=0.92",
    });
    expect(run.scriptSha256).toBeTruthy();

    const doc = await academic.createDocument("u1", projectId, { kind: "draft", title: "初稿" });
    await academic.saveSection("u1", doc.document.id, { key: "intro", title: "引言", content: "研究背景 [zhang2024]。" });
    await academic.saveSection("u1", doc.document.id, { key: "results", title: "结果", content: "准确率 0.92 [[run:" + run.id + "]]。" });

    const report = await validation.validate("u1", projectId, doc.document.id);
    expect(report.pass).toBe(true);
    expect(report.citations.unverified).toEqual([]);
    expect(report.runs.invalidRefs).toEqual([]);
    expect(report.numbers.matched).toBeGreaterThan(0);

    const exported = await academic.exportDocument("u1", doc.document.id, "markdown");
    expect(exported.text).toContain("## 参考文献");
    expect(exported.text).toContain("A Survey");

    const gate = await gates.evaluate("u1", projectId);
    expect(gate.report.find((entry) => entry.stage === "topic")?.ready).toBe(true);

    const advice = await advisor.suggest("u1", projectId);
    expect(advice.suggestions.length).toBeGreaterThan(0);
  });
});
