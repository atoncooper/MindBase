import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { ResultCollector, type ToolRunContext } from "../src/context/types.js";
import {
  ACADEMIC_EVIDENCE_ARTIFACT_KIND,
  ACADEMIC_MAX_PREVIEW_CHARS,
  ACADEMIC_MAX_SCRIPT_CHARS,
  ACADEMIC_RUN_LIST_DEFAULT_LIMIT,
  ACADEMIC_RUN_LIST_MAX_LIMIT,
  ACADEMIC_RUN_STATUSES,
  ACADEMIC_RUN_STATUS_LABELS,
  buildAcademicDataset,
  buildAcademicRun,
  clipPreview,
  normalizeEvidenceFiles,
  runListWindow,
  scriptRecord,
  sha256Hex,
  type AcademicEvidenceFile,
} from "../src/repository/academic-evidence.js";
import {
  type AcademicActor,
  type AcademicEvent,
  type AcademicEventRepository,
} from "../src/repository/academic.js";
import { MemoryAcademicEvidenceStore } from "../src/repository/memory/academic-evidence.js";
import { MemoryAcademicStore } from "../src/repository/memory/academic.js";
import { createAcademicEvidenceTool } from "../src/tools/academic/evidence.js";

/**
 * Academic execution-evidence tests (plan/1.0.18 §10).
 *
 * Memory implementation + tool run fully offline. The Mongo adapter is exercised
 * when a local MongoDB (docker compose) is listening — same skip pattern as the
 * other mongo-*.test.ts files — and points at the dedicated test database so
 * mind_base_ts is never touched.
 */

// The Mongo adapter is imported dynamically in beforeAll so these env vars are in
// place before config/index.ts is evaluated (ESM hoists static imports).
if (!process.env.MONGO__URI) process.env.MONGO__URI = "mongodb://127.0.0.1:27017";
if (!process.env.MONGO__DATABASE) process.env.MONGO__DATABASE = "mind_base_ts_test";

function freshUid(): string {
  return "u-" + randomUUID();
}

function makeCtx(uid?: string): ToolRunContext {
  return { uid, scope: {}, collector: new ResultCollector() };
}

/** Tool output is either a plain string or { content, ... }; tests only need the text. */
function contentOf(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object" && "content" in output) {
    const content = (output as { content?: unknown }).content;
    return typeof content === "string" ? content : "";
  }
  return "";
}

/** All artifacts collected in one tool call (kind + typed data). */
function artifactsOf(ctx: ToolRunContext): { kind: string; data: Record<string, unknown> }[] {
  return ctx.collector.artifacts.map((artifact) => ({
    kind: artifact.kind,
    data: artifact.data as Record<string, unknown>,
  }));
}

/** Minimal event double so record_run can be asserted to append the audit event. */
class FakeEventRepository implements AcademicEventRepository {
  readonly events: AcademicEvent[] = [];

  async append(
    uid: string,
    projectId: string,
    type: string,
    payload: Record<string, unknown> = {},
    actor: AcademicActor = "agent",
  ): Promise<AcademicEvent> {
    const event: AcademicEvent = {
      id: randomUUID(),
      uid,
      projectId,
      type,
      payload,
      actor,
      createdAt: Date.now(),
    };
    this.events.push(event);
    return event;
  }

  async listEvents(uid: string, projectId: string, limit = 20): Promise<AcademicEvent[]> {
    return this.events
      .filter((event) => event.uid === uid && event.projectId === projectId)
      .slice(0, limit);
  }
}

interface ToolHarness {
  projects: MemoryAcademicStore;
  runs: MemoryAcademicEvidenceStore;
  events: FakeEventRepository;
  tool: ReturnType<typeof createAcademicEvidenceTool>;
}

function setup(): ToolHarness {
  const projects = new MemoryAcademicStore();
  const runs = new MemoryAcademicEvidenceStore();
  const events = new FakeEventRepository();
  const tool = createAcademicEvidenceTool({ runs, projects, events });
  return { projects, runs, events, tool };
}

async function seedProject(harness: ToolHarness, uid: string): Promise<string> {
  const project = await harness.projects.create(uid, { title: "图神经网络推荐研究" });
  return project.id;
}

// ---------------------------------------------------------------------------
// Contract helpers (single source of truth for both implementations)
// ---------------------------------------------------------------------------

describe("academic evidence contract helpers", () => {
  it("sha256Hex matches the standard vector and is deterministic", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("")).toBe(sha256Hex(""));
    expect(sha256Hex("a")).not.toBe(sha256Hex("b"));
  });

  it("scriptRecord hashes the full text and stores at most the bound", () => {
    expect(scriptRecord(undefined)).toEqual({});
    expect(scriptRecord("   ")).toEqual({});

    const short = "print('hello')";
    expect(scriptRecord(short)).toEqual({ script: short, scriptSha256: sha256Hex(short) });

    const long = "x".repeat(ACADEMIC_MAX_SCRIPT_CHARS + 500);
    const record = scriptRecord(long);
    expect(record.script).toHaveLength(ACADEMIC_MAX_SCRIPT_CHARS);
    expect(record.script).toBe(long.slice(0, ACADEMIC_MAX_SCRIPT_CHARS));
    expect(record.scriptSha256).toBe(sha256Hex(long));
  });

  it("clipPreview treats blank as absent and slices long text to the bound", () => {
    expect(clipPreview(undefined)).toBeUndefined();
    expect(clipPreview("")).toBeUndefined();
    expect(clipPreview("   ")).toBeUndefined();
    expect(clipPreview("ok")).toBe("ok");
    const long = "y".repeat(ACADEMIC_MAX_PREVIEW_CHARS + 100);
    expect(clipPreview(long)).toHaveLength(ACADEMIC_MAX_PREVIEW_CHARS);
    expect(clipPreview(long, 10)).toBe("y".repeat(10));
  });

  it("normalizeEvidenceFiles keeps metadata only and normalizes optional fields", () => {
    const files = normalizeEvidenceFiles([
      { name: "  data.csv ", sizeBytes: 10.9, sha256: " ABCDEF ", url: " https://example.com/a " },
      { name: "   " },
      { name: "no-meta.bin", content: "must not be copied" } as unknown as AcademicEvidenceFile,
    ]);
    expect(files).toHaveLength(2);
    expect(files[0]).toEqual({
      name: "data.csv",
      sizeBytes: 10,
      sha256: "abcdef",
      url: "https://example.com/a",
    });
    expect(files[1]).toEqual({ name: "no-meta.bin" });
    expect("content" in files[1]).toBe(false);
  });

  it("runListWindow applies default/clamped paging bounds", () => {
    expect(runListWindow()).toEqual({ limit: ACADEMIC_RUN_LIST_DEFAULT_LIMIT, offset: 0 });
    expect(runListWindow({ limit: 5, offset: 3 })).toEqual({ limit: 5, offset: 3 });
    expect(runListWindow({ limit: 0 })).toEqual({ limit: 1, offset: 0 });
    expect(runListWindow({ limit: 9999 })).toEqual({ limit: ACADEMIC_RUN_LIST_MAX_LIMIT, offset: 0 });
    expect(runListWindow({ limit: Number.NaN, offset: -5 })).toEqual({
      limit: ACADEMIC_RUN_LIST_DEFAULT_LIMIT,
      offset: 0,
    });
    expect(runListWindow({ limit: 4.9, offset: 2.9 })).toEqual({ limit: 4, offset: 2 });
  });

  it("buildAcademicRun applies defaults and bounded fields", () => {
    const run = buildAcademicRun({
      id: "run-1",
      uid: "u1",
      projectId: "p1",
      at: 1000,
      run: {
        name: "  基线训练  ",
        language: " python ",
        script: "print(1)",
        datasetId: "  ds-1 ",
        executionId: "  exec-1 ",
        exitCode: 0.9,
        cpuMillis: 12.8,
        stdoutPreview: "  ",
        artifacts: [{ name: "out.csv", sizeBytes: 5.7, sha256: "AB" }],
      },
    });
    expect(run.id).toBe("run-1");
    expect(run.name).toBe("基线训练");
    expect(run.language).toBe("python");
    expect(run.datasetId).toBe("ds-1");
    expect(run.executionId).toBe("exec-1");
    expect(run.status).toBe("recorded");
    expect(run.exitCode).toBe(0);
    expect(run.cpuMillis).toBe(12);
    expect(run.stdoutPreview).toBeUndefined();
    expect(run.script).toBe("print(1)");
    expect(run.scriptSha256).toBe(sha256Hex("print(1)"));
    expect(run.artifacts).toEqual([{ name: "out.csv", sizeBytes: 5, sha256: "ab" }]);
    expect(run.createdAt).toBe(1000);
  });

  it("buildAcademicDataset applies the manual-source default and sanitizes files", () => {
    const dataset = buildAcademicDataset({
      id: "ds-1",
      uid: "u1",
      projectId: "p1",
      at: 2000,
      dataset: { name: " 抽样数据 ", description: "  ", files: [{ name: "x.csv", sizeBytes: 3 }] },
    });
    expect(dataset).toEqual({
      id: "ds-1",
      uid: "u1",
      projectId: "p1",
      name: "抽样数据",
      source: "manual",
      files: [{ name: "x.csv", sizeBytes: 3 }],
      createdAt: 2000,
    });
  });

  it("run status labels are Chinese product strings", () => {
    expect(Object.keys(ACADEMIC_RUN_STATUS_LABELS).sort()).toEqual([...ACADEMIC_RUN_STATUSES].sort());
    expect(ACADEMIC_RUN_STATUS_LABELS.succeeded).toBe("成功");
    expect(ACADEMIC_RUN_STATUS_LABELS.failed).toBe("失败");
    expect(ACADEMIC_RUN_STATUS_LABELS.timed_out).toBe("超时");
    expect(ACADEMIC_RUN_STATUS_LABELS.recorded).toBe("已记录");
  });
});

// ---------------------------------------------------------------------------
// Memory implementation
// ---------------------------------------------------------------------------

describe("MemoryAcademicEvidenceStore · datasets", () => {
  it("addDataset fills defaults and listDatasets reads it back as a copy", async () => {
    const store = new MemoryAcademicEvidenceStore();
    const uid = freshUid();
    const dataset = await store.addDataset(uid, "p1", { name: "抽样数据" });

    expect(dataset.id).toMatch(/^[0-9a-f]{8}-/);
    expect(dataset.uid).toBe(uid);
    expect(dataset.projectId).toBe("p1");
    expect(dataset.name).toBe("抽样数据");
    expect(dataset.source).toBe("manual");
    expect(dataset.files).toEqual([]);
    expect(dataset.createdAt).toBeGreaterThan(0);

    const listed = await store.listDatasets(uid, "p1");
    expect(listed).toHaveLength(1);
    listed[0].files.push({ name: "injected" });
    listed[0].name = "被篡改";
    const again = await store.listDatasets(uid, "p1");
    expect(again[0].name).toBe("抽样数据");
    expect(again[0].files).toEqual([]);
  });

  it("addDataset keeps explicit metadata and sanitizes files", async () => {
    const store = new MemoryAcademicEvidenceStore();
    const uid = freshUid();
    const dataset = await store.addDataset(uid, "p1", {
      name: "  外部数据  ",
      description: "来自公开数据集",
      source: "upload",
      files: [
        { name: "train.csv", sizeBytes: 1234.7, sha256: " ABC ", url: " https://example.com/t " },
        { name: "" },
      ],
    });
    expect(dataset.name).toBe("外部数据");
    expect(dataset.description).toBe("来自公开数据集");
    expect(dataset.source).toBe("upload");
    expect(dataset.files).toEqual([
      { name: "train.csv", sizeBytes: 1234, sha256: "abc", url: "https://example.com/t" },
    ]);
  });

  it("listDatasets is uid+project scoped and newest first", async () => {
    const store = new MemoryAcademicEvidenceStore();
    const uid = freshUid();
    const first = await store.addDataset(uid, "p1", { name: "第一份" });
    const second = await store.addDataset(uid, "p1", { name: "第二份" });
    await store.addDataset(freshUid(), "p1", { name: "别人的" });
    await store.addDataset(uid, "p2", { name: "别的项目" });

    expect((await store.listDatasets(uid, "p1")).map((dataset) => dataset.id)).toEqual([
      second.id,
      first.id,
    ]);
    expect((await store.listDatasets(uid, "p2")).map((dataset) => dataset.name)).toEqual(["别的项目"]);
    expect(await store.listDatasets(uid, "missing")).toEqual([]);
  });
});

describe("MemoryAcademicEvidenceStore · runs", () => {
  it("recordRun stores defaults when only name/language are given", async () => {
    const store = new MemoryAcademicEvidenceStore();
    const uid = freshUid();
    const run = await store.recordRun(uid, "p1", { name: "基线训练", language: "python" });

    expect(run.id).toMatch(/^[0-9a-f]{8}-/);
    expect(run.uid).toBe(uid);
    expect(run.projectId).toBe("p1");
    expect(run.name).toBe("基线训练");
    expect(run.language).toBe("python");
    expect(run.status).toBe("recorded");
    expect(run.artifacts).toEqual([]);
    expect(run.script).toBeUndefined();
    expect(run.scriptSha256).toBeUndefined();
    expect(run.exitCode).toBeUndefined();
    expect(run.createdAt).toBeGreaterThan(0);
  });

  it("recordRun truncates the script body but hashes the full text", async () => {
    const store = new MemoryAcademicEvidenceStore();
    const uid = freshUid();
    const script = "z".repeat(ACADEMIC_MAX_SCRIPT_CHARS + 321);
    const run = await store.recordRun(uid, "p1", { name: "长脚本", language: "python", script });

    expect(run.script).toHaveLength(ACADEMIC_MAX_SCRIPT_CHARS);
    expect(run.script).toBe(script.slice(0, ACADEMIC_MAX_SCRIPT_CHARS));
    expect(run.scriptSha256).toBe(sha256Hex(script));
  });

  it("recordRun bounds previews and drops blank ones", async () => {
    const store = new MemoryAcademicEvidenceStore();
    const uid = freshUid();
    const longOutput = "o".repeat(ACADEMIC_MAX_PREVIEW_CHARS + 250);
    const run = await store.recordRun(uid, "p1", {
      name: "输出截断",
      language: "python",
      stdoutPreview: longOutput,
      stderrPreview: "   ",
    });
    expect(run.stdoutPreview).toHaveLength(ACADEMIC_MAX_PREVIEW_CHARS);
    expect(run.stderrPreview).toBeUndefined();
  });

  it("recordRun keeps explicit status/exitCode/execution/dataset/artifacts metadata", async () => {
    const store = new MemoryAcademicEvidenceStore();
    const uid = freshUid();
    const run = await store.recordRun(uid, "p1", {
      name: "超时运行",
      language: "javascript",
      datasetId: "ds-1",
      executionId: "exec-9",
      status: "timed_out",
      exitCode: 124,
      startedAt: 100,
      finishedAt: 200,
      artifacts: [{ name: "log.txt", sizeBytes: 9, sha256: "DEAD" }],
    });
    expect(run.status).toBe("timed_out");
    expect(run.exitCode).toBe(124);
    expect(run.datasetId).toBe("ds-1");
    expect(run.executionId).toBe("exec-9");
    expect(run.startedAt).toBe(100);
    expect(run.finishedAt).toBe(200);
    expect(run.artifacts).toEqual([{ name: "log.txt", sizeBytes: 9, sha256: "dead" }]);
  });

  it("listRuns is newest-first with default/clamped paging", async () => {
    const store = new MemoryAcademicEvidenceStore();
    const uid = freshUid();
    for (let i = 0; i < 25; i += 1) {
      await store.recordRun(uid, "p1", { name: "run-" + i, language: "python" });
    }
    await store.recordRun(freshUid(), "p1", { name: "other-user", language: "python" });
    await store.recordRun(uid, "p2", { name: "other-project", language: "python" });

    const page = await store.listRuns(uid, "p1");
    expect(page).toHaveLength(ACADEMIC_RUN_LIST_DEFAULT_LIMIT);
    expect(page[0].name).toBe("run-24");
    expect(page[page.length - 1].name).toBe("run-5");

    const windowed = await store.listRuns(uid, "p1", { limit: 5, offset: 3 });
    expect(windowed.map((run) => run.name)).toEqual(["run-21", "run-20", "run-19", "run-18", "run-17"]);

    expect(await store.listRuns(uid, "missing")).toEqual([]);
  });

  it("getRun is uid AND project scoped", async () => {
    const store = new MemoryAcademicEvidenceStore();
    const uid = freshUid();
    const run = await store.recordRun(uid, "p1", { name: "隔离", language: "python" });

    expect((await store.getRun(uid, "p1", run.id))?.name).toBe("隔离");
    expect(await store.getRun(freshUid(), "p1", run.id)).toBeNull();
    expect(await store.getRun(uid, "p2", run.id)).toBeNull();
    expect(await store.getRun(uid, "p1", "missing")).toBeNull();
  });

  it("reads are deep copies", async () => {
    const store = new MemoryAcademicEvidenceStore();
    const uid = freshUid();
    const run = await store.recordRun(uid, "p1", {
      name: "深拷贝",
      language: "python",
      artifacts: [{ name: "a.csv", sizeBytes: 1 }],
    });
    run.artifacts.push({ name: "injected" });
    run.name = "被篡改";
    const again = await store.getRun(uid, "p1", run.id);
    expect(again?.name).toBe("深拷贝");
    expect(again?.artifacts).toEqual([{ name: "a.csv", sizeBytes: 1 }]);
  });
});

// ---------------------------------------------------------------------------
// academic_evidence tool
// ---------------------------------------------------------------------------

describe("academic_evidence tool", () => {
  it("refuses every action without a uid and never writes", async () => {
    const harness = setup();
    const project = await harness.projects.create("owner", { title: "别人的项目" });
    const ctx = makeCtx();

    const output = contentOf(
      await harness.tool.execute({ action: "add_dataset", projectId: project.id, name: "x" }, ctx),
    );
    expect(output).toContain("没有用户身份");
    expect(await harness.runs.listDatasets("owner", project.id)).toEqual([]);
  });

  it("requires projectId and rejects foreign projects without writing", async () => {
    const harness = setup();
    const uid = freshUid();
    const owner = freshUid();
    const foreign = await harness.projects.create(owner, { title: "他人的项目" });
    const ctx = makeCtx(uid);

    const missing = contentOf(await harness.tool.execute({ action: "list_datasets" }, ctx));
    expect(missing).toContain("缺少 project_id");

    const crossed = contentOf(
      await harness.tool.execute({ action: "add_dataset", projectId: foreign.id, name: "入侵" }, ctx),
    );
    expect(crossed).toContain("项目不存在或无权访问");
    expect(await harness.runs.listDatasets(owner, foreign.id)).toEqual([]);
  });

  it("add_dataset registers metadata and pushes an academic_evidence artifact", async () => {
    const harness = setup();
    const uid = freshUid();
    const projectId = await seedProject(harness, uid);
    const ctx = makeCtx(uid);

    const output = contentOf(
      await harness.tool.execute(
        {
          action: "add_dataset",
          projectId,
          name: "  实验一 抽样数据 ",
          description: "从 1 万条记录中抽样",
          source: "upload",
          files: [{ name: "sample.csv", sizeBytes: 2048, sha256: "AB" }],
        },
        ctx,
      ),
    );
    expect(output).toContain("已登记数据集");
    expect(output).toContain("实验一 抽样数据");
    expect(output).toContain("dataset_id");
    expect(output).toContain("upload");

    const datasets = await harness.runs.listDatasets(uid, projectId);
    expect(datasets).toHaveLength(1);
    expect(datasets[0].files).toEqual([{ name: "sample.csv", sizeBytes: 2048, sha256: "ab" }]);

    const artifacts = artifactsOf(ctx);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].kind).toBe(ACADEMIC_EVIDENCE_ARTIFACT_KIND);
    expect(artifacts[0].data.action).toBe("add_dataset");
    expect((artifacts[0].data.dataset as { name: string }).name).toBe("实验一 抽样数据");
  });

  it("add_dataset needs a name", async () => {
    const harness = setup();
    const uid = freshUid();
    const projectId = await seedProject(harness, uid);
    const output = contentOf(await harness.tool.execute({ action: "add_dataset", projectId }, makeCtx(uid)));
    expect(output).toContain("需要 name");
  });

  it("list_datasets reports counts and entries", async () => {
    const harness = setup();
    const uid = freshUid();
    const projectId = await seedProject(harness, uid);
    const ctx = makeCtx(uid);
    await harness.tool.execute({ action: "add_dataset", projectId, name: "数据集 A" }, makeCtx(uid));
    await harness.tool.execute({ action: "add_dataset", projectId, name: "数据集 B" }, makeCtx(uid));

    const output = contentOf(await harness.tool.execute({ action: "list_datasets", projectId }, ctx));
    expect(output).toContain("共有 2 个数据集");
    expect(output).toContain("数据集 A");
    expect(output).toContain("数据集 B");

    const artifact = artifactsOf(ctx).pop();
    expect(artifact?.kind).toBe(ACADEMIC_EVIDENCE_ARTIFACT_KIND);
    expect(artifact?.data.action).toBe("list_datasets");
    expect(artifact?.data.total).toBe(2);
  });

  it("list_datasets degrades to guidance when the project has none", async () => {
    const harness = setup();
    const uid = freshUid();
    const projectId = await seedProject(harness, uid);
    const output = contentOf(await harness.tool.execute({ action: "list_datasets", projectId }, makeCtx(uid)));
    expect(output).toContain("还没有登记数据集");
  });

  it("record_run infers status from exitCode and appends the audit event", async () => {
    const harness = setup();
    const uid = freshUid();
    const projectId = await seedProject(harness, uid);
    const ctx = makeCtx(uid);

    const output = contentOf(
      await harness.tool.execute(
        {
          action: "record_run",
          projectId,
          name: "基线训练",
          language: "python",
          script: "print(0)",
          executionId: "exec-1",
          exitCode: 0,
          stdoutPreview: "done",
          artifacts: [{ name: "result.csv", sizeBytes: 10, sha256: "AB" }],
        },
        ctx,
      ),
    );
    expect(output).toContain("已记录运行");
    expect(output).toContain("成功");
    expect(output).toContain("exec-1");

    const runs = await harness.runs.listRuns(uid, projectId);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("succeeded");
    expect(runs[0].artifacts).toEqual([{ name: "result.csv", sizeBytes: 10, sha256: "ab" }]);
    expect(runs[0].scriptSha256).toBe(sha256Hex("print(0)"));

    const events = harness.events.events;
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("academic.run_recorded");
    expect(events[0].uid).toBe(uid);
    expect(events[0].projectId).toBe(projectId);
    expect(events[0].payload).toMatchObject({
      runId: runs[0].id,
      name: "基线训练",
      language: "python",
      status: "succeeded",
      executionId: "exec-1",
      exitCode: 0,
      artifactCount: 1,
    });

    const artifact = artifactsOf(ctx).pop();
    expect(artifact?.kind).toBe(ACADEMIC_EVIDENCE_ARTIFACT_KIND);
    expect(artifact?.data.action).toBe("record_run");
  });

  it("record_run status inference: failed / recorded / explicit timed_out", async () => {
    const harness = setup();
    const uid = freshUid();
    const projectId = await seedProject(harness, uid);
    const ctx = makeCtx(uid);

    await harness.tool.execute(
      { action: "record_run", projectId, name: "失败运行", language: "python", exitCode: 2 },
      ctx,
    );
    await harness.tool.execute(
      { action: "record_run", projectId, name: "仅记录", language: "python" },
      ctx,
    );
    const timeoutText = contentOf(
      await harness.tool.execute(
        { action: "record_run", projectId, name: "超时运行", language: "python", status: "timed_out" },
        ctx,
      ),
    );
    expect(timeoutText).toContain("超时");

    const runs = await harness.runs.listRuns(uid, projectId);
    expect(runs.map((run) => run.status)).toEqual(["timed_out", "recorded", "failed"]);
  });

  it("record_run truncates a long script and mentions its digest, not the body", async () => {
    const harness = setup();
    const uid = freshUid();
    const projectId = await seedProject(harness, uid);
    const script = "s".repeat(ACADEMIC_MAX_SCRIPT_CHARS + 1000);

    const output = contentOf(
      await harness.tool.execute(
        { action: "record_run", projectId, name: "长脚本", language: "python", script },
        makeCtx(uid),
      ),
    );
    expect(output).toContain("sha256=");
    expect(output).not.toContain(script);

    const run = (await harness.runs.listRuns(uid, projectId))[0];
    expect(run.script).toHaveLength(ACADEMIC_MAX_SCRIPT_CHARS);
    expect(run.scriptSha256).toBe(sha256Hex(script));
  });

  it("record_run rejects a datasetId that does not belong to the project", async () => {
    const harness = setup();
    const uid = freshUid();
    const projectId = await seedProject(harness, uid);
    const output = contentOf(
      await harness.tool.execute(
        { action: "record_run", projectId, name: "无数据集", language: "python", datasetId: "missing-ds" },
        makeCtx(uid),
      ),
    );
    expect(output).toContain("数据集不存在或不属于该项目");
    expect(await harness.runs.listRuns(uid, projectId)).toEqual([]);
  });

  it("record_run links a valid dataset and derives startedAt/finishedAt from durationMs", async () => {
    const harness = setup();
    const uid = freshUid();
    const projectId = await seedProject(harness, uid);
    const ctx = makeCtx(uid);
    const datasetOutput = contentOf(
      await harness.tool.execute({ action: "add_dataset", projectId, name: "输入数据" }, ctx),
    );
    expect(datasetOutput).toContain("dataset_id");
    const dataset = (await harness.runs.listDatasets(uid, projectId))[0];

    const startedBefore = Date.now();
    await harness.tool.execute(
      {
        action: "record_run",
        projectId,
        name: "使用数据集",
        language: "python",
        datasetId: dataset.id,
        durationMs: 1500,
        exitCode: 0,
      },
      makeCtx(uid),
    );
    const run = (await harness.runs.listRuns(uid, projectId))[0];
    expect(run.datasetId).toBe(dataset.id);
    expect(run.finishedAt).toBeGreaterThanOrEqual(startedBefore);
    expect(run.finishedAt! - run.startedAt!).toBe(1500);
  });

  it("record_run needs name and language", async () => {
    const harness = setup();
    const uid = freshUid();
    const projectId = await seedProject(harness, uid);
    const missingName = contentOf(
      await harness.tool.execute({ action: "record_run", projectId, language: "python" }, makeCtx(uid)),
    );
    expect(missingName).toContain("需要 name");
    const missingLanguage = contentOf(
      await harness.tool.execute({ action: "record_run", projectId, name: "x" }, makeCtx(uid)),
    );
    expect(missingLanguage).toContain("需要 language");
  });

  it("list_runs pages with limit/offset and reports the window", async () => {
    const harness = setup();
    const uid = freshUid();
    const projectId = await seedProject(harness, uid);
    for (let i = 0; i < 3; i += 1) {
      await harness.tool.execute(
        { action: "record_run", projectId, name: "run-" + i, language: "python" },
        makeCtx(uid),
      );
    }
    const ctx = makeCtx(uid);
    const firstPage = contentOf(
      await harness.tool.execute({ action: "list_runs", projectId, limit: 2 }, ctx),
    );
    expect(firstPage).toContain("offset=0");
    expect(firstPage).toContain("显示 2 条");
    expect(firstPage).toContain("run-2");
    expect(firstPage).toContain("run-1");

    const secondPage = contentOf(
      await harness.tool.execute({ action: "list_runs", projectId, limit: 2, offset: 2 }, ctx),
    );
    expect(secondPage).toContain("offset=2");
    expect(secondPage).toContain("run-0");

    const artifact = artifactsOf(ctx).pop();
    expect(artifact?.data.action).toBe("list_runs");
    expect(artifact?.data.offset).toBe(2);
    expect(artifact?.data.limit).toBe(2);
  });

  it("list_runs degrades to guidance when the project has no runs", async () => {
    const harness = setup();
    const uid = freshUid();
    const projectId = await seedProject(harness, uid);
    const output = contentOf(await harness.tool.execute({ action: "list_runs", projectId }, makeCtx(uid)));
    expect(output).toContain("还没有运行记录");
  });

  it("get_run renders details and enforces uid/project scope", async () => {
    const harness = setup();
    const uid = freshUid();
    const projectId = await seedProject(harness, uid);
    const ctx = makeCtx(uid);
    await harness.tool.execute(
      {
        action: "record_run",
        projectId,
        name: "详情运行",
        language: "python",
        script: "print(1)",
        exitCode: 0,
        stdoutPreview: "hello",
      },
      ctx,
    );
    const run = (await harness.runs.listRuns(uid, projectId))[0];

    const detailCtx = makeCtx(uid);
    const detail = contentOf(
      await harness.tool.execute({ action: "get_run", projectId, runId: run.id }, detailCtx),
    );
    expect(detail).toContain("详情运行");
    expect(detail).toContain("run_id: " + run.id);
    expect(detail).toContain("成功");
    expect(detail).toContain("sha256=");
    expect(detail).toContain("hello");

    const artifact = artifactsOf(detailCtx).pop();
    expect(artifact?.kind).toBe(ACADEMIC_EVIDENCE_ARTIFACT_KIND);
    expect(artifact?.data.action).toBe("get_run");

    const unknown = contentOf(
      await harness.tool.execute({ action: "get_run", projectId, runId: "missing-run" }, makeCtx(uid)),
    );
    expect(unknown).toContain("运行记录不存在或不属于该项目");

    // A run of the same project cannot be read through a DIFFERENT project id.
    const otherProject = await harness.projects.create(uid, { title: "另一个项目" });
    const crossed = contentOf(
      await harness.tool.execute(
        { action: "get_run", projectId: otherProject.id, runId: run.id },
        makeCtx(uid),
      ),
    );
    expect(crossed).toContain("运行记录不存在或不属于该项目");
  });

  it("keeps evidence metadata-only even when callers send extra properties", async () => {
    const harness = setup();
    const uid = freshUid();
    const projectId = await seedProject(harness, uid);
    const ctx = makeCtx(uid);
    await harness.tool.execute(
      {
        action: "add_dataset",
        projectId,
        name: "含内容的文件",
        files: [{ name: "data.csv", content: "raw bytes must not be stored" }],
      } as never,
      ctx,
    );
    const dataset = (await harness.runs.listDatasets(uid, projectId))[0];
    expect(dataset.files).toEqual([{ name: "data.csv" }]);
    expect("content" in dataset.files[0]).toBe(false);

    await harness.tool.execute(
      {
        action: "record_run",
        projectId,
        name: "含内容产物",
        language: "python",
        artifacts: [{ name: "out.txt", content: "raw stdout must not be stored" }],
      } as never,
      makeCtx(uid),
    );
    const run = (await harness.runs.listRuns(uid, projectId))[0];
    expect(run.artifacts).toEqual([{ name: "out.txt" }]);
    expect("content" in run.artifacts[0]).toBe(false);
  });

  it("isolates evidence across uids", async () => {
    const harness = setup();
    const alice = freshUid();
    const bob = freshUid();
    const aliceProject = await seedProject(harness, alice);
    const bobProject = await seedProject(harness, bob);

    await harness.tool.execute(
      { action: "add_dataset", projectId: aliceProject, name: "Alice 数据" },
      makeCtx(alice),
    );
    await harness.tool.execute(
      { action: "add_dataset", projectId: bobProject, name: "Bob 数据" },
      makeCtx(bob),
    );

    const aliceView = contentOf(
      await harness.tool.execute({ action: "list_datasets", projectId: aliceProject }, makeCtx(alice)),
    );
    expect(aliceView).toContain("Alice 数据");
    expect(aliceView).not.toContain("Bob 数据");

    // Bob cannot touch Alice's project at all.
    const crossWrite = contentOf(
      await harness.tool.execute(
        { action: "add_dataset", projectId: aliceProject, name: "入侵" },
        makeCtx(bob),
      ),
    );
    expect(crossWrite).toContain("项目不存在或无权访问");
    expect(await harness.runs.listDatasets(alice, aliceProject)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Mongo adapter (skipped when no local MongoDB is reachable)
// ---------------------------------------------------------------------------

let mongo: import("../src/repository/mongo/academic-evidence.js").MongoAcademicEvidenceStore | null = null;

beforeAll(async () => {
  const { MongoAcademicEvidenceStore } = await import("../src/repository/mongo/academic-evidence.js");
  mongo = await MongoAcademicEvidenceStore.connect();
}, 15_000);

afterAll(async () => {
  await mongo?.close();
});

describe("MongoAcademicEvidenceStore", () => {
  it("connect returns a store (or the whole group skips without MongoDB)", (ctx) => {
    if (!mongo) return ctx.skip();
    expect(mongo).toBeInstanceOf(Object);
  });

  it("datasets: add → list is uid+project scoped and newest first", async (ctx) => {
    if (!mongo) return ctx.skip();
    const uid = freshUid();
    const first = await mongo.addDataset(uid, "p1", { name: "Mongo 数据集一", source: "upload" });
    const second = await mongo.addDataset(uid, "p1", {
      name: "Mongo 数据集二",
      files: [{ name: "f.csv", sizeBytes: 7 }],
    });
    await mongo.addDataset(freshUid(), "p1", { name: "别人的" });

    const listed = await mongo.listDatasets(uid, "p1");
    expect(listed.map((dataset) => dataset.id)).toEqual([second.id, first.id]);
    expect(listed[0].files).toEqual([{ name: "f.csv", sizeBytes: 7 }]);
    expect(await mongo.listDatasets(uid, "p2")).toEqual([]);
    expect((await mongo.listDatasets(freshUid(), "p1")).map((dataset) => dataset.name)).toEqual(["别人的"]);
  });

  it("runs: record → list order/limit → getRun scoping", async (ctx) => {
    if (!mongo) return ctx.skip();
    const uid = freshUid();
    const first = await mongo.recordRun(uid, "p1", {
      name: "mongo-run-1",
      language: "python",
      script: "print(1)",
      exitCode: 0,
      artifacts: [{ name: "out.csv", sizeBytes: 3, sha256: "AB" }],
    });
    const second = await mongo.recordRun(uid, "p1", { name: "mongo-run-2", language: "javascript" });
    const third = await mongo.recordRun(uid, "p1", { name: "mongo-run-3", language: "python" });

    expect(first.status).toBe("recorded");
    expect(first.script).toBe("print(1)");
    expect(first.scriptSha256).toBe(sha256Hex("print(1)"));
    expect(first.artifacts).toEqual([{ name: "out.csv", sizeBytes: 3, sha256: "ab" }]);

    const page = await mongo.listRuns(uid, "p1", { limit: 2 });
    expect(page.map((run) => run.id)).toEqual([third.id, second.id]);
    const all = await mongo.listRuns(uid, "p1", { limit: 10, offset: 1 });
    expect(all.map((run) => run.id)).toEqual([second.id, first.id]);

    expect((await mongo.getRun(uid, "p1", first.id))?.name).toBe("mongo-run-1");
    expect(await mongo.getRun(uid, "p2", first.id)).toBeNull();
    expect(await mongo.getRun(freshUid(), "p1", first.id)).toBeNull();
    expect(await mongo.getRun(uid, "p1", "missing-run")).toBeNull();
  });
});
