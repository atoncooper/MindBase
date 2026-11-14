import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { runWithRequestContext } from "../src/context/request-context.js";
import { registerResearchRoutes } from "../src/transport/http/routes/research.js";
import { registerPlanRoutes } from "../src/transport/http/routes/plans.js";
import { MemoryAcademicStore } from "../src/repository/memory/academic.js";
import { MemoryAcademicEvidenceStore } from "../src/repository/memory/academic-evidence.js";
import { MemoryResearchExperimentRepository } from "../src/repository/memory/research-experiments.js";
import { MemoryResearchWorkspaceRepository } from "../src/repository/memory/research-workspaces.js";
import { MemoryPlanRunRepository } from "../src/repository/memory/plan-runs.js";
import { PlanRunEngine } from "../src/agent/dag/state.js";
import { AcademicService } from "../src/services/academic.js";
import { ResearchExperimentRunner } from "../src/services/research-experiment.js";
import { ResearchValidationService } from "../src/services/research-validation.js";
import { ResearchAnalysisService } from "../src/services/research-analysis.js";
import { ResearchWorkspaceService } from "../src/services/research-workspace.js";
import type { PlanRunRecord } from "../src/repository/plan-runs.js";
import type { LiteratureClient, LiteratureHit, LiteratureSearchOptions } from "../src/clients/literature-client.js";
import type { CodeExecutionPort } from "../src/tools/code/code-execution.js";

/**
 * Route-level tests for the research-workbench REST extension
 * (docs/research-ui-api.md §1–§5) and the uid-scoped plan history (§6).
 *
 * Everything runs offline over memory repositories: uid comes from the
 * gateway request context (X-Uid header in the test hook), services own the
 * ownership checks, and the route layer only projects payloads + maps errors.
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

/** In-memory stand-in for the app-cloud M2M client (folder tree + file listing). */
class FakeCloud {
  configured = true;
  private nextId = 1;
  files: Array<{ upload_uuid: string; name: string; size: number; mime_type: string; sha256?: string; createdAt?: number }> = [];

  async createFolder(_uid: string, name: string, _parentId?: number) {
    return { id: this.nextId++, name };
  }

  async uploadFile(_uid: string, _folderId: number, name: string, data: Uint8Array, _mimeType?: string) {
    return { upload_uuid: "upload-" + this.nextId++, name, size: data.byteLength };
  }

  async listFiles(_uid: string, _folderId?: number) {
    return this.files.map((file) => ({ ...file }));
  }
}

function buildApp() {
  const store = new MemoryAcademicStore();
  const evidence = new MemoryAcademicEvidenceStore();
  const experimentRepo = new MemoryResearchExperimentRepository();
  const workspaceRepo = new MemoryResearchWorkspaceRepository();
  const cloud = new FakeCloud();
  const academic = new AcademicService({
    projects: store,
    literature: store,
    documents: store,
    events: store,
    client: new FakeLiteratureClient(),
  });
  const experiments = new ResearchExperimentRunner(experimentRepo, noopPort, 1);
  const validation = new ResearchValidationService(store, store, store, evidence);
  const workspace = new ResearchWorkspaceService(workspaceRepo, cloud as never);
  const analysis = new ResearchAnalysisService(store, evidence, store, workspace);

  const app = Fastify();
  app.addHook("onRequest", (req, _reply, done) => {
    const raw = req.headers["x-uid"];
    runWithRequestContext(
      { requestId: "test", uid: typeof raw === "string" ? raw : undefined, startedAt: Date.now() },
      done,
    );
  });
  registerResearchRoutes(app, { academic, experiments, evidence, validation, analysis, workspace });
  return { app, store, evidence, experimentRepo, cloud, academic };
}

const asUid = (uid: string) => ({ "x-uid": uid, "content-type": "application/json" });
/** POST routes without a request body must not claim JSON content. */
const uidOnly = (uid: string) => ({ "x-uid": uid });

async function createProject(academic: AcademicService, uid: string, title: string): Promise<string> {
  const detail = await academic.createProject(uid, { title });
  return detail.project.id;
}

async function seedExperiment(
  repo: MemoryResearchExperimentRepository,
  overrides: Partial<Parameters<MemoryResearchExperimentRepository["create"]>[0]> = {},
) {
  const exp = {
    id: "exp-1",
    uid: "1",
    projectId: "p1",
    language: "python",
    code: "print(1)",
    timeoutMs: 5000,
    status: "succeeded" as const,
    exitCode: 0,
    stdoutPreview: "acc=0.91",
    createdAt: 100,
    startedAt: 110,
    endedAt: 120,
    ...overrides,
  };
  await repo.create(exp);
  return exp;
}

describe("research routes", () => {
  it("requires the gateway uid", async () => {
    const { app } = buildApp();
    const res = await app.inject({ method: "GET", url: "/academic/projects/p1/experiments" });
    expect(res.statusCode).toBe(401);
    expect(res.json().detail).toContain("X-Uid");
    await app.close();
  });

  it("lists experiments newest-first and hides uid", async () => {
    const { app, academic, experimentRepo } = buildApp();
    const projectId = await createProject(academic, "1", "实验项目");
    await seedExperiment(experimentRepo, { id: "exp-old", projectId, createdAt: 100 });
    await seedExperiment(experimentRepo, { id: "exp-new", projectId, createdAt: 200, status: "running" });

    const res = await app.inject({
      method: "GET",
      url: "/academic/projects/" + projectId + "/experiments?limit=10",
      headers: asUid("1"),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.experiments.map((e: { id: string }) => e.id)).toEqual(["exp-new", "exp-old"]);
    expect(body.experiments[0].uid).toBeUndefined();
    expect(body.experiments[0].status).toBe("running");

    // The project gate is ownership-scoped: another uid sees 404, not the list.
    const foreign = await app.inject({
      method: "GET",
      url: "/academic/projects/" + projectId + "/experiments",
      headers: asUid("999"),
    });
    expect(foreign.statusCode).toBe(404);
    await app.close();
  });

  it("cancels an experiment for its owner and no-ops on terminal rows", async () => {
    const { app, academic, experimentRepo } = buildApp();
    const projectId = await createProject(academic, "1", "取消项目");
    await seedExperiment(experimentRepo, { id: "exp-done", projectId, status: "succeeded" });

    const terminal = await app.inject({
      method: "POST",
      url: "/academic/experiments/exp-done/cancel",
      headers: uidOnly("1"),
    });
    expect(terminal.statusCode).toBe(200);
    expect(terminal.json()).toEqual({ cancelled: false });

    const foreign = await app.inject({
      method: "POST",
      url: "/academic/experiments/exp-done/cancel",
      headers: uidOnly("999"),
    });
    expect(foreign.statusCode).toBe(404);

    const missing = await app.inject({
      method: "POST",
      url: "/academic/experiments/nope/cancel",
      headers: uidOnly("1"),
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it("lists datasets and runs with limit/offset and serves one run detail", async () => {
    const { app, academic, evidence } = buildApp();
    const projectId = await createProject(academic, "1", "证据项目");
    await evidence.addDataset("1", projectId, {
      name: "raw.csv",
      source: "upload",
      files: [{ name: "raw.csv", sizeBytes: 128 }],
    });
    const first = await evidence.recordRun("1", projectId, {
      name: "run-old",
      language: "python",
      status: "succeeded",
      script: "print('old')",
    });
    const second = await evidence.recordRun("1", projectId, {
      name: "run-new",
      language: "python",
      status: "failed",
      artifacts: [{ name: "out.txt", sizeBytes: 3 }],
    });

    const list = await app.inject({
      method: "GET",
      url: "/academic/projects/" + projectId + "/evidence?limit=1&offset=0",
      headers: asUid("1"),
    });
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.datasets).toHaveLength(1);
    expect(body.datasets[0].uid).toBeUndefined();
    expect(body.datasets[0].files[0].name).toBe("raw.csv");
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0].id).toBe(second.id);

    const page2 = await app.inject({
      method: "GET",
      url: "/academic/projects/" + projectId + "/evidence?limit=1&offset=1",
      headers: asUid("1"),
    });
    expect(page2.json().runs[0].id).toBe(first.id);

    const detail = await app.inject({
      method: "GET",
      url: "/academic/projects/" + projectId + "/evidence/runs/" + second.id,
      headers: asUid("1"),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().run.artifacts).toHaveLength(1);
    expect(detail.json().run.uid).toBeUndefined();

    const missing = await app.inject({
      method: "GET",
      url: "/academic/projects/" + projectId + "/evidence/runs/nope",
      headers: asUid("1"),
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it("validates a manuscript and rejects a non-string documentId", async () => {
    const { app, academic } = buildApp();
    const projectId = await createProject(academic, "1", "校验项目");

    const res = await app.inject({
      method: "POST",
      url: "/academic/projects/" + projectId + "/validation",
      headers: asUid("1"),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const report = res.json().report;
    expect(report.pass).toBe(true);
    expect(report.citations).toEqual({ total: 0, missing: [], unverified: [] });
    expect(report.runs).toEqual({ total: 0, unreproducible: [] });

    const invalid = await app.inject({
      method: "POST",
      url: "/academic/projects/" + projectId + "/validation",
      headers: asUid("1"),
      payload: { documentId: 42 },
    });
    expect(invalid.statusCode).toBe(422);
    await app.close();
  });

  it("generates the results table from the evidence ledger", async () => {
    const { app, academic, evidence } = buildApp();
    const projectId = await createProject(academic, "1", "分析项目");
    const run = await evidence.recordRun("1", projectId, {
      name: "baseline",
      language: "python",
      status: "succeeded",
      exitCode: 0,
    });

    const res = await app.inject({
      method: "POST",
      url: "/academic/projects/" + projectId + "/analysis/results",
      headers: asUid("1"),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.markdown).toContain("| 实验 |");
    expect(body.markdown).toContain("[[run:" + run.id + "]]");
    expect(body.uploadUuid).toBeUndefined();

    // No evidence yet → precondition error carries a detail (404 resource state).
    const otherProject = await createProject(academic, "1", "空项目");
    const empty = await app.inject({
      method: "POST",
      url: "/academic/projects/" + otherProject + "/analysis/results",
      headers: asUid("1"),
      payload: {},
    });
    expect(empty.statusCode).toBe(404);
    expect(empty.json().detail).toContain("实验记录");
    await app.close();
  });

  it("ensures, reads and lists the academic-workspace tree", async () => {
    const { app, academic, cloud } = buildApp();
    const projectId = await createProject(academic, "1", "空间项目");

    const before = await app.inject({
      method: "GET",
      url: "/academic/projects/" + projectId + "/workspace",
      headers: uidOnly("1"),
    });
    expect(before.statusCode).toBe(404);
    expect(before.json().detail).toBe("项目还没有学术空间目录");

    const ensured = await app.inject({
      method: "POST",
      url: "/academic/projects/" + projectId + "/workspace",
      headers: uidOnly("1"),
    });
    expect(ensured.statusCode).toBe(200);
    const workspace = ensured.json().workspace;
    expect(workspace.project.title).toBe("空间项目");
    expect(workspace.project.folders.data).toBeGreaterThan(0);
    expect(Object.keys(workspace.project.folders)).toHaveLength(7);

    // Idempotent: a second ensure reuses the same project workspace.
    const again = await app.inject({
      method: "POST",
      url: "/academic/projects/" + projectId + "/workspace",
      headers: uidOnly("1"),
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().workspace.workspaceId).toBe(workspace.workspaceId);

    cloud.files = [{ upload_uuid: "u1", name: "data.csv", size: 3, mime_type: "text/csv" }];
    const files = await app.inject({
      method: "GET",
      url: "/academic/projects/" + projectId + "/workspace/files?kind=data&limit=50",
      headers: asUid("1"),
    });
    expect(files.statusCode).toBe(200);
    expect(files.json().kind).toBe("data");
    expect(files.json().folderId).toBe(workspace.project.folders.data);
    expect(files.json().files).toEqual([{ upload_uuid: "u1", name: "data.csv", size: 3, mime_type: "text/csv" }]);

    const badKind = await app.inject({
      method: "GET",
      url: "/academic/projects/" + projectId + "/workspace/files?kind=bogus",
      headers: asUid("1"),
    });
    expect(badKind.statusCode).toBe(422);

    // Ownership: a foreign uid can neither ensure nor read the workspace.
    const foreign = await app.inject({
      method: "POST",
      url: "/academic/projects/" + projectId + "/workspace",
      headers: uidOnly("999"),
    });
    expect(foreign.statusCode).toBe(404);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// GET /chat/plans — uid-scoped plan history (contract §6)
// ---------------------------------------------------------------------------

function planRecord(
  runId: string,
  uid: string,
  chatSessionId: string,
  updatedAt: number,
  statuses: Array<"pending" | "in_progress" | "done" | "failed" | "skipped">,
  projectId?: string,
): PlanRunRecord {
  return {
    runId,
    chatSessionId,
    uid,
    ...(projectId ? { projectId } : {}),
    goal: "goal-" + runId,
    status: "running",
    version: 1,
    graph: { version: 1, goal: "goal-" + runId, agents: [], nodes: [] },
    nodes: statuses.map((status, index) => ({
      id: "n" + index,
      title: "node " + index,
      agent: "main",
      deps: [],
      task: "task",
      acceptance: "ok",
      status,
      attempts: 0,
    })),
    createdAt: updatedAt - 10,
    updatedAt,
  };
}

function buildPlanApp() {
  const repo = new MemoryPlanRunRepository();
  const engine = new PlanRunEngine(repo);
  const app = Fastify();
  app.addHook("onRequest", (req, _reply, done) => {
    const raw = req.headers["x-uid"];
    runWithRequestContext(
      { requestId: "test", uid: typeof raw === "string" ? raw : undefined, startedAt: Date.now() },
      done,
    );
  });
  registerPlanRoutes(app, { engine, runner: {} as never });
  return { app, repo };
}

describe("plan history routes", () => {
  it("requires the gateway uid", async () => {
    const { app } = buildPlanApp();
    const res = await app.inject({ method: "GET", url: "/chat/plans" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("lists the caller's runs newest-first with node counts", async () => {
    const { app, repo } = buildPlanApp();
    await repo.create(planRecord("run-old", "1", "s1", 100, ["done", "failed", "in_progress", "pending", "skipped"]));
    await repo.create(planRecord("run-new", "1", "s2", 200, ["done", "done"]));
    await repo.create(planRecord("run-foreign", "999", "s3", 300, ["done"]));

    const res = await app.inject({ method: "GET", url: "/chat/plans?limit=10", headers: asUid("1") });
    expect(res.statusCode).toBe(200);
    const runs = res.json().runs;
    expect(runs.map((run: { runId: string }) => run.runId)).toEqual(["run-new", "run-old"]);
    expect(runs[1].chatSessionId).toBe("s1");
    expect(runs[1].nodeCounts).toEqual({ total: 5, done: 1, failed: 1, skipped: 1, running: 1, pending: 1 });

    const filtered = await app.inject({
      method: "GET",
      url: "/chat/plans?chat_session_id=s2",
      headers: asUid("1"),
    });
    expect(filtered.json().runs.map((run: { runId: string }) => run.runId)).toEqual(["run-new"]);

    const capped = await app.inject({ method: "GET", url: "/chat/plans?limit=1", headers: asUid("1") });
    expect(capped.json().runs).toHaveLength(1);
    expect(capped.json().runs[0].runId).toBe("run-new");
    await app.close();
  });

  it("filters by project_id and echoes it (research workbench scoping)", async () => {
    const { app, repo } = buildPlanApp();
    await repo.create(planRecord("run-p1", "1", "s1", 100, ["done"], "proj-1"));
    await repo.create(planRecord("run-p2", "1", "s2", 200, ["done"], "proj-2"));
    await repo.create(planRecord("run-plain", "1", "s3", 300, ["done"]));

    const scoped = await app.inject({ method: "GET", url: "/chat/plans?project_id=proj-1", headers: asUid("1") });
    expect(scoped.statusCode).toBe(200);
    expect(scoped.json().runs.map((run: { runId: string }) => run.runId)).toEqual(["run-p1"]);
    expect(scoped.json().runs[0].projectId).toBe("proj-1");

    // no filter → every run of the caller (project-tagged and legacy plain chats)
    const all = await app.inject({ method: "GET", url: "/chat/plans", headers: asUid("1") });
    expect(all.json().runs.map((run: { runId: string }) => run.runId)).toEqual(["run-plain", "run-p2", "run-p1"]);

    // malformed project id is ignored (unfiltered), never a 400 or cross-filter
    const invalid = await app.inject({ method: "GET", url: "/chat/plans?project_id=///", headers: asUid("1") });
    expect(invalid.statusCode).toBe(200);
    expect(invalid.json().runs).toHaveLength(3);
    await app.close();
  });
});