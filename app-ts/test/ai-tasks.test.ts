import { describe, expect, it } from "vitest";
import {
  nextAiTaskRunAt,
  type AiTask,
} from "../src/repository/ai-tasks.js";
import { MemoryAiTaskRepository } from "../src/repository/memory/ai-tasks.js";
import { tierRank } from "../src/utils/membership.js";

describe("AI scheduled tasks", () => {
  it("maps membership tiers to scheduler priority", () => {
    expect(tierRank("free")).toBe(0);
    expect(tierRank("vip")).toBe(1);
    expect(tierRank("svip")).toBe(2);
    expect(tierRank("promax")).toBe(3);
  });
  it("computes the next daily occurrence in the task timezone", () => {
    const from = Date.parse("2026-11-23T00:00:00Z"); // 08:00 Asia/Shanghai
    const next = nextAiTaskRunAt(
      { type: "daily", timezone: "Asia/Shanghai", time: "09:00" },
      from,
    );
    expect(next).not.toBeNull();
    expect(new Date(next!).toISOString()).toBe("2026-11-23T01:00:00.000Z");
  });

  it("computes the next weekly occurrence", () => {
    const from = Date.parse("2026-11-23T00:00:00Z"); // Monday 08:00 Shanghai
    const next = nextAiTaskRunAt(
      { type: "weekly", timezone: "Asia/Shanghai", time: "09:00", weekday: 1 },
      from,
    );
    expect(new Date(next!).toISOString()).toBe("2026-11-23T01:00:00.000Z");
  });

  it("rejects a past one-off schedule", () => {
    expect(
      nextAiTaskRunAt(
        { type: "once", timezone: "Asia/Shanghai", runAt: Date.now() - 1000 },
        Date.now(),
      ),
    ).toBeNull();
  });

  it("returns due tasks in time order (tier ranking happens in scheduler)", async () => {
    const repo = new MemoryAiTaskRepository();
    const now = Date.now();
    const base = {
      uid: "u1",
      prompt: "test",
      kind: "custom" as const,
      schedule: { type: "daily" as const, timezone: "Asia/Shanghai", time: "09:00" },
      status: "active" as const,
      notifyEmail: true,
      notifyPush: true,
      runCount: 0,
      createdAt: now,
      updatedAt: now,
      nextRunAt: now - 1000,
    };
    await repo.createTask({ ...base, id: "low", title: "low", priority: 0 });
    await repo.createTask({ ...base, id: "high", title: "high", priority: 2 });
    const due = await repo.listDue(now, 10);
    expect(due.map((task) => task.id)).toEqual(["low", "high"]);
  });

  it("leases a due task exactly once", async () => {
    const repo = new MemoryAiTaskRepository();
    const now = Date.now();
    const task: AiTask = {
      id: "t1",
      uid: "u1",
      title: "test",
      prompt: "test",
      kind: "custom",
      schedule: { type: "daily", timezone: "Asia/Shanghai", time: "09:00" },
      status: "active",
      priority: 1,
      notifyEmail: true,
      notifyPush: true,
      nextRunAt: now - 1000,
      runCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    await repo.createTask(task);
    expect(await repo.listDue(now, 10)).toHaveLength(1);
    expect(await repo.claimTask(task.id, now, 60_000)).toBeTruthy();
    expect(await repo.claimTask(task.id, now, 60_000)).toBeUndefined();
    expect(await repo.listDue(now + 30_000, 10)).toHaveLength(0);
  });
});
