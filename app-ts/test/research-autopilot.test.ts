import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { runWithRequestContext } from "../src/context/request-context.js";
import { MemoryAcademicStore } from "../src/repository/memory/academic.js";
import { MemoryAcademicNotificationRepository } from "../src/repository/memory/academic-notifications.js";
import { MemoryResearchAutopilotRepository } from "../src/repository/memory/research-autopilot.js";
import type { AcademicStage } from "../src/repository/academic.js";
import {
  ResearchAdvisorService,
  type ResearchSuggestion,
} from "../src/services/research/research-advisor.js";
import {
  ResearchStageGateError,
  ResearchStageGateService,
} from "../src/services/research/research-stage-gates.js";
import { ResearchNotificationService } from "../src/services/research/notifications.js";
import {
  AUTOPILOT_ASSIST_NOTIFICATION_TITLE,
  AUTOPILOT_AUTO_NOTIFICATION_TITLE,
  ResearchAutopilotError,
  ResearchAutopilotService,
  type ResearchAutopilotAssistResult,
  type ResearchAutopilotAutoResult,
  type ResearchAutopilotSkipResult,
  type ResearchAutopilotTickResult,
} from "../src/services/research/autopilot.js";
import { registerAutopilotRoutes } from "../src/transport/http/routes/autopilot.js";
import { today } from "../src/utils/datetime.js";

/**
 * Autopilot: settings contract, deterministic tick and the REST surface.
 * Everything runs offline over memory stores — no Mongo, no LLM, no network.
 */

const UID = "u1";

interface SetupOptions {
  notifications?: boolean;
  now?: () => number;
}

function setup(options: SetupOptions = {}) {
  const store = new MemoryAcademicStore();
  const settings = new MemoryResearchAutopilotRepository();
  const notificationRepo = new MemoryAcademicNotificationRepository();
  const notifications = new ResearchNotificationService(notificationRepo);
  const gates = new ResearchStageGateService({
    projects: store,
    documents: store,
    literature: store,
    events: store,
  });
  const advisor = new ResearchAdvisorService({ projects: store, documents: store, literature: store, gates });
  const autopilot = new ResearchAutopilotService({
    settings,
    projects: store,
    gates,
    advisor,
    ...(options.notifications === false ? {} : { notifications }),
    ...(options.now ? { now: options.now } : {}),
  });
  return { store, settings, notificationRepo, notifications, gates, advisor, autopilot };
}

type Setup = ReturnType<typeof setup>;

async function createProject(ctx: Setup, autoMode?: "off" | "assist" | "auto"): Promise<string> {
  const project = await ctx.store.create(UID, {
    title: "Autopilot 测试项目",
    ...(autoMode !== undefined ? { autoMode } : {}),
  });
  return project.id;
}

async function completePlan(
  ctx: Setup,
  projectId: string,
  stage: AcademicStage = "topic",
  count = 2,
): Promise<void> {
  const tasks = Array.from({ length: count }, (_, index) => ({
    id: stage + "-" + (index + 1),
    title: stage + " 任务 " + (index + 1),
    done: true,
  }));
  await ctx.store.update(UID, projectId, { plans: { [stage]: tasks } });
}

function assistResult(result: ResearchAutopilotTickResult): ResearchAutopilotAssistResult {
  if (!("mode" in result) || result.mode !== "assist") {
    throw new Error("expected an assist result, got " + JSON.stringify(result));
  }
  return result as ResearchAutopilotAssistResult;
}

function autoResult(result: ResearchAutopilotTickResult): ResearchAutopilotAutoResult {
  if (!("mode" in result) || result.mode !== "auto") {
    throw new Error("expected an auto result, got " + JSON.stringify(result));
  }
  return result as ResearchAutopilotAutoResult;
}

function skipResult(result: ResearchAutopilotTickResult): ResearchAutopilotSkipResult {
  if (!("skipped" in result) || result.skipped !== true) {
    throw new Error("expected a skipped tick, got " + JSON.stringify(result));
  }
  return result as ResearchAutopilotSkipResult;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

describe("research autopilot: settings", () => {
  it("returns the default off setting without persisting a row", async () => {
    const ctx = setup();
    const projectId = await createProject(ctx);

    const setting = await ctx.autopilot.get(UID, projectId);
    expect(setting).toMatchObject({
      uid: UID,
      projectId,
      mode: "off",
      maxActionsPerDay: 10,
      actionsToday: 0,
      day: today(),
      updatedAt: 0,
    });
    expect(setting.stoppedAt).toBeUndefined();
    expect(setting.lastTickAt).toBeUndefined();
    // Reading never fabricates a stored row.
    expect(await ctx.settings.get(UID, projectId)).toBeUndefined();
  });

  it("keeps one row per project and isolates owners", async () => {
    const ctx = setup();
    const projectId = await createProject(ctx);
    const row = {
      uid: UID,
      projectId,
      mode: "assist" as const,
      maxActionsPerDay: 4,
      actionsToday: 2,
      day: "2026-01-01",
      updatedAt: 100,
    };
    await ctx.settings.save(row);
    expect(await ctx.settings.get(UID, projectId)).toEqual(row);
    expect(await ctx.settings.get("u2", projectId)).toBeUndefined();
    expect(await ctx.settings.get(UID, "other")).toBeUndefined();

    await ctx.settings.save({ ...row, maxActionsPerDay: 7, updatedAt: 200 });
    const stored = await ctx.settings.get(UID, projectId);
    expect(stored?.maxActionsPerDay).toBe(7);
    expect(stored?.updatedAt).toBe(200);

    // Scheduler enumeration skips off and emergency-stopped rows.
    await ctx.settings.save({ ...row, mode: "off", updatedAt: 300 });
    expect(await ctx.settings.listActive()).toEqual([]);
    await ctx.settings.save({ ...row, mode: "auto", stoppedAt: 5, updatedAt: 400 });
    expect(await ctx.settings.listActive()).toEqual([]);
    await ctx.settings.save({ ...row, mode: "auto", updatedAt: 500 });
    expect((await ctx.settings.listActive()).map((setting) => setting.projectId)).toEqual([projectId]);
  });

  it("validates mode, budget and stopped flags on patch", async () => {
    const ctx = setup();
    const projectId = await createProject(ctx);

    await expect(ctx.autopilot.patch(UID, projectId, { mode: "bogus" })).rejects.toMatchObject({ status: 422 });
    await expect(ctx.autopilot.patch(UID, projectId, { maxActionsPerDay: 0 })).rejects.toMatchObject({ status: 422 });
    await expect(ctx.autopilot.patch(UID, projectId, { maxActionsPerDay: 101 })).rejects.toMatchObject({ status: 422 });
    await expect(ctx.autopilot.patch(UID, projectId, { maxActionsPerDay: 2.5 })).rejects.toMatchObject({ status: 422 });
    await expect(ctx.autopilot.patch(UID, projectId, { stopped: "yes" })).rejects.toMatchObject({ status: 422 });
    await expect(ctx.autopilot.patch(UID, projectId, "nope")).rejects.toBeInstanceOf(ResearchAutopilotError);

    const saved = await ctx.autopilot.patch(UID, projectId, { mode: "auto", maxActionsPerDay: 3 });
    expect(saved).toMatchObject({ mode: "auto", maxActionsPerDay: 3, actionsToday: 0, day: today() });
    // A rejected patch must not overwrite the stored mode.
    const invalid = await ctx.autopilot.patch(UID, projectId, { mode: "bogus" }).catch((err: unknown) => err);
    expect(invalid).toBeInstanceOf(ResearchAutopilotError);
    expect((await ctx.autopilot.get(UID, projectId)).mode).toBe("auto");
  });

  it("404s for a missing or foreign project", async () => {
    const ctx = setup();
    const projectId = await createProject(ctx);
    await expect(ctx.autopilot.get("u2", projectId)).rejects.toMatchObject({ status: 404 });
    await expect(ctx.autopilot.patch("u2", projectId, { mode: "assist" })).rejects.toMatchObject({ status: 404 });
    await expect(ctx.autopilot.tick("u2", projectId)).rejects.toBeInstanceOf(ResearchAutopilotError);
    await expect(ctx.autopilot.get(UID, "missing")).rejects.toMatchObject({ status: 404 });
  });
});

// ---------------------------------------------------------------------------
// Tick: off / assist / auto
// ---------------------------------------------------------------------------

describe("research autopilot: tick", () => {
  it("off ticks skip without gate changes, notifications or budget use", async () => {
    const ctx = setup();
    const projectId = await createProject(ctx, "auto");
    await completePlan(ctx, projectId, "topic");

    const skipped = skipResult(await ctx.autopilot.tick(UID, projectId));
    expect(skipped).toMatchObject({ skipped: true, mode: "off", actionsToday: 0, maxActionsPerDay: 10 });
    expect(skipped.reason).toContain("off");

    const project = await ctx.store.get(UID, projectId);
    expect(project?.stage).toBe("topic");
    expect(project?.stages.topic.status).toBe("active");
    expect(await ctx.notifications.list(UID)).toEqual([]);
    // A skipped tick does not persist a setting row.
    expect(await ctx.settings.get(UID, projectId)).toBeUndefined();
  });

  it("assist only sends one aggregated notification and never advances", async () => {
    const ctx = setup();
    const projectId = await createProject(ctx, "auto");
    await completePlan(ctx, projectId, "topic");
    await ctx.autopilot.patch(UID, projectId, { mode: "assist" });

    const assist = assistResult(await ctx.autopilot.tick(UID, projectId));
    expect(assist.suggestions.length).toBeGreaterThan(0);
    expect(assist.suggestions.length).toBeLessThanOrEqual(3);
    expect(assist.notified).toBe(true);
    expect(assist.actionsToday).toBe(1);

    // assist never runs the gates: even autoMode="auto" stays put and nothing is approved.
    const project = await ctx.store.get(UID, projectId);
    expect(project?.stage).toBe("topic");
    expect(project?.stages.topic.status).toBe("active");
    expect(Object.values(project?.stages ?? {}).every((state) => state.status !== "approved")).toBe(true);

    const list = await ctx.notifications.list(UID);
    expect(list).toHaveLength(1);
    const notification = list[0]!;
    expect(notification).toMatchObject({
      type: "plan",
      title: AUTOPILOT_ASSIST_NOTIFICATION_TITLE,
      link: "/research?project=" + projectId + "&tab=overview",
    });
    expect(notification.body).toContain(assist.suggestions[0]!.title);
    expect((notification.body ?? "").split("\n").length).toBeLessThanOrEqual(3);

    const setting = await ctx.autopilot.get(UID, projectId);
    expect(setting.actionsToday).toBe(1);
    expect(setting.lastTickAt).toBeTypeOf("number");
    expect(setting.lastResult).toContain("assist");
  });

  it("auto advances a ready gate to submitted, opens the next stage and notifies", async () => {
    const ctx = setup();
    const projectId = await createProject(ctx, "auto");
    await completePlan(ctx, projectId, "topic");
    await ctx.autopilot.patch(UID, projectId, { mode: "auto" });

    const auto = autoResult(await ctx.autopilot.tick(UID, projectId));
    expect(auto.advanced).toBe(true);
    expect(auto.from).toBe("topic");
    expect(auto.to).toBe("design");
    expect(auto.stage).toBe("design");
    expect(auto.report.length).toBeGreaterThan(0);
    expect(auto.suggestions.length).toBeGreaterThan(0);
    expect(auto.notified).toBe(true);
    expect(auto.actionsToday).toBe(1);

    // stage.updated direction=advance, and approved is never written.
    const project = await ctx.store.get(UID, projectId);
    expect(project?.stage).toBe("design");
    expect(project?.stages.topic.status).toBe("submitted");
    expect(project?.stages.design.status).toBe("active");
    expect(Object.values(project?.stages ?? {}).every((state) => state.status !== "approved")).toBe(true);
    const events = await ctx.store.listEvents(UID, projectId, 10);
    expect(events.some((event) => event.type === "stage.updated")).toBe(true);

    const list = await ctx.notifications.list(UID);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ type: "plan", title: AUTOPILOT_AUTO_NOTIFICATION_TITLE });
    expect(list[0]!.body ?? "").toContain("已自动推进阶段");

    // Next tick: design is not ready, so auto reports "not advanced" instead of skipping ahead.
    const again = autoResult(await ctx.autopilot.tick(UID, projectId));
    expect(again.advanced).toBe(false);
    expect(again.advanceReason).toContain("门禁未通过");
    expect((await ctx.store.get(UID, projectId))?.stage).toBe("design");
    expect((await ctx.autopilot.get(UID, projectId)).actionsToday).toBe(2);
  });

  it("auto respects the project's autoMode: assist projects never advance", async () => {
    const ctx = setup();
    const projectId = await createProject(ctx, "assist");
    await completePlan(ctx, projectId, "topic");
    await ctx.autopilot.patch(UID, projectId, { mode: "auto" });

    const auto = autoResult(await ctx.autopilot.tick(UID, projectId));
    expect(auto.advanced).toBe(false);
    expect(auto.advanceReason).toContain("autoMode");
    const project = await ctx.store.get(UID, projectId);
    expect(project?.stage).toBe("topic");
    expect(project?.stages.topic.status).toBe("active");
    expect(auto.notified).toBe(true);
  });

  it("enforces the daily budget and resets the counter on a new day", async () => {
    const ctx = setup();
    const projectId = await createProject(ctx);
    await ctx.autopilot.patch(UID, projectId, { mode: "assist", maxActionsPerDay: 1 });

    const first = await ctx.autopilot.tick(UID, projectId);
    expect("skipped" in first ? first.skipped : true).toBe(false);

    const overBudget = skipResult(await ctx.autopilot.tick(UID, projectId));
    expect(overBudget.reason).toContain("预算");
    expect(overBudget.actionsToday).toBe(1);
    expect(overBudget.maxActionsPerDay).toBe(1);

    // A stale day (yesterday) resets the counter and allows today's action.
    const stored = (await ctx.settings.get(UID, projectId))!;
    await ctx.settings.save({ ...stored, day: "2000-01-01", actionsToday: 1 });
    const nextDay = assistResult(await ctx.autopilot.tick(UID, projectId));
    expect(nextDay.actionsToday).toBe(1);
    const after = (await ctx.settings.get(UID, projectId))!;
    expect(after.day).toBe(today());
    expect(after.actionsToday).toBe(1);
  });

  it("stops via stoppedAt and resumes when it is cleared", async () => {
    const ctx = setup();
    const projectId = await createProject(ctx);
    await ctx.autopilot.patch(UID, projectId, { mode: "assist" });

    const stopped = await ctx.autopilot.patch(UID, projectId, { stopped: true });
    expect(stopped.stoppedAt).toBeTypeOf("number");

    const skipped = skipResult(await ctx.autopilot.tick(UID, projectId));
    expect(skipped.reason).toContain("急停");
    expect((await ctx.settings.get(UID, projectId))?.actionsToday ?? 0).toBe(0);

    const resumed = await ctx.autopilot.patch(UID, projectId, { stopped: false });
    expect(resumed.stoppedAt).toBeUndefined();
    const result = assistResult(await ctx.autopilot.tick(UID, projectId));
    expect(result.actionsToday).toBe(1);
  });

  it("aggregates all suggestions into a single notification capped at three lines", async () => {
    const ctx = setup();
    const projectId = await createProject(ctx);
    const suggestions: ResearchSuggestion[] = Array.from({ length: 5 }, (_, index) => ({
      id: "s" + (index + 1),
      title: "建议 " + (index + 1),
      reason: "原因 " + (index + 1),
      action: "academic_project(action=brief)",
      severity: "info",
    }));
    const autopilot = new ResearchAutopilotService({
      settings: ctx.settings,
      projects: ctx.store,
      gates: ctx.gates,
      advisor: { suggest: async () => ({ stage: "topic", suggestions }) },
      notifications: ctx.notifications,
    });
    await autopilot.patch(UID, projectId, { mode: "assist" });

    const result = await autopilot.tick(UID, projectId);
    expect("error" in result).toBe(false);
    const list = await ctx.notifications.list(UID);
    expect(list).toHaveLength(1);
    const lines = (list[0]!.body ?? "").split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("建议 1");
    expect(lines[2]).toContain("建议 3");
    expect(list[0]!.body ?? "").not.toContain("建议 4");
  });

  it("degrades engine failures to { error } while keeping 404 semantics", async () => {
    const ctx = setup();
    const projectId = await createProject(ctx);
    const settings = new MemoryResearchAutopilotRepository();
    await settings.save({
      uid: UID,
      projectId,
      mode: "auto",
      maxActionsPerDay: 10,
      actionsToday: 0,
      day: today(),
      updatedAt: 1,
    });
    const autopilot = new ResearchAutopilotService({
      settings,
      projects: ctx.store,
      gates: {
        apply: async () => {
          throw new Error("gates down");
        },
      },
      advisor: {
        suggest: async () => {
          throw new Error("advisor down");
        },
      },
    });
    await expect(autopilot.tick(UID, projectId)).resolves.toEqual({ error: "gates down" });
    await expect(
      new ResearchAutopilotService({
        settings,
        projects: ctx.store,
        gates: {
          apply: async () => {
            throw new ResearchStageGateError(404, "项目不存在或无权访问");
          },
        },
        advisor: ctx.advisor,
      }).tick(UID, projectId),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("works without the optional notification sink", async () => {
    const ctx = setup({ notifications: false });
    const projectId = await createProject(ctx);
    await ctx.autopilot.patch(UID, projectId, { mode: "assist" });

    const assist = assistResult(await ctx.autopilot.tick(UID, projectId));
    expect(assist.notified).toBe(false);
    expect(await ctx.notificationRepo.listByUid(UID)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// REST surface
// ---------------------------------------------------------------------------

function buildApp(ctx: Setup) {
  const app = Fastify();
  app.addHook("onRequest", (req, _reply, done) => {
    const raw = req.headers["x-uid"];
    runWithRequestContext(
      { requestId: "test", uid: typeof raw === "string" ? raw : undefined, startedAt: Date.now() },
      done,
    );
  });
  registerAutopilotRoutes(app, { autopilot: ctx.autopilot });
  return app;
}

const asUid = (uid: string) => ({ "x-uid": uid, "content-type": "application/json" });
/** POST routes without a body must not claim JSON content. */
const uidOnly = (uid: string) => ({ "x-uid": uid });

describe("research autopilot: HTTP routes", () => {
  it("requires the gateway uid and 404s missing/foreign projects", async () => {
    const ctx = setup();
    const app = buildApp(ctx);
    const project = await ctx.store.create("1", { title: "路由测试项目" });

    for (const request of [
      { method: "GET" as const, url: "/academic/projects/" + project.id + "/autopilot" },
      { method: "PATCH" as const, url: "/academic/projects/" + project.id + "/autopilot" },
      { method: "POST" as const, url: "/academic/projects/" + project.id + "/autopilot/tick" },
      { method: "POST" as const, url: "/academic/projects/" + project.id + "/autopilot/stop" },
    ]) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(401);
      expect((response.json() as { detail: string }).detail).toContain("X-Uid");
    }

    const missing = await app.inject({
      method: "GET",
      url: "/academic/projects/does-not-exist/autopilot",
      headers: asUid("1"),
    });
    expect(missing.statusCode).toBe(404);
    expect((missing.json() as { detail: string }).detail).toContain("不存在");

    const foreign = await app.inject({
      method: "GET",
      url: "/academic/projects/" + project.id + "/autopilot",
      headers: asUid("2"),
    });
    expect(foreign.statusCode).toBe(404);
    await app.close();
  });

  it("reads, patches, stops and resumes the setting through REST", async () => {
    const ctx = setup();
    const app = buildApp(ctx);
    const project = await ctx.store.create("1", { title: "路由测试项目" });

    const initial = await app.inject({
      method: "GET",
      url: "/academic/projects/" + project.id + "/autopilot",
      headers: asUid("1"),
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({ mode: "off", maxActionsPerDay: 10, actionsToday: 0 });

    const invalidMode = await app.inject({
      method: "PATCH",
      url: "/academic/projects/" + project.id + "/autopilot",
      headers: asUid("1"),
      payload: { mode: "bogus" },
    });
    expect(invalidMode.statusCode).toBe(422);
    expect((invalidMode.json() as { detail: string }).detail).toContain("mode");

    const invalidBudget = await app.inject({
      method: "PATCH",
      url: "/academic/projects/" + project.id + "/autopilot",
      headers: asUid("1"),
      payload: { maxActionsPerDay: 0 },
    });
    expect(invalidBudget.statusCode).toBe(422);

    const patched = await app.inject({
      method: "PATCH",
      url: "/academic/projects/" + project.id + "/autopilot",
      headers: asUid("1"),
      payload: { mode: "assist", maxActionsPerDay: 5 },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ mode: "assist", maxActionsPerDay: 5 });

    const stopped = await app.inject({
      method: "POST",
      url: "/academic/projects/" + project.id + "/autopilot/stop",
      headers: uidOnly("1"),
    });
    expect(stopped.statusCode).toBe(200);
    expect(typeof (stopped.json() as { stoppedAt: unknown }).stoppedAt).toBe("number");

    const tickStopped = await app.inject({
      method: "POST",
      url: "/academic/projects/" + project.id + "/autopilot/tick",
      headers: uidOnly("1"),
    });
    expect(tickStopped.statusCode).toBe(200);
    expect(tickStopped.json()).toMatchObject({ skipped: true });
    expect((tickStopped.json() as { reason: string }).reason).toContain("急停");

    const resumed = await app.inject({
      method: "POST",
      url: "/academic/projects/" + project.id + "/autopilot/resume",
      headers: uidOnly("1"),
    });
    expect(resumed.statusCode).toBe(200);
    expect((resumed.json() as { stoppedAt?: unknown }).stoppedAt).toBeUndefined();

    const tick = await app.inject({
      method: "POST",
      url: "/academic/projects/" + project.id + "/autopilot/tick",
      headers: uidOnly("1"),
    });
    expect(tick.statusCode).toBe(200);
    const tickBody = tick.json() as { skipped: boolean; mode: string; suggestions: unknown[] };
    expect(tickBody.skipped).toBe(false);
    expect(tickBody.mode).toBe("assist");
    expect(tickBody.suggestions.length).toBeGreaterThan(0);
    await app.close();
  });

  it("ticks an auto project and exposes the advance plus the gate report", async () => {
    const ctx = setup();
    const app = buildApp(ctx);
    const project = await ctx.store.create("1", { title: "自动推进项目", autoMode: "auto" });
    await ctx.store.update("1", project.id, {
      plans: { topic: [{ id: "t1", title: "完成选题", done: true }] },
    });
    const patched = await app.inject({
      method: "PATCH",
      url: "/academic/projects/" + project.id + "/autopilot",
      headers: asUid("1"),
      payload: { mode: "auto" },
    });
    expect(patched.statusCode).toBe(200);

    const tick = await app.inject({
      method: "POST",
      url: "/academic/projects/" + project.id + "/autopilot/tick",
      headers: uidOnly("1"),
    });
    expect(tick.statusCode).toBe(200);
    const body = tick.json() as { advanced: boolean; from?: string; to?: string; report: unknown[] };
    expect(body.advanced).toBe(true);
    expect(body.from).toBe("topic");
    expect(body.to).toBe("design");
    expect(body.report.length).toBeGreaterThan(0);
    expect((await ctx.store.get("1", project.id))?.stage).toBe("design");

    const tickMissing = await app.inject({
      method: "POST",
      url: "/academic/projects/does-not-exist/autopilot/tick",
      headers: uidOnly("1"),
    });
    expect(tickMissing.statusCode).toBe(404);
    await app.close();
  });
});

