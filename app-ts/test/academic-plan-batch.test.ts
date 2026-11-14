import { describe, expect, it } from "vitest";
import { ResultCollector, type ToolRunContext } from "../src/context/types.js";
import { MemoryAcademicStore } from "../src/repository/memory/academic.js";
import { createAcademicProjectTool } from "../src/tools/academic/project.js";

/**
 * academic_project plan_set batch (stages) + plan_get overview. Unlike
 * academic-tools.test.ts (repository doubles), these tests run against the real
 * MemoryAcademicStore so merge-by-title, event payloads and persistence are
 * exercised end to end without Mongo or the network.
 */

function makeCtx(uid = "u1"): ToolRunContext {
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

async function setup(title = "图神经网络推荐研究") {
  const store = new MemoryAcademicStore();
  const tool = createAcademicProjectTool({ projects: store, events: store, literature: store, documents: store });
  const ctx = makeCtx();
  const project = await store.create("u1", { title, field: "机器学习" });
  return { store, tool, ctx, project };
}

async function planEvents(store: MemoryAcademicStore, projectId: string) {
  const events = await store.listEvents("u1", projectId, 20);
  return events.filter((event) => event.type === "plan.updated");
}

const BATCH = [
  { stage: "topic" as const, tasks: ["确定研究问题", "检索综述文献", "界定研究范围"] },
  { stage: "design" as const, tasks: ["设计实验方案", "确定评价指标", "准备数据集"] },
  { stage: "experiment" as const, tasks: ["实现基线模型", "跑对比实验"] },
];

describe("academic_project plan_set batch", () => {
  it("writes several stages in one batch with a single plan.updated event", async () => {
    const { store, tool, ctx, project } = await setup();

    const text = contentOf(await tool.execute({ action: "plan_set", projectId: project.id, stages: BATCH }, ctx));

    const stored = await store.get("u1", project.id);
    expect(stored?.plans.topic?.map((task) => task.title)).toEqual(["确定研究问题", "检索综述文献", "界定研究范围"]);
    expect(stored?.plans.design?.map((task) => task.title)).toEqual(["设计实验方案", "确定评价指标", "准备数据集"]);
    expect(stored?.plans.experiment?.map((task) => task.title)).toEqual(["实现基线模型", "跑对比实验"]);

    expect(text).toContain("已写入 3 个阶段的执行计划");
    expect(text).toContain("选题");
    expect(text).toContain("研究设计");
    expect(text).toContain("实验");

    const events = await planEvents(store, project.id);
    expect(events).toHaveLength(1);
    const payload = events[0]?.payload as { stages?: Array<{ stage: string; taskCount: number }>; taskCount?: number };
    expect(payload.stages?.map((entry) => entry.stage)).toEqual(["topic", "design", "experiment"]);
    expect(payload.stages?.map((entry) => entry.taskCount)).toEqual([3, 3, 2]);
    expect(payload.taskCount).toBe(8);
    expect(ctx.collector.artifacts.filter((artifact) => artifact.kind === "academic_project")).toHaveLength(1);
  });

  it("keeps done/note on same-title tasks and gives new tasks unique ids", async () => {
    const { store, tool, ctx, project } = await setup();
    await tool.execute(
      { action: "plan_set", projectId: project.id, stages: [{ stage: "topic", tasks: ["确定研究问题", "检索综述文献"] }] },
      ctx,
    );
    // The user ticks a task and adds a note in the workspace UI.
    await store.update("u1", project.id, {
      plans: {
        topic: [
          { id: "t1", title: "确定研究问题", done: true, note: "已确认" },
          { id: "t2", title: "检索综述文献", done: false },
        ],
      },
    });

    await tool.execute(
      { action: "plan_set", projectId: project.id, stages: [{ stage: "topic", tasks: ["检索综述文献", "确定研究问题", "补充实验"] }] },
      ctx,
    );

    const tasks = (await store.get("u1", project.id))?.plans.topic ?? [];
    expect(tasks.map((task) => task.title)).toEqual(["检索综述文献", "确定研究问题", "补充实验"]);
    const kept = tasks.find((task) => task.title === "确定研究问题");
    expect(kept?.id).toBe("t1");
    expect(kept?.done).toBe(true);
    expect(kept?.note).toBe("已确认");
    expect(tasks.find((task) => task.title === "检索综述文献")?.id).toBe("t2");
    const added = tasks.find((task) => task.title === "补充实验");
    expect(added?.done).toBe(false);
    expect(added?.id).toBe("t3");
    expect(new Set(tasks.map((task) => task.id)).size).toBe(tasks.length);
  });

  it("rejects conflicting or incomplete plan shapes without writing", async () => {
    const { store, tool, ctx, project } = await setup();
    const cases: Array<{ args: Parameters<typeof tool.execute>[0]; hint: string }> = [
      {
        args: {
          action: "plan_set",
          projectId: project.id,
          stage: "topic",
          tasks: ["a"],
          stages: [{ stage: "design", tasks: ["b"] }],
        },
        hint: "二选一",
      },
      { args: { action: "plan_set", projectId: project.id }, hint: "需要 stages" },
      {
        args: {
          action: "plan_set",
          projectId: project.id,
          stages: [
            { stage: "topic", tasks: ["a"] },
            { stage: "topic", tasks: ["b"] },
          ],
        },
        hint: "同一阶段只能出现一次",
      },
      {
        args: { action: "plan_set", projectId: project.id, stages: [{ stage: "topic", tasks: ["   "] }] },
        hint: "tasks 为空",
      },
      { args: { action: "plan_set", projectId: project.id, stage: "topic", tasks: ["   "] }, hint: "需要 tasks" },
    ];

    for (const entry of cases) {
      const text = contentOf(await tool.execute(entry.args, ctx));
      expect(text).toContain(entry.hint);
    }

    const stored = await store.get("u1", project.id);
    expect(stored?.plans.topic).toBeUndefined();
    expect(stored?.plans.design).toBeUndefined();
    expect(await planEvents(store, project.id)).toHaveLength(0);
  });

  it("single-stage plan_set keeps the legacy event payload", async () => {
    const { store, tool, ctx, project } = await setup();
    const text = contentOf(
      await tool.execute({ action: "plan_set", projectId: project.id, stage: "writing", tasks: ["写引言", "写方法"] }, ctx),
    );
    expect(text).toContain("已写入计划");
    expect(text).toContain("写作");

    const events = await planEvents(store, project.id);
    expect(events).toHaveLength(1);
    const payload = events[0]?.payload as { stage?: string; taskCount?: number; replaced?: boolean; stages?: unknown };
    expect(payload.stage).toBe("writing");
    expect(payload.taskCount).toBe(2);
    expect(payload.replaced).toBe(false);
    expect(payload.stages).toBeUndefined();
  });
});

describe("academic_project plan_get overview", () => {
  it("without stage returns every planned stage summary; with stage keeps the detail", async () => {
    const { tool, ctx, project } = await setup();

    const empty = contentOf(await tool.execute({ action: "plan_get", projectId: project.id }, ctx));
    expect(empty).toContain("还没有执行计划");
    expect(empty).toContain("plan_set");

    await tool.execute({ action: "plan_set", projectId: project.id, stages: BATCH }, ctx);

    const overview = contentOf(await tool.execute({ action: "plan_get", projectId: project.id }, ctx));
    expect(overview).toContain("执行计划");
    expect(overview).toContain("选题：0/3 完成");
    expect(overview).toContain("研究设计：0/3 完成");
    expect(overview).toContain("实验：0/2 完成");

    const detail = contentOf(await tool.execute({ action: "plan_get", projectId: project.id, stage: "topic" }, ctx));
    expect(detail).toContain("确定研究问题");
    expect(detail).toContain("0/3 完成");
  });
});
