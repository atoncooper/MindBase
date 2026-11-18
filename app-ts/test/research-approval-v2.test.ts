import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { runWithRequestContext } from "../src/context/request-context.js";
import { ResultCollector, type ToolRunContext } from "../src/context/types.js";
import {
  initialStageStates,
  type AcademicActor,
  type AcademicEvent,
  type AcademicEventRepository,
  type AcademicProject,
  type AcademicProjectCreate,
  type AcademicProjectPatch,
  type AcademicProjectRepository,
} from "../src/repository/academic.js";
import type { ResearchApproval } from "../src/repository/research-approvals.js";
import { MemoryResearchApprovalRepository } from "../src/repository/memory/research-approvals.js";
import type { ResearchExperiment } from "../src/repository/research-experiments.js";
import {
  DEFAULT_APPROVAL_TTL_MS,
  ResearchApprovalError,
  ResearchApprovalService,
} from "../src/services/research/research-approval.js";
import type { SubmitExperimentInput } from "../src/services/research/research-experiment.js";
import { createResearchApprovalTool } from "../src/tools/academic/approval.js";
import { createAcademicExperimentTool } from "../src/tools/academic/experiment.js";
import { registerAcademicRoutes } from "../src/transport/http/routes/academic.js";
import type { AcademicService } from "../src/services/research/academic.js";

/**
 * Approval v2 : expiry, one-shot consumption, experiment
 * binding, ownership, audit events and the require-approval experiment gate.
 * Memory repositories + local fakes only — no Mongo, no network, no sandbox.
 */

// ---------------------------------------------------------------------------
// Fakes / helpers
// ---------------------------------------------------------------------------

class FakeEventRepository implements AcademicEventRepository {
  readonly events: AcademicEvent[] = [];
  /** When true the next append throws (audit failures must stay non-fatal). */
  failNext = false;
  private seq = 0;

  async append(
    uid: string,
    projectId: string,
    type: string,
    payload: Record<string, unknown> = {},
    actor: AcademicActor = "user",
  ): Promise<AcademicEvent> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("event sink down");
    }
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
    return structuredClone(event);
  }

  async listEvents(uid: string, projectId: string, limit = 20): Promise<AcademicEvent[]> {
    return this.events
      .filter((event) => event.uid === uid && event.projectId === projectId)
      .slice(-limit)
      .reverse()
      .map((event) => structuredClone(event));
  }
}

class FakeProjectRepository implements AcademicProjectRepository {
  private readonly rows = new Map<string, AcademicProject>();
  private seq = 0;

  seed(uid: string, projectId: string): void {
    const now = Date.now();
    this.rows.set(uid + "/" + projectId, {
      id: projectId,
      uid,
      title: "project-" + projectId,
      paperType: "journal",
      field: "",
      stage: "topic",
      stages: initialStageStates(now),
      plans: {},
      advice: {},
      createdAt: now,
      updatedAt: now,
    });
  }

  async create(uid: string, input: AcademicProjectCreate): Promise<AcademicProject> {
    const now = Date.now();
    const project: AcademicProject = {
      id: "p" + (this.seq += 1),
      uid,
      title: input.title,
      paperType: input.paperType ?? "journal",
      field: input.field ?? "",
      stage: "topic",
      stages: initialStageStates(now),
      plans: {},
      advice: {},
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(uid + "/" + project.id, project);
    return structuredClone(project);
  }

  async list(uid: string): Promise<AcademicProject[]> {
    return [...this.rows.values()].filter((row) => row.uid === uid).map((row) => structuredClone(row));
  }

  async get(uid: string, projectId: string): Promise<AcademicProject | null> {
    const found = this.rows.get(uid + "/" + projectId);
    return found ? structuredClone(found) : null;
  }

  async update(_uid: string, _projectId: string, _patch: AcademicProjectPatch): Promise<AcademicProject | null> {
    return null;
  }

  async remove(_uid: string, _projectId: string): Promise<boolean> {
    return false;
  }
}

class FakeExperimentRunner {
  readonly submitted: ResearchExperiment[] = [];
  private seq = 0;

  async preflight(): Promise<void> {}

  async submit(input: SubmitExperimentInput): Promise<ResearchExperiment> {
    const exp: ResearchExperiment = {
      id: "exp-" + (this.seq += 1),
      uid: input.uid,
      projectId: input.projectId,
      language: input.language,
      code: input.code,
      timeoutMs: input.timeoutMs,
      status: "queued",
      createdAt: Date.now(),
      ...(input.title ? { title: input.title } : {}),
    };
    this.submitted.push(exp);
    return structuredClone(exp);
  }

  async get(id: string): Promise<ResearchExperiment | undefined> {
    const found = this.submitted.find((exp) => exp.id === id);
    return found ? structuredClone(found) : undefined;
  }

  async list(uid: string, projectId?: string, limit = 20): Promise<ResearchExperiment[]> {
    return this.submitted
      .filter((exp) => exp.uid === uid && (projectId === undefined || exp.projectId === projectId))
      .slice(0, limit)
      .map((exp) => structuredClone(exp));
  }

  async cancel(_id: string): Promise<boolean> {
    return false;
  }
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

async function errorOf(promise: Promise<unknown>): Promise<ResearchApprovalError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ResearchApprovalError) return err;
    throw err;
  }
  throw new Error("expected the promise to reject");
}

/** Insert a row directly so tests can pin requestedAt/expiresAt/consumedAt. */
async function seedApproval(
  repo: MemoryResearchApprovalRepository,
  overrides: Partial<ResearchApproval> = {},
): Promise<ResearchApproval> {
  const now = Date.now();
  const approval: ResearchApproval = {
    id: "a-" + Math.random().toString(36).slice(2),
    uid: "1",
    projectId: "p1",
    kind: "experiment",
    status: "approved",
    requestedAt: now,
    ...overrides,
  };
  await repo.create(approval);
  return approval;
}

function setupExperimentGate(injectApprovals = true) {
  const repo = new MemoryResearchApprovalRepository();
  const events = new FakeEventRepository();
  const approvals = new ResearchApprovalService(repo, events);
  const runner = new FakeExperimentRunner();
  const projects = new FakeProjectRepository();
  projects.seed("u1", "p1");
  const tool = createAcademicExperimentTool(
    runner as never,
    projects,
    injectApprovals ? approvals : undefined,
  );
  return { repo, events, approvals, runner, projects, tool };
}

// ---------------------------------------------------------------------------
// Contract / request
// ---------------------------------------------------------------------------

describe("approval v2: request metadata", () => {
 it("stamps a default 24h expiry and the requesting side", async () => {
    const service = new ResearchApprovalService(new MemoryResearchApprovalRepository());
    const approval = await service.request("1", "p1", "experiment", "run training");
    expect(approval.status).toBe("pending");
    expect(approval.expiresAt).toBe(approval.requestedAt + DEFAULT_APPROVAL_TTL_MS);
    expect(approval.requestedBy).toBe("agent");
    expect(approval.consumedAt).toBeUndefined();
  });

 it("persists scope / experimentId / payloadHash / custom ttl", async () => {
    const service = new ResearchApprovalService(new MemoryResearchApprovalRepository());
    const approval = await service.request("1", "p1", "submission", undefined, {
      scope: "export",
      experimentId: "planned-exp",
      ttlMs: 60_000,
      payloadHash: "sha256:abc",
      requestedBy: "user",
    });
    expect(approval.scope).toBe("export");
    expect(approval.experimentId).toBe("planned-exp");
    expect(approval.expiresAt).toBe(approval.requestedAt + 60_000);
    expect(approval.payloadHash).toBe("sha256:abc");
    expect(approval.requestedBy).toBe("user");
  });

 it("dedupes pending rows per project+kind+scope and keeps other scopes separate", async () => {
    const service = new ResearchApprovalService(new MemoryResearchApprovalRepository());
    const first = await service.request("1", "p1", "experiment");
    const again = await service.request("1", "p1", "experiment", "another note");
    expect(again.id).toBe(first.id);

    const scoped = await service.request("1", "p1", "experiment", undefined, { scope: "experiment" });
    expect(scoped.id).not.toBe(first.id);
    const scopedAgain = await service.request("1", "p1", "experiment", undefined, { scope: "experiment" });
    expect(scopedAgain.id).toBe(scoped.id);
  });

 it("replaces a stale pending request instead of reusing an expired one", async () => {
    const repo = new MemoryResearchApprovalRepository();
    const service = new ResearchApprovalService(repo);
    await seedApproval(repo, { uid: "1", projectId: "p1", kind: "experiment", status: "pending", expiresAt: Date.now() - 1 });
    const fresh = await service.request("1", "p1", "experiment");
    expect(fresh.status).toBe("pending");
    expect(fresh.expiresAt).toBeGreaterThan(Date.now());
  });
});

// ---------------------------------------------------------------------------
// Validity helpers + legacy rows
// ---------------------------------------------------------------------------

describe("approval v2: expiry and legacy semantics", () => {
 it("rejects a decision on an expired pending request and records approval.expired", async () => {
    const repo = new MemoryResearchApprovalRepository();
    const events = new FakeEventRepository();
    const service = new ResearchApprovalService(repo, events);
    const expired = await seedApproval(repo, {
      status: "pending",
      requestedAt: Date.now() - 10_000,
      expiresAt: Date.now() - 1,
    });

    const err = await errorOf(service.decide("1", expired.id, true));
    expect(err).toBeInstanceOf(ResearchApprovalError);
    expect(err.code).toBe("expired");
    expect(await repo.get(expired.id)).toMatchObject({ status: "pending" });
    const expiredEvent = events.events.find((event) => event.type === "approval.expired");
    expect(expiredEvent?.payload.approvalId).toBe(expired.id);
  });

 it("treats an expired approval as not approved and not consumable", async () => {
    const repo = new MemoryResearchApprovalRepository();
    const service = new ResearchApprovalService(repo);
    await seedApproval(repo, { expiresAt: Date.now() - 1 });

    expect(await service.isApproved("1", "p1", "experiment")).toBe(false);
    expect(await service.listActive("1", "p1")).toHaveLength(0);
    expect((await errorOf(service.consume("1", "p1", "experiment"))).code).toBe("expired");
    const byId = await errorOf(service.consumeById("1", (await service.list("1", "p1"))[0]!.id));
    expect(byId.code).toBe("expired");
  });

 it("keeps pre-v2 rows usable: no expiresAt = never expires, no consumedAt = unconsumed", async () => {
    const repo = new MemoryResearchApprovalRepository();
    const service = new ResearchApprovalService(repo);
    const legacy = await seedApproval(repo, { id: "legacy-row" });
    expect(legacy.expiresAt).toBeUndefined();
    expect(legacy.consumedAt).toBeUndefined();
    expect(legacy.scope).toBeUndefined();

    expect(await service.isApproved("1", "p1", "experiment")).toBe(true);
    expect(await service.hasApprovedProjectLevel("1", "p1", "experiment")).toBe(true);
    const consumed = await service.consume("1", "p1", "experiment");
    expect(consumed.id).toBe("legacy-row");
    expect(consumed.consumedAt).toBeGreaterThan(0);
    expect(await service.isApproved("1", "p1", "experiment")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// One-shot consumption
// ---------------------------------------------------------------------------

describe("approval v2: one-shot consumption", () => {
 it("consumes an approved decision once, then refuses a second use", async () => {
    const repo = new MemoryResearchApprovalRepository();
    const service = new ResearchApprovalService(repo);
    const approval = await service.request("1", "p1", "experiment");
    await service.decide("1", approval.id, true);

    expect(await service.isApproved("1", "p1", "experiment")).toBe(true);
    const consumed = await service.consume("1", "p1", "experiment");
    expect(consumed.id).toBe(approval.id);
    expect(consumed.consumedAt).toBeTypeOf("number");
    expect(await service.isApproved("1", "p1", "experiment")).toBe(false);

    expect((await errorOf(service.consume("1", "p1", "experiment"))).code).toBe("consumed");
    expect((await errorOf(service.consumeById("1", approval.id))).code).toBe("consumed");
  });

 it("explains when there is no approved decision at all", async () => {
    const service = new ResearchApprovalService(new MemoryResearchApprovalRepository());
    expect((await errorOf(service.consume("1", "p1", "experiment"))).code).toBe("unavailable");
    const pending = await service.request("1", "p1", "experiment");
    expect((await errorOf(service.consumeById("1", pending.id))).code).toBe("not_approved");
    await service.decide("1", pending.id, false);
    expect((await errorOf(service.consumeById("1", pending.id))).code).toBe("rejected");
  });

 it("picks the newest usable decision among several approved rows", async () => {
    const repo = new MemoryResearchApprovalRepository();
    const service = new ResearchApprovalService(repo);
    await seedApproval(repo, { id: "older", requestedAt: 1_000 });
    await seedApproval(repo, { id: "newer", requestedAt: 2_000 });
    await seedApproval(repo, { id: "newest-spent", requestedAt: 3_000, consumedAt: 3_100 });

    const consumed = await service.consume("1", "p1", "experiment");
    expect(consumed.id).toBe("newer");
  });

 it("consumeById enforces ownership and decision state", async () => {
    const repo = new MemoryResearchApprovalRepository();
    const service = new ResearchApprovalService(repo);
    const mine = await service.request("1", "p1", "experiment");
    await service.decide("1", mine.id, true);

    expect((await errorOf(service.consumeById("2", mine.id))).code).toBe("not_found");
    expect((await service.consumeById("1", mine.id)).consumedAt).toBeTypeOf("number");
  });
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

describe("approval v2: audit events", () => {
 it("appends requested/decided/consumed events with actor and payload", async () => {
    const repo = new MemoryResearchApprovalRepository();
    const events = new FakeEventRepository();
    const service = new ResearchApprovalService(repo, events);
    const approval = await service.request("1", "p1", "experiment", undefined, {
      scope: "experiment",
      requestedBy: "user",
    });
    await service.decide("1", approval.id, true, "ok");
    await service.consume("1", "p1", "experiment");

    const requested = events.events.find((event) => event.type === "approval.requested");
    expect(requested?.actor).toBe("user");
    expect(requested?.payload).toMatchObject({ approvalId: approval.id, kind: "experiment", scope: "experiment" });

    const decided = events.events.find((event) => event.type === "approval.decided");
    expect(decided?.actor).toBe("user");
    expect(decided?.payload).toMatchObject({ approvalId: approval.id, approved: true, note: "ok" });

    const consumed = events.events.find((event) => event.type === "approval.consumed");
    expect(consumed?.actor).toBe("agent");
    expect(consumed?.payload.approvalId).toBe(approval.id);
  });

 it("does not fail the approval when the audit sink is down", async () => {
    const repo = new MemoryResearchApprovalRepository();
    const events = new FakeEventRepository();
    events.failNext = true;
    const service = new ResearchApprovalService(repo, events);
    const approval = await service.request("1", "p1", "experiment");
    expect(approval.status).toBe("pending");
    expect(events.events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scope-aware convenience gates
// ---------------------------------------------------------------------------

describe("approval v2: active/scope helpers", () => {
 it("listActive filters by kind and scope and skips spent/expired rows", async () => {
    const repo = new MemoryResearchApprovalRepository();
    const service = new ResearchApprovalService(repo);
    await seedApproval(repo, { id: "exp-ok", kind: "experiment", scope: "experiment", requestedAt: 1 });
    await seedApproval(repo, { id: "sub-ok", kind: "submission", scope: "submission", requestedAt: 2 });
    await seedApproval(repo, { id: "export-ok", kind: "submission", scope: "export", requestedAt: 3 });
    await seedApproval(repo, { id: "spent", kind: "submission", scope: "export", requestedAt: 4, consumedAt: 5 });
    await seedApproval(repo, { id: "expired", kind: "submission", scope: "export", requestedAt: 6, expiresAt: Date.now() - 1 });

    expect((await service.listActive("1", "p1")).map((a) => a.id)).toEqual(["export-ok", "sub-ok", "exp-ok"]);
    expect((await service.listActive("1", "p1", { kind: "submission" })).map((a) => a.id)).toEqual([
      "export-ok",
      "sub-ok",
    ]);
    expect((await service.listActive("1", "p1", { scope: "export" })).map((a) => a.id)).toEqual(["export-ok"]);
  });

 it("hasApprovedProjectLevel ignores experiment-bound actions and matches legacy unscoped rows", async () => {
    const repo = new MemoryResearchApprovalRepository();
    const service = new ResearchApprovalService(repo);
    await seedApproval(repo, { id: "bound", kind: "submission", experimentId: "exp-1" });
    expect(await service.hasApprovedProjectLevel("1", "p1", "submission")).toBe(false);

    await seedApproval(repo, { id: "legacy", kind: "submission" });
    expect(await service.hasApprovedProjectLevel("1", "p1", "submission")).toBe(true);
    expect(await service.hasApprovedProjectLevel("1", "p1", "submission", "export")).toBe(true);

    const repo2 = new MemoryResearchApprovalRepository();
    const service2 = new ResearchApprovalService(repo2);
    await seedApproval(repo2, { id: "export-only", kind: "submission", scope: "export" });
    expect(await service2.hasApprovedProjectLevel("1", "p1", "submission")).toBe(false);
    expect(await service2.hasApprovedProjectLevel("1", "p1", "submission", "export")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// academic_experiment submit gate
// ---------------------------------------------------------------------------

describe("academic_experiment: approval gate", () => {
 it("refuses submit without a usable approval and points at the pending request", async () => {
    const gate = setupExperimentGate();
    const ctx = makeCtx("u1");

    const denied = contentOf(
      await gate.tool.execute({ action: "submit", projectId: "p1", code: "print(1)" }, ctx),
    );
    expect(denied).toContain("需要人工审批");
    expect(gate.runner.submitted).toHaveLength(0);

    const pending = await gate.approvals.request("u1", "p1", "experiment", "train");
    const guided = contentOf(
      await gate.tool.execute({ action: "submit", projectId: "p1", code: "print(1)" }, ctx),
    );
    expect(guided).toContain("需要人工审批");
    expect(guided).toContain("approval_id=" + pending.id);
    expect(gate.runner.submitted).toHaveLength(0);
  });

 it("consumes a project-level approval once, binds the experiment and refuses the second run", async () => {
    const gate = setupExperimentGate();
    const ctx = makeCtx("u1");
    const approval = await gate.approvals.request("u1", "p1", "experiment", "train");
    await gate.approvals.decide("u1", approval.id, true);

    const submitted = contentOf(
      await gate.tool.execute({ action: "submit", projectId: "p1", code: "print(1)" }, ctx),
    );
    expect(submitted).toContain("实验已提交");
    expect(gate.runner.submitted).toHaveLength(1);
    const experiment = gate.runner.submitted[0]!;
    expect(submitted).toContain("experiment_id=" + experiment.id);
    expect(submitted).toContain("approval_id=" + approval.id);

    const stored = await gate.repo.get(approval.id);
    expect(stored?.consumedAt).toBeTypeOf("number");
    expect(stored?.experimentId).toBe(experiment.id);
    expect(await gate.approvals.isApproved("u1", "p1", "experiment")).toBe(false);

    const second = contentOf(
      await gate.tool.execute({ action: "submit", projectId: "p1", code: "print(2)" }, ctx),
    );
    expect(second).toContain("需要人工审批");
    expect(second).toContain("已被消费");
    expect(gate.runner.submitted).toHaveLength(1);
  });

 it("spends only the explicitly requested approvalId", async () => {
    const gate = setupExperimentGate();
    const ctx = makeCtx("u1");
    const first = await gate.approvals.request("u1", "p1", "experiment");
    const second = await gate.approvals.request("u1", "p1", "experiment", undefined, { scope: "experiment" });
    await gate.approvals.decide("u1", first.id, true);
    await gate.approvals.decide("u1", second.id, true);

    const submitted = contentOf(
      await gate.tool.execute(
        { action: "submit", projectId: "p1", code: "print(1)", approvalId: first.id },
        ctx,
      ),
    );
    expect(submitted).toContain("实验已提交");
    expect((await gate.repo.get(first.id))?.consumedAt).toBeTypeOf("number");
    expect((await gate.repo.get(second.id))?.consumedAt).toBeUndefined();
  });

 it("refuses a foreign approvalId and keeps a pending approvalId from being spent", async () => {
    const gate = setupExperimentGate();
    const ctx = makeCtx("u1");
    const foreign = await gate.approvals.request("u2", "p9", "experiment");
    await gate.approvals.decide("u2", foreign.id, true);

    const foreignText = contentOf(
      await gate.tool.execute(
        { action: "submit", projectId: "p1", code: "print(1)", approvalId: foreign.id },
        ctx,
      ),
    );
    expect(foreignText).toContain("不属于当前项目");
    expect(gate.runner.submitted).toHaveLength(0);

    const pending = await gate.approvals.request("u1", "p1", "experiment", undefined, { scope: "export" });
    const pendingText = contentOf(
      await gate.tool.execute(
        { action: "submit", projectId: "p1", code: "print(1)", approvalId: pending.id },
        ctx,
      ),
    );
    expect(pendingText).toContain("尚未批准");
    expect(gate.runner.submitted).toHaveLength(0);
  });

 it("keeps a pre-bound experimentId instead of overwriting it with the submitted run", async () => {
    const gate = setupExperimentGate();
    const ctx = makeCtx("u1");
    const approval = await gate.approvals.request("u1", "p1", "experiment", undefined, {
      experimentId: "planned-exp",
    });
    await gate.approvals.decide("u1", approval.id, true);

    const submitted = contentOf(
      await gate.tool.execute({ action: "submit", projectId: "p1", code: "print(1)" }, ctx),
    );
    expect(submitted).toContain("实验已提交");
    const stored = await gate.repo.get(approval.id);
    expect(stored?.experimentId).toBe("planned-exp");
    expect(stored?.consumedAt).toBeTypeOf("number");
  });

 it("legacy passthrough without an approval service, but explicit approvalId is refused", async () => {
    const gate = setupExperimentGate(false);
    const ctx = makeCtx("u1");

    const submitted = contentOf(
      await gate.tool.execute({ action: "submit", projectId: "p1", code: "print(1)" }, ctx),
    );
    expect(submitted).toContain("实验已提交");
    expect(gate.runner.submitted).toHaveLength(1);

    const refused = contentOf(
      await gate.tool.execute(
        { action: "submit", projectId: "p1", code: "print(2)", approvalId: "some-id" },
        ctx,
      ),
    );
    expect(refused).toContain("审批服务未启用");
    expect(gate.runner.submitted).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// research_approval tool status surface
// ---------------------------------------------------------------------------

describe("research_approval: v2 status output", () => {
 it("shows expiry, consumption, scope and experiment binding", async () => {
    const repo = new MemoryResearchApprovalRepository();
    const service = new ResearchApprovalService(repo);
    const tool = createResearchApprovalTool(service);
    const ctx = makeCtx("u1");

    const requestText = contentOf(
      await tool.execute({ action: "request", projectId: "p1", kind: "experiment", note: "train" }, ctx),
    );
    expect(requestText).toContain("status=pending");
    expect(requestText).toContain("有效至");
    const approvalId = /approval_id=([^\n]+)/.exec(requestText)?.[1];
    expect(approvalId).toBeTruthy();

    const before = contentOf(await tool.execute({ action: "status", projectId: "p1" }, ctx));
    expect(before).toContain("未消费");
    expect(before).toContain("scope=");
    expect(before).toContain("有效至");

    await service.decide("u1", approvalId!, true);
    await service.consume("u1", "p1", "experiment");
    const after = contentOf(await tool.execute({ action: "status", projectId: "p1" }, ctx));
    expect(after).toContain("已消费");

    await seedApproval(repo, { uid: "u1", id: "expired-row", status: "pending", expiresAt: Date.now() - 1 });
    const withExpired = contentOf(await tool.execute({ action: "status", projectId: "p1" }, ctx));
    expect(withExpired).toContain("已过期");
  });
});

// ---------------------------------------------------------------------------
// REST surface: v2 serialization + decision error mapping
// ---------------------------------------------------------------------------

function buildApprovalApp(service: ResearchApprovalService) {
  const app = Fastify();
  app.addHook("onRequest", (req, _reply, done) => {
    const raw = req.headers["x-uid"];
    runWithRequestContext(
      { requestId: "test", uid: typeof raw === "string" ? raw : undefined, startedAt: Date.now() },
      done,
    );
  });
  registerAcademicRoutes(app, { academic: {} as AcademicService, approvals: service });
  return app;
}

const asUid = (uid: string) => ({ "x-uid": uid, "content-type": "application/json" });

describe("academic approval routes: v2 contract", () => {
 it("serializes the v2 fields on create and list", async () => {
    const repo = new MemoryResearchApprovalRepository();
    const service = new ResearchApprovalService(repo);
    const app = buildApprovalApp(service);

    const created = await app.inject({
      method: "POST",
      url: "/academic/projects/p1/approvals",
      headers: asUid("1"),
      payload: { kind: "experiment", scope: "experiment", ttlMs: 120_000, note: "train" },
    });
    expect(created.statusCode).toBe(200);
    const body = created.json() as ResearchApproval;
    expect(body.scope).toBe("experiment");
    expect(body.requestedBy).toBe("user");
    expect(body.expiresAt).toBe(body.requestedAt + 120_000);
    expect(body.consumedAt).toBeUndefined();
    expect(body.experimentId).toBeUndefined();

    const listed = await app.inject({
      method: "GET",
      url: "/academic/projects/p1/approvals",
      headers: asUid("1"),
    });
    expect(listed.statusCode).toBe(200);
    const rows = listed.json() as ResearchApproval[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(body.id);
    expect(rows[0]?.scope).toBe("experiment");
    expect(rows[0]?.expiresAt).toBe(body.expiresAt);
    await app.close();
  });

 it("maps an expired decision to 409 {detail} instead of 500", async () => {
    const repo = new MemoryResearchApprovalRepository();
    const service = new ResearchApprovalService(repo);
    const expired = await seedApproval(repo, {
      uid: "1",
      status: "pending",
      expiresAt: Date.now() - 1,
    });
    const app = buildApprovalApp(service);

    const res = await app.inject({
      method: "POST",
      url: "/academic/approvals/" + expired.id + "/decision",
      headers: asUid("1"),
      payload: { approved: true },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { detail: string }).detail).toContain("已过期");
    await app.close();
  });

 it("maps a foreign decision to 404 and an invalid body to 422", async () => {
    const repo = new MemoryResearchApprovalRepository();
    const service = new ResearchApprovalService(repo);
    const pending = await service.request("2", "p1", "experiment");
    const app = buildApprovalApp(service);

    const foreign = await app.inject({
      method: "POST",
      url: "/academic/approvals/" + pending.id + "/decision",
      headers: asUid("1"),
      payload: { approved: true },
    });
    expect(foreign.statusCode).toBe(404);
    expect((foreign.json() as { detail: string }).detail).toContain("不存在或无权访问");

    const invalid = await app.inject({
      method: "POST",
      url: "/academic/approvals/" + pending.id + "/decision",
      headers: asUid("1"),
      payload: { approved: "yes" },
    });
    expect(invalid.statusCode).toBe(422);
    await app.close();
  });
});
