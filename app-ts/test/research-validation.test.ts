import { describe, expect, it } from "vitest";
import { buildResearchPaperGraph } from "../src/agent/dag/templates.js";
import { validatePlan } from "../src/agent/dag/graph.js";
import { ResearchValidationService } from "../src/services/research/research-validation.js";

const project = {
  id: "p1",
  uid: "1",
  title: "t",
  stage: "writing",
  stages: {},
  plans: {},
  advice: {},
  literatureCount: 0,
  documentCount: 0,
  createdAt: 1,
  updatedAt: 1,
};

const document = {
  id: "d1",
  uid: "1",
  projectId: "p1",
  kind: "draft",
  title: "paper",
  sections: [
    { key: "results", title: "结果", order: 1, content: "准确率 0.92。", updatedAt: 1 },
    { key: "intro", title: "引言", order: 2, content: "见 \\cite{zhang2024}。", updatedAt: 1 },
  ],
  createdAt: 1,
  updatedAt: 1,
};

const literature = [
  {
    id: "l1",
    uid: "1",
    projectId: "p1",
    citeKey: "zhang2024",
    title: "paper",
    authors: ["z"],
    source: "manual",
    verified: false,
    importedAt: 1,
  },
];

const run = {
  id: "r1",
  uid: "1",
  projectId: "p1",
  name: "exp",
  language: "python",
  status: "succeeded",
  createdAt: 1,
  scriptSha256: "abc",
};

describe("research paper template", () => {
 it("is a valid DAG covering the research pipeline", () => {
    const graph = buildResearchPaperGraph({ goal: "研究 X", projectId: "p1", workspaceId: "w1" });
    const errors = validatePlan(graph, {
      builtinAgents: ["note", "code"],
      allowedTools: [
        "run_code",
        "academic_project",
        "academic_literature",
        "academic_manuscript",
        "academic_evidence",
        // DAG experiment/analysis nodes were moved onto the human-gated
        // experiment + analysis tools (root change); keep the plan valid.
        "academic_experiment",
        "academic_analysis",
        "academic_validation",
        "research_workspace",
        "vector_search",
      ],
      maxNodes: 12,
      maxAgents: 6,
    });
    expect(errors).toEqual([]);
    expect(graph.nodes.map((n) => n.id)).toEqual([
      "topic",
      "literature",
      "design",
      "experiment",
      "analysis",
      "writing",
      "review",
    ]);
  });
});

describe("ResearchValidationService", () => {
 it("detects unverified citations and results without run evidence", async () => {
    const service = new ResearchValidationService(
      { get: async () => project } as never,
      { getDocument: async () => document, listDocuments: async () => [document] } as never,
      { list: async () => literature } as never,
      { listRuns: async () => [run] } as never,
    );
    const report = await service.validate("1", "p1", "d1");
    expect(report.pass).toBe(false);
    expect(report.citations.unverified).toEqual(["zhang2024"]);
    expect(report.results.withoutEvidenceRef).toEqual(["结果"]);
    expect(report.runs.unreproducible).toEqual([]);
    // v1.1 field: no [[run:<id>]] in this manuscript, so no invalid references;
    // the numeric result section is reported by the advisory text heuristics.
    expect(report.runs.invalidRefs).toEqual([]);
    expect(report.sectionsWithNumbers).toEqual(["结果"]);
    expect(report.sectionsMissingRunRef).toEqual(["结果"]);
  });
});

// ---------------------------------------------------------------------------
// v1.1: [[run:<id>]] existence/status checks + whole-manuscript number heuristics
// ---------------------------------------------------------------------------

type SectionInput = { key: string; title: string; content: string };

/** Builds a document payload around the given sections (keeps the shared ids). */
function documentWith(sections: SectionInput[]) {
  return {
    ...document,
    sections: sections.map((section, index) => ({ ...section, order: index + 1, updatedAt: 1 })),
  };
}

/** Minimal service wiring: repositories are call doubles, like the tests above. */
function validationService(
  doc: ReturnType<typeof documentWith>,
  runs: unknown[],
  library: unknown[] = literature,
) {
  return new ResearchValidationService(
    { get: async () => project } as never,
    { getDocument: async () => doc, listDocuments: async () => [doc] } as never,
    { list: async () => library } as never,
    { listRuns: async () => runs } as never,
  );
}

const verifiedLiterature = [{ ...literature[0], verified: true }];

describe("ResearchValidationService v1.1: invalid run references", () => {
 it("flags a [[run:<id>]] that does not exist in the evidence ledger", async () => {
    const doc = documentWith([
      { key: "results", title: "结果", content: "准确率 0.92 [[run:fake-run]]。" },
    ]);
    const report = await validationService(doc, [run]).validate("1", "p1", "d1");
    expect(report.runs.invalidRefs).toEqual(["fake-run"]);
    expect(report.pass).toBe(false);
    // The reference exists syntactically, so the results gate itself is satisfied.
    expect(report.results.withoutEvidenceRef).toEqual([]);
  });

 it("flags a referenced run whose status is not succeeded", async () => {
    const failedRun = { ...run, id: "r2", status: "failed" };
    const doc = documentWith([
      { key: "results", title: "结果", content: "准确率 0.92 [[run:r2]]。" },
    ]);
    const report = await validationService(doc, [run, failedRun]).validate("1", "p1", "d1");
    expect(report.runs.invalidRefs).toEqual(["r2"]);
    expect(report.pass).toBe(false);
  });

 it("accepts references to succeeded runs and passes a clean manuscript", async () => {
    const doc = documentWith([
      { key: "results", title: "结果", content: "准确率 0.92 [[run:r1]]。" },
      { key: "intro", title: "引言", content: "见 \\cite{zhang2024}。" },
    ]);
    const report = await validationService(doc, [run], verifiedLiterature).validate("1", "p1", "d1");
    expect(report.runs.invalidRefs).toEqual([]);
    expect(report.pass).toBe(true);
    expect(report.sectionsWithNumbers).toEqual(["结果"]);
    expect(report.sectionsMissingRunRef).toEqual([]);
  });

 it("keeps invalid references deduplicated in first-appearance order", async () => {
    const doc = documentWith([
      { key: "results", title: "结果", content: "[[run:b]] 与 [[run:a]]，再次 [[run:b]]。" },
    ]);
    const report = await validationService(doc, [run]).validate("1", "p1", "d1");
    expect(report.runs.invalidRefs).toEqual(["b", "a"]);
  });
});

describe("ResearchValidationService v1.1: whole-manuscript number warnings", () => {
 it("reports numeric sections and missing run refs as advisory fields", async () => {
    const doc = documentWith([
      { key: "results", title: "结果", content: "准确率 0.92 [[run:r1]]。" },
      { key: "method", title: "方法", content: "实验温度设为 25 摄氏度。" },
      // Bibliography chapters are excluded: their years/volumes are not results.
      { key: "references", title: "参考文献", content: "Zhang 2024, vol. 3, pp. 1-10." },
      { key: "intro", title: "引言", content: "见 \\cite{zhang2024}。" },
    ]);
    const report = await validationService(doc, [run], verifiedLiterature).validate("1", "p1", "d1");
    expect(report.sectionsWithNumbers).toEqual(["结果", "方法"]);
    expect(report.sectionsMissingRunRef).toEqual(["方法"]);
    // Both fields are advisory: the report still passes when the hard gates are clean.
    expect(report.pass).toBe(true);
  });

 it("does not let advisory number warnings mask a failed gate", async () => {
    const doc = documentWith([
      { key: "method", title: "方法", content: "温度为 25 摄氏度。" },
      { key: "intro", title: "引言", content: "见 \\cite{zhang2024}。" },
    ]);
    const report = await validationService(doc, [run], literature).validate("1", "p1", "d1");
    expect(report.sectionsWithNumbers).toEqual(["方法"]);
    expect(report.sectionsMissingRunRef).toEqual(["方法"]);
    // zhang2024 is still unverified, so the hard citation gate fails.
    expect(report.pass).toBe(false);
  });
});
