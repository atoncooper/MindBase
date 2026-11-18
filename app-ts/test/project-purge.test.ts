import { describe, expect, it } from "vitest";
import { PlanRunEngine } from "../src/agent/dag/state.js";
import type { PlanGraph } from "../src/agent/dag/types.js";
import type { AcademicLiteratureEntry, AcademicProject } from "../src/repository/academic.js";
import { MemoryAcademicStore } from "../src/repository/memory/academic.js";
import { MemoryAcademicEvidenceStore } from "../src/repository/memory/academic-evidence.js";
import { MemoryAcademicNotificationRepository } from "../src/repository/memory/academic-notifications.js";
import { MemoryPlanRunRepository } from "../src/repository/memory/plan-runs.js";
import { MemoryResearchApprovalRepository } from "../src/repository/memory/research-approvals.js";
import { MemoryResearchAutopilotRepository } from "../src/repository/memory/research-autopilot.js";
import { MemoryResearchDocumentRevisionRepository } from "../src/repository/memory/research-document-revisions.js";
import { MemoryResearchExperimentRepository } from "../src/repository/memory/research-experiments.js";
import { MemoryResearchWorkspaceRepository } from "../src/repository/memory/research-workspaces.js";
import {
  ProjectPurgeError,
  ProjectPurgeService,
  type ProjectPurgeDeps,
} from "../src/services/research/project-purge.js";

/** Empty plan graph: the purge tests only need a persisted run row. */
const GRAPH: PlanGraph = { version: 1, goal: "purge", agents: [], nodes: [] };

const FOLDERS = { plan: 1, literature: 2, data: 3, code: 4, results: 5, manuscript: 6, submission: 7 };

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return prefix + "-" + seq;
}

/** All memory repositories wired into the purge service (no Mongo/HTTP). */
function setup() {
  const store = new MemoryAcademicStore();
  const evidence = new MemoryAcademicEvidenceStore();
  const approvals = new MemoryResearchApprovalRepository();
  const experiments = new MemoryResearchExperimentRepository();
  const revisions = new MemoryResearchDocumentRevisionRepository();
  const notifications = new MemoryAcademicNotificationRepository();
  const autopilot = new MemoryResearchAutopilotRepository();
  const planRuns = new MemoryPlanRunRepository();
  const workspaces = new MemoryResearchWorkspaceRepository();
  const released: Array<{ uid: string; projectId: string }> = [];
  const deps: ProjectPurgeDeps = {
    projects: store,
    literature: store,
    documents: store,
    events: store,
    evidence,
    approvals,
    experiments,
    revisions,
    notifications,
    autopilot,
    planRuns,
    workspaces,
    sandboxLeases: {
      releaseProject: async (uid, projectId) => {
        released.push({ uid, projectId });
        return 1;
      },
    },
  };
  return {
    store,
    evidence,
    approvals,
    experiments,
    revisions,
    notifications,
    autopilot,
    planRuns,
    workspaces,
    released,
    service: new ProjectPurgeService(deps),
  };
}

type Fixture = ReturnType<typeof setup>;

/**
 * Seeds one full child set for (uid, projectId): notifications 2, approvals 1,
 * experiments 1, evidence 1 dataset + 2 runs, revisions 1, literature 2,
 * documents 1, events 2, workspaces 1, autopilot 1, plan runs 1.
 */
async function seedChildren(f: Fixture, uid: string, projectId: string, tag: string): Promise<void> {
  const now = Date.now();
  await f.store.add(uid, projectId, { title: "论文A " + tag });
  await f.store.add(uid, projectId, { title: "论文B " + tag });
  await f.store.createDocument(uid, projectId, { kind: "draft", title: "初稿 " + tag });
  await f.store.append(uid, projectId, "project.created");
  await f.store.append(uid, projectId, "literature.imported");
  await f.evidence.addDataset(uid, projectId, { name: "数据 " + tag });
  await f.evidence.recordRun(uid, projectId, { name: "run-a " + tag, language: "python" });
  await f.evidence.recordRun(uid, projectId, { name: "run-b " + tag, language: "python" });
  await f.approvals.create({
    id: nextId("approval"),
    uid,
    projectId,
    kind: "experiment",
    status: "pending",
    requestedAt: now,
  });
  await f.experiments.create({
    id: nextId("exp"),
    uid,
    projectId,
    language: "python",
    code: "print(1)",
    timeoutMs: 1000,
    status: "queued",
    createdAt: now,
  });
  await f.revisions.create({
    id: nextId("revision"),
    uid,
    projectId,
    documentId: "doc-" + tag,
    version: 1,
    title: "初稿 " + tag,
    sections: [],
    createdAt: now,
  });
  await f.notifications.create({
    id: nextId("notification"),
    uid,
    projectId,
    type: "experiment",
    title: "实验完成 " + tag,
    createdAt: now,
  });
  await f.notifications.create({
    id: nextId("notification"),
    uid,
    projectId,
    type: "plan",
    title: "计划待办 " + tag,
    createdAt: now,
  });
  await f.autopilot.save({
    uid,
    projectId,
    mode: "assist",
    maxActionsPerDay: 10,
    actionsToday: 0,
    day: "2026-01-01",
    updatedAt: now,
  });
  await new PlanRunEngine(f.planRuns).create({
    graph: GRAPH,
    chatSessionId: "session-" + tag,
    uid,
    projectId,
  });
  await f.workspaces.create({
    workspaceId: nextId("workspace"),
    uid,
    title: "空间 " + tag,
    rootFolderId: 1,
    projects: [{ projectId, title: "项目 " + tag, rootFolderId: 2, folders: { ...FOLDERS } }],
    createdAt: now,
    updatedAt: now,
  });
}

/** Minimal project row for stub deps (the real store owns the CRUD semantics). */
const STUB_PROJECT = { id: "p1" } as unknown as AcademicProject;

describe("ProjectPurgeService", () => {
  it("deletes every child collection, then the project row, and reports counts", async () => {
    const f = setup();
    const project = await f.store.create("u1", { title: "主项目" });
    await seedChildren(f, "u1", project.id, "primary");
    // Decoys: another project of the same user, and the same projectId under another uid.
    const sibling = await f.store.create("u1", { title: "另一个项目" });
    await seedChildren(f, "u1", sibling.id, "sibling");
    await seedChildren(f, "u2", project.id, "foreign-uid");

    const result = await f.service.purge("u1", project.id);
    expect(result).toEqual({
      deleted: true,
      counts: {
        notifications: 2,
        approvals: 1,
        experiments: 1,
        evidence: { datasets: 1, runs: 2 },
        revisions: 1,
        literature: 2,
        documents: 1,
        events: 2,
        workspaces: 1,
        autopilot: 1,
        planRuns: 1,
        project: 1,
      },
    });

    // Primary project rows are gone from every collection.
    expect(await f.store.get("u1", project.id)).toBeNull();
    expect(await f.store.list("u1", project.id)).toEqual([]);
    expect(await f.store.listDocuments("u1", project.id)).toEqual([]);
    expect(await f.store.listEvents("u1", project.id)).toEqual([]);
    expect(await f.evidence.listDatasets("u1", project.id)).toEqual([]);
    expect(await f.evidence.listRuns("u1", project.id)).toEqual([]);
    expect(await f.approvals.listByProject("u1", project.id)).toEqual([]);
    expect(await f.experiments.listByUid("u1", project.id)).toEqual([]);
    expect(await f.revisions.listByDocument("u1", project.id, "doc-primary")).toEqual([]);
    // Notifications are uid-scoped: only the purged project's rows are gone.
    expect((await f.notifications.listByUid("u1")).every((row) => row.projectId === sibling.id)).toBe(true);
    expect(await f.autopilot.get("u1", project.id)).toBeUndefined();
    expect(await f.planRuns.listByUid("u1", 100, undefined, project.id)).toEqual([]);
    expect(await f.workspaces.getByProject("u1", project.id)).toBeUndefined();

    // The sibling project is untouched.
    expect(await f.store.get("u1", sibling.id)).not.toBeNull();
    expect(await f.store.list("u1", sibling.id)).toHaveLength(2);
    expect(await f.store.listEvents("u1", sibling.id)).toHaveLength(2);
    expect(await f.evidence.listDatasets("u1", sibling.id)).toHaveLength(1);
    expect(await f.approvals.listByProject("u1", sibling.id)).toHaveLength(1);

    // Child rows with the same projectId under another uid are untouched (tenant isolation).
    expect(await f.store.list("u2", project.id)).toHaveLength(2);
    expect(await f.store.listDocuments("u2", project.id)).toHaveLength(1);
    expect(await f.store.listEvents("u2", project.id)).toHaveLength(2);
    expect(await f.evidence.listDatasets("u2", project.id)).toHaveLength(1);
    expect(await f.evidence.listRuns("u2", project.id)).toHaveLength(2);
    expect(await f.approvals.listByProject("u2", project.id)).toHaveLength(1);
    expect(await f.experiments.listByUid("u2", project.id)).toHaveLength(1);
    expect(await f.revisions.listByDocument("u2", project.id, "doc-foreign-uid")).toHaveLength(1);
    expect(await f.notifications.listByUid("u2")).toHaveLength(2);
    expect(await f.autopilot.get("u2", project.id)).toBeDefined();
    expect(await f.planRuns.listByUid("u2", 100, undefined, project.id)).toHaveLength(1);
    expect(await f.workspaces.getByProject("u2", project.id)).toBeDefined();
  });

  it("runs the cascade in the documented order", async () => {
    const calls: string[] = [];
    const stub = (name: string) => ({
      removeByProject: async (): Promise<number> => {
        calls.push(name);
        return 0;
      },
    });
    const deps: ProjectPurgeDeps = {
      projects: {
        get: async () => STUB_PROJECT,
        remove: async () => {
          calls.push("project");
          return true;
        },
      },
      literature: {
        list: async () => {
          calls.push("literature.list");
          return [{ id: "l1" } as unknown as AcademicLiteratureEntry];
        },
        remove: async () => {
          calls.push("literature.remove");
          return true;
        },
      },
      documents: {
        removeDocumentsByProject: async () => {
          calls.push("documents");
          return 0;
        },
      },
      events: {
        removeEventsByProject: async () => {
          calls.push("events");
          return 0;
        },
      },
      evidence: {
        removeByProject: async () => {
          calls.push("evidence");
          return { datasets: 0, runs: 0 };
        },
      },
      approvals: stub("approvals"),
      experiments: stub("experiments"),
      revisions: stub("revisions"),
      notifications: stub("notifications"),
      autopilot: stub("autopilot"),
      planRuns: stub("planRuns"),
      workspaces: stub("workspaces"),
    };
    const service = new ProjectPurgeService(deps);
    await service.purge("u1", "p1");
    expect(calls).toEqual([
      "notifications",
      "approvals",
      "experiments",
      "evidence",
      "revisions",
      "literature.list",
      "literature.remove",
      "documents",
      "events",
      "workspaces",
      "autopilot",
      "planRuns",
      "project",
    ]);
  });

  it("answers 404 for a missing or foreign project and deletes nothing", async () => {
    const f = setup();
    const missing = await f.service.purge("u1", "missing-project").catch((err) => err);
    expect(missing).toMatchObject({ status: 404 });

    const foreign = await f.store.create("u2", { title: "别人的项目" });
    await seedChildren(f, "u2", foreign.id, "foreign");
    const denied = await f.service.purge("u1", foreign.id).catch((err) => err);
    expect(denied).toMatchObject({ status: 404 });
    expect(await f.store.get("u2", foreign.id)).not.toBeNull();
    expect(await f.store.list("u2", foreign.id)).toHaveLength(2);
  });

  it("purges an empty project with all-zero counts", async () => {
    const f = setup();
    const project = await f.store.create("u1", { title: "空项目" });
    const result = await f.service.purge("u1", project.id);
    expect(result.deleted).toBe(true);
    expect(result.counts).toEqual({
      notifications: 0,
      approvals: 0,
      experiments: 0,
      evidence: { datasets: 0, runs: 0 },
      revisions: 0,
      literature: 0,
      documents: 0,
      events: 0,
      workspaces: 0,
      autopilot: 0,
      planRuns: 0,
      project: 1,
    });
    expect(await f.store.get("u1", project.id)).toBeNull();
  });

  it("keeps the counts already applied when a step fails", async () => {
    const calls: string[] = [];
    const stub = (name: string, count: number) => ({
      removeByProject: async (): Promise<number> => {
        calls.push(name);
        return count;
      },
    });
    const deps: ProjectPurgeDeps = {
      projects: {
        get: async () => STUB_PROJECT,
        remove: async () => {
          calls.push("project");
          return true;
        },
      },
      literature: {
        list: async () => [],
        remove: async () => true,
      },
      documents: {
        removeDocumentsByProject: async () => 0,
      },
      events: {
        removeEventsByProject: async () => 0,
      },
      evidence: {
        removeByProject: async () => {
          calls.push("evidence");
          return { datasets: 0, runs: 0 };
        },
      },
      approvals: stub("approvals", 2),
      experiments: {
        removeByProject: async () => {
          calls.push("experiments");
          throw new Error("mongo down");
        },
      },
      revisions: stub("revisions", 0),
      notifications: stub("notifications", 3),
      autopilot: stub("autopilot", 0),
      planRuns: stub("planRuns", 0),
      workspaces: stub("workspaces", 0),
    };
    const service = new ProjectPurgeService(deps);
    const err = (await service.purge("u1", "p1").catch((cause) => cause)) as ProjectPurgeError;
    expect(err).toBeInstanceOf(ProjectPurgeError);
    expect(err.status).toBe(500);
    expect(err.message).toContain("项目删除失败");
    expect(err.message).toContain("mongo down");
    expect(err.partialCounts).toEqual({
      notifications: 3,
      approvals: 2,
      experiments: 0,
      evidence: { datasets: 0, runs: 0 },
      revisions: 0,
      literature: 0,
      documents: 0,
      events: 0,
      workspaces: 0,
      autopilot: 0,
      planRuns: 0,
      project: 0,
    });
    expect(calls).not.toContain("project");
  });
});

describe("memory removeByProject tenant scoping", () => {
  it("approvals delete only the uid + project rows", async () => {
    const repo = new MemoryResearchApprovalRepository();
    const base = { kind: "experiment" as const, status: "pending" as const, requestedAt: 1 };
    await repo.create({ id: "a1", uid: "u1", projectId: "p1", ...base });
    await repo.create({ id: "a2", uid: "u2", projectId: "p1", ...base });
    await repo.create({ id: "a3", uid: "u1", projectId: "p2", ...base });
    expect(await repo.removeByProject("u1", "p1")).toBe(1);
    expect(await repo.listByProject("u2", "p1")).toHaveLength(1);
    expect(await repo.listByProject("u1", "p2")).toHaveLength(1);
  });

  it("experiments delete only the uid + project rows", async () => {
    const repo = new MemoryResearchExperimentRepository();
    const run = (id: string, uid: string, projectId: string) => ({
      id,
      uid,
      projectId,
      language: "python",
      code: "print(1)",
      timeoutMs: 1000,
      status: "queued" as const,
      createdAt: 1,
    });
    await repo.create(run("e1", "u1", "p1"));
    await repo.create(run("e2", "u2", "p1"));
    await repo.create(run("e3", "u1", "p2"));
    expect(await repo.removeByProject("u1", "p1")).toBe(1);
    expect(await repo.listByUid("u2", "p1")).toHaveLength(1);
    expect(await repo.listByUid("u1", "p2")).toHaveLength(1);
  });

  it("document revisions delete only the uid + project rows", async () => {
    const repo = new MemoryResearchDocumentRevisionRepository();
    const revision = (id: string, uid: string, projectId: string) => ({
      id,
      uid,
      projectId,
      documentId: "d1",
      version: 1,
      title: "t",
      sections: [],
      createdAt: 1,
    });
    await repo.create(revision("r1", "u1", "p1"));
    await repo.create(revision("r2", "u2", "p1"));
    await repo.create(revision("r3", "u1", "p2"));
    expect(await repo.removeByProject("u1", "p1")).toBe(1);
    expect(await repo.listByDocument("u2", "p1", "d1")).toHaveLength(1);
    expect(await repo.listByDocument("u1", "p2", "d1")).toHaveLength(1);
  });

  it("notifications delete only the uid + project rows", async () => {
    const repo = new MemoryAcademicNotificationRepository();
    await repo.create({ id: "n1", uid: "u1", projectId: "p1", type: "plan", title: "t", createdAt: 1 });
    await repo.create({ id: "n2", uid: "u2", projectId: "p1", type: "plan", title: "t", createdAt: 1 });
    await repo.create({ id: "n3", uid: "u1", projectId: "p2", type: "plan", title: "t", createdAt: 1 });
    expect(await repo.removeByProject("u1", "p1")).toBe(1);
    expect(await repo.listByUid("u2")).toHaveLength(1);
    expect(await repo.listByUid("u1")).toHaveLength(1);
  });

  it("autopilot deletes only the uid + project row", async () => {
    const repo = new MemoryResearchAutopilotRepository();
    const row = (uid: string, projectId: string) => ({
      uid,
      projectId,
      mode: "assist" as const,
      maxActionsPerDay: 10,
      actionsToday: 0,
      day: "2026-01-01",
      updatedAt: 1,
    });
    await repo.save(row("u1", "p1"));
    await repo.save(row("u2", "p1"));
    await repo.save(row("u1", "p2"));
    expect(await repo.removeByProject("u1", "p1")).toBe(1);
    expect(await repo.get("u2", "p1")).toBeDefined();
    expect(await repo.get("u1", "p2")).toBeDefined();
  });

  it("plan runs delete only the uid + project rows", async () => {
    const repo = new MemoryPlanRunRepository();
    const engine = new PlanRunEngine(repo);
    await engine.create({ graph: GRAPH, chatSessionId: "s1", uid: "u1", projectId: "p1" });
    await engine.create({ graph: GRAPH, chatSessionId: "s2", uid: "u2", projectId: "p1" });
    await engine.create({ graph: GRAPH, chatSessionId: "s3", uid: "u1", projectId: "p2" });
    expect(await repo.removeByProject("u1", "p1")).toBe(1);
    expect(await repo.listByUid("u2", 10, undefined, "p1")).toHaveLength(1);
    expect(await repo.listByUid("u1", 10, undefined, "p2")).toHaveLength(1);
  });

  it("workspaces drop the project mapping and keep the row while other projects remain", async () => {
    const repo = new MemoryResearchWorkspaceRepository();
    const project = (projectId: string) => ({
      projectId,
      title: projectId,
      rootFolderId: 2,
      folders: { ...FOLDERS },
    });
    await repo.create({
      workspaceId: "w1",
      uid: "u1",
      title: "w1",
      rootFolderId: 1,
      projects: [project("p1")],
      createdAt: 1,
      updatedAt: 1,
    });
    await repo.create({
      workspaceId: "w2",
      uid: "u1",
      title: "w2",
      rootFolderId: 1,
      projects: [project("p1"), project("p2")],
      createdAt: 1,
      updatedAt: 1,
    });
    await repo.create({
      workspaceId: "w3",
      uid: "u2",
      title: "w3",
      rootFolderId: 1,
      projects: [project("p1")],
      createdAt: 1,
      updatedAt: 1,
    });
    expect(await repo.removeByProject("u1", "p1")).toBe(2);
    expect(await repo.get("w1")).toBeUndefined();
    expect((await repo.get("w2"))?.projects.map((item) => item.projectId)).toEqual(["p2"]);
    expect((await repo.get("w3"))?.projects.map((item) => item.projectId)).toEqual(["p1"]);
  });

  it("evidence reports per-kind counts and keeps other tenants", async () => {
    const repo = new MemoryAcademicEvidenceStore();
    await repo.addDataset("u1", "p1", { name: "d1" });
    await repo.addDataset("u2", "p1", { name: "d2" });
    await repo.recordRun("u1", "p1", { name: "r1", language: "python" });
    await repo.recordRun("u1", "p1", { name: "r2", language: "python" });
    await repo.recordRun("u1", "p2", { name: "r3", language: "python" });
    await repo.recordRun("u2", "p1", { name: "r4", language: "python" });
    expect(await repo.removeByProject("u1", "p1")).toEqual({ datasets: 1, runs: 2 });
    expect(await repo.listDatasets("u2", "p1")).toHaveLength(1);
    expect(await repo.listRuns("u2", "p1")).toHaveLength(1);
    expect(await repo.listRuns("u1", "p2")).toHaveLength(1);
  });
});
