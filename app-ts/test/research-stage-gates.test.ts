import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { runWithRequestContext } from "../src/context/request-context.js";
import { MemoryAcademicStore } from "../src/repository/memory/academic.js";
import { MemoryAcademicEvidenceStore } from "../src/repository/memory/academic-evidence.js";
import { AcademicService } from "../src/services/research/academic.js";
import {
  ResearchStageGateService,
  ResearchStageGateError,
  suggestNext,
  type StageGateEntry,
} from "../src/services/research/research-stage-gates.js";
import type { ResearchValidationReport } from "../src/services/research/research-validation.js";
import { registerAcademicRoutes } from "../src/transport/http/routes/academic.js";
import {
  ACADEMIC_STAGES,
  type AcademicPlanTask,
  type AcademicStage,
} from "../src/repository/academic.js";
import type { LiteratureClient, LiteratureHit, LiteratureSearchOptions } from "../src/clients/literature-client.js";

/**
 * Stage gates + plan auto-completion .
 *
 * Offline: memory academic/evidence stores and a fake validation report. The
 * cases pin the product rules — per-stage deliverables, autoRule ticks with
 * doneSource="event", user ticks winning, and autoMode="auto" advancing only
 * to submitted (approved is never written by any path).
 */

const UID = "u1";

function validationReport(pass: boolean, missing: string[] = []): ResearchValidationReport {
  return {
    pass,
    citations: { total: missing.length, missing, unverified: [] },
    runs: { total: 0, unreproducible: [], invalidRefs: [] },
    results: { sections: [], withoutEvidenceRef: [] },
    sectionsWithNumbers: [],
    sectionsMissingRunRef: [],
  };
}

class FakeLiteratureClient implements LiteratureClient {
  async search(_q: string, options?: LiteratureSearchOptions): Promise<LiteratureHit[]> {
    return options ? [] : [];
  }
  async lookupDoi(_doi: string): Promise<LiteratureHit | null> {
    return null;
  }
}

function setup(options: { evidence?: boolean; validation?: boolean } = {}) {
  const store = new MemoryAcademicStore();
  const evidence = new MemoryAcademicEvidenceStore();
  let validationPass = false;
  const validation = {
    validate: async () => validationReport(validationPass),
  };
  const gates = new ResearchStageGateService({
    projects: store,
    documents: store,
    literature: store,
    events: store,
    ...(options.evidence ? { evidence } : {}),
    ...(options.validation ? { validation } : {}),
  });
  return {
    store,
    evidence,
    gates,
    setValidationPass: (pass: boolean) => {
      validationPass = pass;
    },
  };
}

type Setup = ReturnType<typeof setup>;

async function createProject(ctx: Setup, autoMode?: "off" | "assist" | "auto"): Promise<string> {
  const project = await ctx.store.create(UID, { title: "阶段门禁测试项目", ...(autoMode ? { autoMode } : {}) });
  return project.id;
}

function task(id: string, title: string, extra: Partial<AcademicPlanTask> = {}): AcademicPlanTask {
  return { id, title, done: false, ...extra };
}

/** Persist one stage plan as the given task array (or complete it when done=true). */
async function setPlan(ctx: Setup, projectId: string, stage: AcademicStage, tasks: AcademicPlanTask[]): Promise<void> {
  await ctx.store.update(UID, projectId, { plans: { [stage]: tasks } });
}

/** Completed plan for one stage: every task done=true (no autoRule needed). */
async function completePlan(ctx: Setup, projectId: string, stage: AcademicStage, count = 2): Promise<void> {
  const tasks = Array.from({ length: count }, (_, index) => ({
    id: "done-" + (index + 1),
    title: stage + " 任务 " + (index + 1),
    done: true,
  }));
  await setPlan(ctx, projectId, stage, tasks);
}

function entryOf(report: StageGateEntry[], stage: AcademicStage): StageGateEntry {
  const entry = report.find((item) => item.stage === stage);
  if (!entry) throw new Error("missing stage entry: " + stage);
  return entry;
}

let literatureSeq = 0;

async function addLiterature(ctx: Setup, projectId: string, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    literatureSeq += 1;
    await ctx.store.add(UID, projectId, {
      title: "Paper " + literatureSeq,
      doi: "10.1000/p" + literatureSeq,
    });
  }
}

/** Create a draft/revision document with the given filled section keys. */
async function addDraft(ctx: Setup, projectId: string, keys: string[], kind: "draft" | "revision" = "draft"): Promise<void> {
  const document = await ctx.store.createDocument(UID, projectId, { kind, title: "稿件" });
  for (const key of keys) {
    await ctx.store.upsertSection(UID, document.id, { key, title: key, content: key + " 正文" });
  }
}
describe("research stage gates: evaluate", () => {
 it("topic requires a completed topic plan (empty plan = not ready with plan_set guidance)", async () => {
    const ctx = setup();
    const projectId = await createProject(ctx);
    const evaluation = await ctx.gates.evaluate(UID, projectId);
    expect(evaluation.stage).toBe("topic");
    expect(evaluation.report.map((entry) => entry.stage)).toEqual([...ACADEMIC_STAGES]);
    const topic = entryOf(evaluation.report, "topic");
    expect(topic.ready).toBe(false);
    expect(topic.missing).toEqual(["先 plan_set 生成选题计划"]);
    expect(topic.doneCount).toBe(0);
    expect(topic.taskCount).toBe(0);

    await completePlan(ctx, projectId, "topic", 2);
    const after = await ctx.gates.evaluate(UID, projectId);
    const topicAfter = entryOf(after.report, "topic");
    expect(topicAfter.ready).toBe(true);
    expect(topicAfter.doneCount).toBe(2);
    expect(topicAfter.taskCount).toBe(2);
    expect(topicAfter.missing).toEqual([]);
  });

 it("design requires a completed design plan and at least 3 literature entries", async () => {
    const ctx = setup();
    const projectId = await createProject(ctx);
    await completePlan(ctx, projectId, "design");
    let design = entryOf((await ctx.gates.evaluate(UID, projectId)).report, "design");
    expect(design.ready).toBe(false);
    expect(design.missing.join("\n")).toContain("至少需要 3 篇文献（当前 0 篇）");

    await addLiterature(ctx, projectId, 2);
    design = entryOf((await ctx.gates.evaluate(UID, projectId)).report, "design");
    expect(design.ready).toBe(false);
    expect(design.missing.join("\n")).toContain("当前 2 篇");

    await addLiterature(ctx, projectId, 1);
    design = entryOf((await ctx.gates.evaluate(UID, projectId)).report, "design");
    expect(design.ready).toBe(true);

    // An absent plan is a gap too, even with enough literature.
    const empty = setup();
    const emptyId = await createProject(empty);
    await addLiterature(empty, emptyId, 3);
    const emptyDesign = entryOf((await empty.gates.evaluate(UID, emptyId)).report, "design");
    expect(emptyDesign.ready).toBe(false);
    expect(emptyDesign.missing.join("\n")).toContain("plan_set");
  });

 it("advise requires saved advice and a completed advise plan", async () => {
    const ctx = setup();
    const projectId = await createProject(ctx);
    await completePlan(ctx, projectId, "advise");
    let advise = entryOf((await ctx.gates.evaluate(UID, projectId)).report, "advise");
    expect(advise.ready).toBe(false);
    expect(advise.missing.join("\n")).toContain("save_advice");

    await ctx.store.update(UID, projectId, { advice: { advise: "建议先把方法部分写成可复现的步骤。" } });
    advise = entryOf((await ctx.gates.evaluate(UID, projectId)).report, "advise");
    expect(advise.ready).toBe(true);
  });

 it("experiment accepts a succeeded run when evidence is injected, otherwise falls back to the plan", async () => {
    const ctx = setup({ evidence: true });
    const projectId = await createProject(ctx);
    let experiment = entryOf((await ctx.gates.evaluate(UID, projectId)).report, "experiment");
    expect(experiment.ready).toBe(false);
    expect(experiment.missing.join("\n")).toContain("succeeded");

    // A failed run is recorded evidence but never satisfies the gate.
    await ctx.evidence.recordRun(UID, projectId, { name: "r1", language: "python", status: "failed" });
    experiment = entryOf((await ctx.gates.evaluate(UID, projectId)).report, "experiment");
    expect(experiment.ready).toBe(false);

    await ctx.evidence.recordRun(UID, projectId, { name: "r2", language: "python", status: "succeeded" });
    experiment = entryOf((await ctx.gates.evaluate(UID, projectId)).report, "experiment");
    expect(experiment.ready).toBe(true);

    // Without the evidence collaborator the gate degrades to "plan tasks done".
    const fallback = setup();
    const fallbackId = await createProject(fallback);
    let fallbackExperiment = entryOf((await fallback.gates.evaluate(UID, fallbackId)).report, "experiment");
    expect(fallbackExperiment.ready).toBe(false);
    await completePlan(fallback, fallbackId, "experiment");
    fallbackExperiment = entryOf((await fallback.gates.evaluate(UID, fallbackId)).report, "experiment");
    expect(fallbackExperiment.ready).toBe(true);
  });

 it("writing requires a draft/revision with 3 non-empty sections (proposal docs do not count)", async () => {
    const ctx = setup();
    const projectId = await createProject(ctx);
    const proposal = await ctx.store.createDocument(UID, projectId, { kind: "proposal", title: "开题报告" });
    for (const key of ["a", "b", "c", "d"]) {
      await ctx.store.upsertSection(UID, proposal.id, { key, title: key, content: "内容" });
    }
    let writing = entryOf((await ctx.gates.evaluate(UID, projectId)).report, "writing");
    expect(writing.ready).toBe(false);
    expect(writing.missing.join("\n")).toContain("初稿或修改稿");

    await addDraft(ctx, projectId, ["introduction", "method"]);
    writing = entryOf((await ctx.gates.evaluate(UID, projectId)).report, "writing");
    expect(writing.ready).toBe(false);
    expect(writing.missing.join("\n")).toContain("当前 2 个");

    await addDraft(ctx, projectId, ["introduction", "method", "results"], "revision");
    writing = entryOf((await ctx.gates.evaluate(UID, projectId)).report, "writing");
    expect(writing.ready).toBe(true);
  });

 it("submission uses the injected validation report, otherwise the submission plan", async () => {
    const ctx = setup({ validation: true });
    const projectId = await createProject(ctx);
    let submission = entryOf((await ctx.gates.evaluate(UID, projectId)).report, "submission");
    expect(submission.ready).toBe(false);
    expect(submission.missing.join("\n")).toContain("学术校验未通过");

    // Pass=true is enough even without any submission plan: the integrity report
    // is the authoritative submission gate when the validator is assembled.
    ctx.setValidationPass(true);
    submission = entryOf((await ctx.gates.evaluate(UID, projectId)).report, "submission");
    expect(submission.ready).toBe(true);

    const fallback = setup();
    const fallbackId = await createProject(fallback);
    expect(entryOf((await fallback.gates.evaluate(UID, fallbackId)).report, "submission").ready).toBe(false);
    await completePlan(fallback, fallbackId, "submission");
    expect(entryOf((await fallback.gates.evaluate(UID, fallbackId)).report, "submission").ready).toBe(true);
  });

 it("treats missing and foreign projects as not found", async () => {
    const ctx = setup();
    const projectId = await createProject(ctx);
    await expect(ctx.gates.evaluate("u2", projectId)).rejects.toBeInstanceOf(ResearchStageGateError);
    await expect(ctx.gates.evaluate(UID, "missing")).rejects.toMatchObject({ status: 404 });
    await expect(ctx.gates.syncPlanTasks("u2", projectId)).rejects.toMatchObject({ status: 404 });
  });
});
describe("research stage gates: plan auto-completion", () => {
 it("ticks a manuscript.section_saved task once the targeted section has body text", async () => {
    const ctx = setup();
    const projectId = await createProject(ctx);
    await setPlan(ctx, projectId, "topic", [
      task("t1", "写引言", {
        autoRule: { event: "manuscript.section_saved", match: { sectionKey: "introduction" } },
      }),
    ]);
    expect(await ctx.gates.syncPlanTasks(UID, projectId)).toEqual([]);

    // A non-empty section with a different key must not satisfy the rule.
    await addDraft(ctx, projectId, ["method"]);
    expect(await ctx.gates.syncPlanTasks(UID, projectId)).toEqual([]);

    await addDraft(ctx, projectId, ["introduction"]);
    const changes = await ctx.gates.syncPlanTasks(UID, projectId);
    expect(changes).toEqual([{ stage: "topic", id: "t1", title: "写引言" }]);
    const project = await ctx.store.get(UID, projectId);
    expect(project?.plans.topic?.[0].done).toBe(true);
    expect(project?.plans.topic?.[0].doneSource).toBe("event");
    const events = await ctx.store.listEvents(UID, projectId, 10);
    expect(events.some((event) => event.type === "plan.auto_completed")).toBe(true);
    expect(events.find((event) => event.type === "plan.auto_completed")?.payload.stage).toBe("topic");

    // Idempotent: nothing left to tick on the second pass.
    expect(await ctx.gates.syncPlanTasks(UID, projectId)).toEqual([]);
  });

 it("never rewrites a task the user already completed", async () => {
    const ctx = setup();
    const projectId = await createProject(ctx);
    await setPlan(ctx, projectId, "topic", [
      task("t1", "用户已勾选", {
        done: true,
        doneSource: "user",
        autoRule: { event: "manuscript.section_saved" },
      }),
    ]);
    await addDraft(ctx, projectId, ["introduction"]);
    expect(await ctx.gates.syncPlanTasks(UID, projectId)).toEqual([]);
    const project = await ctx.store.get(UID, projectId);
    expect(project?.plans.topic?.[0].done).toBe(true);
    expect(project?.plans.topic?.[0].doneSource).toBe("user");
  });

 it("evaluates run_recorded (minRuns), literature.verified and validation.passed rules", async () => {
    const ctx = setup({ evidence: true, validation: true });
    const projectId = await createProject(ctx);
    await setPlan(ctx, projectId, "experiment", [
      task("run-rule", "跑通两次实验", {
        autoRule: { event: "academic.run_recorded", match: { minRuns: 2 } },
      }),
    ]);
    await setPlan(ctx, projectId, "design", [
      task("lit-rule", "核验至少一篇文献", { autoRule: { event: "literature.verified" } }),
    ]);
    await setPlan(ctx, projectId, "submission", [
      task("val-rule", "通过学术校验", { autoRule: { event: "validation.passed" } }),
    ]);

    // One run, one unverified paper, failing validation: nothing ticks yet.
    await ctx.evidence.recordRun(UID, projectId, { name: "r1", language: "python", status: "succeeded" });
    const added = await ctx.store.add(UID, projectId, { title: "Paper A", doi: "10.1000/a" });
    expect(await ctx.gates.syncPlanTasks(UID, projectId)).toEqual([]);

    await ctx.store.setVerified(UID, projectId, added.entry.citeKey, true);
    expect((await ctx.gates.syncPlanTasks(UID, projectId)).map((change) => change.id)).toEqual(["lit-rule"]);

    ctx.setValidationPass(true);
    expect((await ctx.gates.syncPlanTasks(UID, projectId)).map((change) => change.id)).toEqual(["val-rule"]);

    await ctx.evidence.recordRun(UID, projectId, { name: "r2", language: "python", status: "succeeded" });
    expect((await ctx.gates.syncPlanTasks(UID, projectId)).map((change) => change.id)).toEqual(["run-rule"]);
  });

 it("leaves run_recorded rules untouched when the evidence collaborator is absent", async () => {
    const ctx = setup();
    const projectId = await createProject(ctx);
    await setPlan(ctx, projectId, "experiment", [
      task("run-rule", "跑实验", { autoRule: { event: "academic.run_recorded" } }),
    ]);
    expect(await ctx.gates.syncPlanTasks(UID, projectId)).toEqual([]);
    const project = await ctx.store.get(UID, projectId);
    expect(project?.plans.experiment?.[0].done).toBe(false);
  });
});
describe("research stage gates: auto advance", () => {
 it("autoMode=auto advances a ready active stage to submitted and opens the next stage", async () => {
    const ctx = setup();
    const projectId = await createProject(ctx, "auto");
    await completePlan(ctx, projectId, "topic");

    const result = await ctx.gates.advanceIfAuto(UID, projectId);
    expect(result).toMatchObject({ advanced: true, from: "topic", to: "design" });
    const project = await ctx.store.get(UID, projectId);
    expect(project?.stage).toBe("design");
    expect(project?.stages.topic.status).toBe("submitted");
    expect(project?.stages.design.status).toBe("active");
    // approved is never written by automation.
    expect(Object.values(project?.stages ?? {}).every((state) => state.status !== "approved")).toBe(true);

    const events = await ctx.store.listEvents(UID, projectId, 10);
    const stageEvent = events.find((event) => event.type === "stage.updated");
    expect(stageEvent?.payload).toMatchObject({
      stage: "design",
      status: "active",
      previousStage: "topic",
      previousStatus: "active",
      direction: "advance",
      auto: true,
    });

    // Design is not ready yet: the pipeline must not skip ahead on a second pass.
    const again = await ctx.gates.advanceIfAuto(UID, projectId);
    expect(again.advanced).toBe(false);
    expect(again.reason).toContain("门禁未通过");
    expect((await ctx.store.get(UID, projectId))?.stage).toBe("design");
  });

 it("does not advance when autoMode is off or assist", async () => {
    for (const mode of ["off", "assist"] as const) {
      const ctx = setup();
      const projectId = await createProject(ctx, mode);
      await completePlan(ctx, projectId, "topic");
      const result = await ctx.gates.advanceIfAuto(UID, projectId);
      expect(result.advanced).toBe(false);
      expect(result.reason).toContain("autoMode");
      const project = await ctx.store.get(UID, projectId);
      expect(project?.stage).toBe("topic");
      expect(project?.stages.topic.status).toBe("active");
    }
  });

 it("never advances a stage the user already approved", async () => {
    const ctx = setup();
    const projectId = await createProject(ctx, "auto");
    await completePlan(ctx, projectId, "topic");
    await ctx.store.update(UID, projectId, {
      stages: { topic: { status: "approved", updatedAt: Date.now() } },
    });
    const result = await ctx.gates.advanceIfAuto(UID, projectId);
    expect(result.advanced).toBe(false);
    expect(result.reason).toContain("approved");
    const project = await ctx.store.get(UID, projectId);
    expect(project?.stages.topic.status).toBe("approved");
    expect(project?.stage).toBe("topic");
  });

 it("apply() syncs autoRule tasks, reports the gates and advances in one pass", async () => {
    const ctx = setup();
    const projectId = await createProject(ctx, "auto");
    await setPlan(ctx, projectId, "topic", [
      task("t1", "写开题摘要", { autoRule: { event: "manuscript.section_saved" } }),
    ]);
    await addDraft(ctx, projectId, ["introduction"]);

    const result = await ctx.gates.apply(UID, projectId);
    expect(result.sync).toEqual([{ stage: "topic", id: "t1", title: "写开题摘要" }]);
    expect(entryOf(result.report, "topic").ready).toBe(true);
    expect(result.advanced).toMatchObject({ advanced: true, from: "topic", to: "design" });
    const project = await ctx.store.get(UID, projectId);
    expect(project?.stage).toBe("design");
    expect(project?.plans.topic?.[0]).toMatchObject({ done: true, doneSource: "event" });
  });

 it("suggestNext points at the next stage only when the current gate is ready", async () => {
    const ctx = setup();
    const projectId = await createProject(ctx);
    const before = await ctx.gates.evaluate(UID, projectId);
    expect(suggestNext((await ctx.store.get(UID, projectId))!, before.report)).toBeNull();
    await completePlan(ctx, projectId, "topic");
    const after = await ctx.gates.evaluate(UID, projectId);
    expect(suggestNext((await ctx.store.get(UID, projectId))!, after.report)).toBe("design");
  });
});

describe("research stage gates: HTTP routes", () => {
  function buildApp(withGates: boolean) {
    const ctx = setup();
    const service = new AcademicService({
      projects: ctx.store,
      literature: ctx.store,
      documents: ctx.store,
      events: ctx.store,
      client: new FakeLiteratureClient(),
    });
    const app = Fastify();
    app.addHook("onRequest", (req, _reply, done) => {
      const raw = req.headers["x-uid"];
      runWithRequestContext(
        { requestId: "test", uid: typeof raw === "string" ? raw : undefined, startedAt: Date.now() },
        done,
      );
    });
    registerAcademicRoutes(app, { academic: service, ...(withGates ? { gates: ctx.gates } : {}) });
    return { app, ctx };
  }

 it("serves the read-only gate report and 503 when the service is not injected", async () => {
    const withGates = buildApp(true);
    const created = await withGates.app.inject({
      method: "POST",
      url: "/academic/projects",
      headers: { "x-uid": "1", "content-type": "application/json" },
      payload: { title: "路由测试项目" },
    });
    expect(created.statusCode).toBe(200);
    const projectId = created.json().project.id as string;

    const gates = await withGates.app.inject({
      method: "GET",
      url: "/academic/projects/" + projectId + "/gates",
      headers: { "x-uid": "1" },
    });
    expect(gates.statusCode).toBe(200);
    const body = gates.json() as { stage: string; report: unknown[] };
    expect(body.stage).toBe("topic");
    expect(body.report).toHaveLength(ACADEMIC_STAGES.length);
    await withGates.app.close();

    const withoutGates = buildApp(false);
    const missing = await withoutGates.app.inject({
      method: "GET",
      url: "/academic/projects/whatever/gates",
      headers: { "x-uid": "1" },
    });
    expect(missing.statusCode).toBe(503);
    expect(missing.json().detail).toContain("门禁服务未启用");
    await withoutGates.app.close();
  });

 it("POST /gates/sync advances only under autoMode=auto and returns the sync summary", async () => {
    const { app, ctx } = buildApp(true);
    const project = await ctx.store.create("1", { title: "自动模式项目", autoMode: "auto" });
    await ctx.store.update("1", project.id, {
      plans: { topic: [{ id: "t1", title: "完成任务", done: true }] },
    });

    const synced = await app.inject({
      method: "POST",
      url: "/academic/projects/" + project.id + "/gates/sync",
      headers: { "x-uid": "1" },
    });
    expect(synced.statusCode).toBe(200);
    const body = synced.json() as { sync: unknown[]; advanced: { advanced: boolean; to?: string } };
    expect(body.sync).toEqual([]);
    expect(body.advanced).toMatchObject({ advanced: true, to: "design" });
    expect((await ctx.store.get("1", project.id))?.stage).toBe("design");
    await app.close();
  });
});


