import { describe, expect, it } from "vitest";
import { buildResearchPaperGraph } from "../src/agent/dag/templates.js";
import { validatePlan } from "../src/agent/dag/graph.js";
import { ResearchValidationService } from "../src/services/research-validation.js";

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
  });
});
