import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { runWithRequestContext } from "../src/context/request-context.js";
import {
  ACADEMIC_MAX_RUN_METRICS,
  buildAcademicRun,
  type AcademicRunMetric,
  type AcademicRunInput,
} from "../src/repository/academic-evidence.js";
import { MemoryAcademicEvidenceStore } from "../src/repository/memory/academic-evidence.js";
import { MemoryAcademicStore } from "../src/repository/memory/academic.js";
import { MemoryResearchExperimentRepository } from "../src/repository/memory/research-experiments.js";
import { MemoryResearchWorkspaceRepository } from "../src/repository/memory/research-workspaces.js";
import { AcademicService } from "../src/services/research/academic.js";
import { ResearchAnalysisService } from "../src/services/research/research-analysis.js";
import { ResearchExperimentRunner } from "../src/services/research/research-experiment.js";
import { ResearchValidationService } from "../src/services/research/research-validation.js";
import { ResearchWorkspaceService } from "../src/services/research/research-workspace.js";
import { registerResearchRoutes } from "../src/transport/http/routes/research.js";
import type { LiteratureClient, LiteratureHit, LiteratureSearchOptions } from "../src/clients/literature-client.js";
import type { CodeExecutionPort } from "../src/tools/code/code-execution.js";

/**
 * Multi-run metric extraction / comparison tests.
 *
 * Everything runs offline over memory repositories: metric parsing goes through
 * buildAcademicRun (both store implementations persist its output), the analysis
 * service is exercised directly, and the REST surface runs through Fastify
 * inject with the uid coming from the request context.
 */

class FakeLiteratureClient implements LiteratureClient {
  async search(_q: string, _options?: LiteratureSearchOptions): Promise<LiteratureHit[]> {
    return [];
  }
  async lookupDoi(_doi: string): Promise<LiteratureHit | null> {
    return null;
  }
}

const noopPort: CodeExecutionPort = {
  run: async () => ({ ok: true, stdout: "", stderr: "", sandboxAvailable: true }),
};

/** In-memory stand-in for the app-cloud M2M client (folder tree + upload). */
class FakeCloud {
  configured = true;
  private nextId = 1;

  async createFolder(_uid: string, name: string, _parentId?: number) {
    return { id: this.nextId++, name };
  }

  async uploadFile(_uid: string, _folderId: number, name: string, data: Uint8Array, _mimeType?: string) {
    return { upload_uuid: "upload-" + this.nextId++, name, size: data.byteLength };
  }

  async listFiles(_uid: string, _folderId?: number) {
    return [];
  }
}

interface Harness {
  app: FastifyInstance;
  evidence: MemoryAcademicEvidenceStore;
  analysis: ResearchAnalysisService;
  academic: AcademicService;
}

function buildHarness(): Harness {
  const store = new MemoryAcademicStore();
  const evidence = new MemoryAcademicEvidenceStore();
  const workspace = new ResearchWorkspaceService(
    new MemoryResearchWorkspaceRepository(),
    new FakeCloud() as never,
  );
  const academic = new AcademicService({
    projects: store,
    literature: store,
    documents: store,
    events: store,
    client: new FakeLiteratureClient(),
  });
  const analysis = new ResearchAnalysisService(store, evidence, store, workspace);
  const experiments = new ResearchExperimentRunner(new MemoryResearchExperimentRepository(), noopPort, 1);
  const validation = new ResearchValidationService(store, store, store, evidence);

  const app = Fastify();
  app.addHook("onRequest", (req, _reply, done) => {
    const raw = req.headers["x-uid"];
    runWithRequestContext(
      { requestId: "test", uid: typeof raw === "string" ? raw : undefined, startedAt: Date.now() },
      done,
    );
  });
  registerResearchRoutes(app, { academic, experiments, evidence, validation, analysis, workspace });
  return { app, evidence, analysis, academic };
}

const asUid = (uid: string) => ({ "x-uid": uid, "content-type": "application/json" });

async function createProject(academic: AcademicService, uid: string, title: string): Promise<string> {
  const detail = await academic.createProject(uid, { title });
  return detail.project.id;
}

/** Minimal run payload; the builder is the only place metrics are derived. */
function runInput(name: string, stdoutPreview?: string): AcademicRunInput {
  return {
    name,
    language: "python",
    status: "succeeded",
    exitCode: 0,
    ...(stdoutPreview !== undefined ? { stdoutPreview } : {}),
  };
}

function build(stdoutPreview: string, metrics?: AcademicRunMetric[]) {
  return buildAcademicRun({
    id: "run-1",
    uid: "u1",
    projectId: "p1",
    at: 1,
    run: { ...runInput("基线", stdoutPreview), ...(metrics !== undefined ? { metrics } : {}) },
  });
}

// ---------------------------------------------------------------------------
// stdout → metrics extraction (contract builder)
// ---------------------------------------------------------------------------

describe("buildAcademicRun metric extraction", () => {
  it("parses METRIC / [METRIC] / metric: lines and JSON lines, last value wins", () => {
    const run = build(
      [
        "training start",
        "METRIC acc=0.91",
        "[METRIC] loss=0.12",
        "metric: f1=0.88",
        "  Metric: precision = 0.7  ",
        '{"metric":"acc","value":0.93,"unit":"%"}',
        '  {"name":"latency","value":12.5}  ',
        "training done",
      ].join("\n"),
    );
    expect(run.metrics).toEqual([
      { name: "acc", value: 0.93, unit: "%" },
      { name: "loss", value: 0.12 },
      { name: "f1", value: 0.88 },
      { name: "precision", value: 0.7 },
      { name: "latency", value: 12.5 },
    ]);
  });

  it("ignores malformed lines, non-finite values and non-numeric JSON values", () => {
    const run = build(
      [
        "METRIC acc=abc",
        "METRIC acc=NaN",
        "acc=0.91",
        '{"metric":"loss","value":"0.12"}',
        '{"metric":"inf","value":1e999}',
        '{"metric":"missing-value"}',
        "{not json}",
        "not-a-metric",
        "METRIC good=1",
      ].join("\n"),
    );
    expect(run.metrics).toEqual([{ name: "good", value: 1 }]);
  });

  it("keeps the last value per name and caps distinct metrics at 50", () => {
    const lines = Array.from({ length: 60 }, (_value, index) => "METRIC m" + index + "=" + index);
    lines.push("METRIC m0=999");
    const run = build(lines.join("\n"));
    expect(run.metrics).toHaveLength(ACADEMIC_MAX_RUN_METRICS);
    expect(run.metrics?.[0]).toEqual({ name: "m0", value: 999 });
    expect(run.metrics?.some((metric) => metric.name === "m59")).toBe(false);
  });

  it("lets explicit metrics override extraction and sanitizes them", () => {
    const run = build("METRIC acc=0.1", [
      { name: "  acc ", value: 0.2 },
      { name: "  ", value: 1 },
      { name: "nan", value: Number.NaN },
      { name: "unit", value: 3, unit: " % " },
    ]);
    expect(run.metrics).toEqual([
      { name: "acc", value: 0.2 },
      { name: "unit", value: 3, unit: "%" },
    ]);
  });

  it("omits the metrics field when the output has no metric lines", () => {
    const run = build("plain output\nno metrics here");
    expect("metrics" in run).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Metrics persisted by the evidence repository
// ---------------------------------------------------------------------------

describe("evidence repository metrics", () => {
  it("persists builder-extracted metrics and reads return copies", async () => {
    const store = new MemoryAcademicEvidenceStore();
    const persisted = await store.recordRun("u1", "p1", {
      name: "基线训练",
      language: "python",
      stdoutPreview: 'METRIC acc=0.91\nMETRIC loss=0.12\n{"metric":"f1","value":0.8}',
    });
    expect(persisted.metrics).toEqual([
      { name: "acc", value: 0.91 },
      { name: "loss", value: 0.12 },
      { name: "f1", value: 0.8 },
    ]);

    const listed = await store.listRuns("u1", "p1");
    expect(listed[0].metrics).toEqual(persisted.metrics);

    listed[0].metrics!.push({ name: "injected", value: 0 });
    const again = await store.getRun("u1", "p1", persisted.id);
    expect(again?.metrics).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Results table metric column
// ---------------------------------------------------------------------------

describe("results table metrics column", () => {
  it("renders one metric cell per run and an em dash when a run has none", async () => {
    const harness = buildHarness();
    const projectId = await createProject(harness.academic, "1", "结果表项目");
    const withMetrics = await harness.evidence.recordRun(
      "1",
      projectId,
      runInput("baseline", "METRIC acc=0.91\nMETRIC loss=0.12"),
    );
    const withoutMetrics = await harness.evidence.recordRun("1", projectId, runInput("no-metrics"));

    const result = await harness.analysis.generateResultsTable("1", projectId);
    expect(result.markdown).toContain("| 实验 | 状态 | exit | 语言 | 耗时 | 指标 | 证据 |");
    expect(result.markdown).toContain("acc=0.91, loss=0.12");
    expect(result.markdown).toContain("[[run:" + withMetrics.id + "]]");

    const metricRow = result.markdown.split("\n").find((line) => line.includes(withoutMetrics.id));
    expect(metricRow).toContain("—");
    expect(result.markdown).toContain("[[run:" + withoutMetrics.id + "]]");
  });
});

// ---------------------------------------------------------------------------
// compareRuns
// ---------------------------------------------------------------------------

interface SeededRuns {
  projectId: string;
  baseline: { id: string };
  improved: { id: string };
  ablation: { id: string };
  noMetrics: { id: string };
}

async function seedComparableRuns(harness: Harness, uid = "1"): Promise<SeededRuns> {
  const projectId = await createProject(harness.academic, uid, "对比项目");
  const baseline = await harness.evidence.recordRun(
    uid,
    projectId,
    runInput("baseline", "METRIC acc=0.91\nMETRIC loss=0.12"),
  );
  const improved = await harness.evidence.recordRun(
    uid,
    projectId,
    runInput("improved", "METRIC acc=0.93\nMETRIC loss=0.09"),
  );
  const ablation = await harness.evidence.recordRun(uid, projectId, runInput("ablation", "METRIC acc=0.95"));
  const noMetrics = await harness.evidence.recordRun(uid, projectId, runInput("no-metrics"));
  return { projectId, baseline, improved, ablation, noMetrics };
}

describe("ResearchAnalysisService.compareRuns", () => {
  it("compares the newest runs and only charts metrics shared by all of them", async () => {
    const harness = buildHarness();
    const seeded = await seedComparableRuns(harness);

    const result = await harness.analysis.compareRuns("1", seeded.projectId);
    // newest first: no-metrics (ignored), ablation, improved, baseline
    expect(result.runs).toBe(3);
    expect(result.metrics).toEqual(["acc"]);
    expect(result.chart.categories).toEqual(["ablation", "improved", "baseline"]);
    expect(result.chart.series).toEqual([{ name: "acc", values: [0.95, 0.93, 0.91] }]);
    expect(result.markdown).toContain("## 多 run 对比");
    expect(result.markdown).toContain("| 实验 | acc |");
    expect(result.markdown).toContain("| baseline | 0.91 |");
    expect(result.markdown).toContain("已忽略：1 个运行没有指标");
  });

  it("honors explicit runIds and their order", async () => {
    const harness = buildHarness();
    const seeded = await seedComparableRuns(harness);

    const result = await harness.analysis.compareRuns("1", seeded.projectId, [
      seeded.baseline.id,
      seeded.improved.id,
    ]);
    expect(result.runs).toBe(2);
    expect(result.metrics).toEqual(["acc", "loss"]);
    expect(result.chart.categories).toEqual(["baseline", "improved"]);
    expect(result.chart.series).toEqual([
      { name: "acc", values: [0.91, 0.93] },
      { name: "loss", values: [0.12, 0.09] },
    ]);
  });

  it("keeps chart categories unique when run names repeat", async () => {
    const harness = buildHarness();
    const projectId = await createProject(harness.academic, "1", "同名项目");
    const first = await harness.evidence.recordRun("1", projectId, runInput("same", "METRIC acc=0.8"));
    const second = await harness.evidence.recordRun("1", projectId, runInput("same", "METRIC acc=0.9"));

    const result = await harness.analysis.compareRuns("1", projectId, [first.id, second.id]);
    expect(result.chart.categories).toEqual(["same", "same #2"]);
  });

  it("guides when the project has no runs or no recorded metrics", async () => {
    const harness = buildHarness();
    const emptyProject = await createProject(harness.academic, "1", "空项目");
    await expect(harness.analysis.compareRuns("1", emptyProject)).rejects.toThrow(/还没有实验记录/);

    const projectId = await createProject(harness.academic, "1", "无指标项目");
    await harness.evidence.recordRun("1", projectId, runInput("plain", "nothing to parse"));
    await expect(harness.analysis.compareRuns("1", projectId)).rejects.toThrow(/METRIC/);
  });

  it("guides when the selected runs have no metric in common", async () => {
    const harness = buildHarness();
    const projectId = await createProject(harness.academic, "1", "指标不一致");
    await harness.evidence.recordRun("1", projectId, runInput("accuracy-run", "METRIC acc=0.9"));
    await harness.evidence.recordRun("1", projectId, runInput("loss-run", "METRIC loss=0.1"));
    await expect(harness.analysis.compareRuns("1", projectId)).rejects.toThrow(/共同的指标/);
  });

  it("rejects foreign projects and unresolvable runIds", async () => {
    const harness = buildHarness();
    const seeded = await seedComparableRuns(harness);

    await expect(harness.analysis.compareRuns("999", seeded.projectId)).rejects.toThrow(
      /项目不存在或无权访问/,
    );
    await expect(
      harness.analysis.compareRuns("1", seeded.projectId, ["missing-run"]),
    ).rejects.toThrow(/指定的运行不存在或无权访问/);
  });
});

// ---------------------------------------------------------------------------
// REST surface: POST /academic/projects/:projectId/analysis/results
// ---------------------------------------------------------------------------

describe("analysis results route", () => {
  it("defaults to summary mode and keeps the old response shape", async () => {
    const harness = buildHarness();
    const seeded = await seedComparableRuns(harness);
    const res = await harness.app.inject({
      method: "POST",
      url: "/academic/projects/" + seeded.projectId + "/analysis/results",
      headers: asUid("1"),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.markdown).toContain("| 指标 |");
    expect(body.chart).toBeUndefined();
    await harness.app.close();
  });

  it("returns markdown and chart data for mode=compare", async () => {
    const harness = buildHarness();
    const seeded = await seedComparableRuns(harness);
    const res = await harness.app.inject({
      method: "POST",
      url: "/academic/projects/" + seeded.projectId + "/analysis/results",
      headers: asUid("1"),
      payload: { mode: "compare" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.markdown).toContain("多 run 对比");
    expect(body.chart.categories).toEqual(["ablation", "improved", "baseline"]);
    expect(body.chart.series).toEqual([{ name: "acc", values: [0.95, 0.93, 0.91] }]);
    await harness.app.close();
  });

  it("accepts explicit runIds in compare mode", async () => {
    const harness = buildHarness();
    const seeded = await seedComparableRuns(harness);
    const res = await harness.app.inject({
      method: "POST",
      url: "/academic/projects/" + seeded.projectId + "/analysis/results",
      headers: asUid("1"),
      payload: { mode: "compare", runIds: [seeded.baseline.id, seeded.improved.id] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().chart.categories).toEqual(["baseline", "improved"]);
    await harness.app.close();
  });

  it("rejects an invalid mode or malformed runIds with 422", async () => {
    const harness = buildHarness();
    const seeded = await seedComparableRuns(harness);

    const badMode = await harness.app.inject({
      method: "POST",
      url: "/academic/projects/" + seeded.projectId + "/analysis/results",
      headers: asUid("1"),
      payload: { mode: "chart" },
    });
    expect(badMode.statusCode).toBe(422);
    expect(badMode.json().detail).toContain("mode");

    const badRunIds = await harness.app.inject({
      method: "POST",
      url: "/academic/projects/" + seeded.projectId + "/analysis/results",
      headers: asUid("1"),
      payload: { mode: "compare", runIds: [1, 2] },
    });
    expect(badRunIds.statusCode).toBe(422);
    expect(badRunIds.json().detail).toContain("runIds");
    await harness.app.close();
  });

  it("hides foreign projects (404) and guides when there is nothing to compare", async () => {
    const harness = buildHarness();
    const seeded = await seedComparableRuns(harness);

    const foreign = await harness.app.inject({
      method: "POST",
      url: "/academic/projects/" + seeded.projectId + "/analysis/results",
      headers: asUid("999"),
      payload: { mode: "compare" },
    });
    expect(foreign.statusCode).toBe(404);

    const emptyProject = await createProject(harness.academic, "1", "无指标");
    await harness.evidence.recordRun("1", emptyProject, runInput("plain", "no metrics"));
    const guided = await harness.app.inject({
      method: "POST",
      url: "/academic/projects/" + emptyProject + "/analysis/results",
      headers: asUid("1"),
      payload: { mode: "compare" },
    });
    expect(guided.statusCode).toBe(404);
    expect(guided.json().detail).toContain("METRIC");
    await harness.app.close();
  });
});
