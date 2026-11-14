import { describe, expect, it } from "vitest";
import { ResearchWorkspaceService } from "../src/services/research-workspace.js";
import { MemoryResearchWorkspaceRepository } from "../src/repository/memory/research-workspaces.js";

class FakeCloud {
  configured = true;
  private nextId = 1;
  readonly calls: Array<{ name: string; parent?: number }> = [];
  async createFolder(_uid: string, name: string, parentId?: number) {
    this.calls.push({ name, ...(parentId !== undefined ? { parent: parentId } : {}) });
    return { id: this.nextId++, name };
  }
}

describe("ResearchWorkspaceService", () => {
  it("creates a workspace and the full project folder tree", async () => {
    const repo = new MemoryResearchWorkspaceRepository();
    const cloud = new FakeCloud();
    const service = new ResearchWorkspaceService(repo, cloud as never);

    const workspace = await service.createWorkspace("1", "我的学术研究");
    expect(workspace.rootFolderId).toBe(1);

    const updated = await service.ensureProject("1", "p1", "论文题目", workspace.workspaceId);
    const project = updated.projects.find((p) => p.projectId === "p1");
    expect(project).toBeTruthy();
    expect(project!.rootFolderId).toBe(2);
    expect(Object.keys(project!.folders)).toEqual([
      "plan",
      "literature",
      "data",
      "code",
      "results",
      "manuscript",
      "submission",
    ]);
    expect(cloud.calls.map((c) => c.name)).toEqual([
      "我的学术研究",
      "论文题目",
      "00_课题与计划",
      "01_文献",
      "02_数据",
      "03_代码与实验",
      "04_结果",
      "05_论文",
      "06_投稿",
    ]);
  });

  it("is idempotent for the same project id", async () => {
    const repo = new MemoryResearchWorkspaceRepository();
    const cloud = new FakeCloud();
    const service = new ResearchWorkspaceService(repo, cloud as never);
    const workspace = await service.createWorkspace("1", "空间");
    await service.ensureProject("1", "p1", "课题", workspace.workspaceId);
    const again = await service.ensureProject("1", "p1", "课题", workspace.workspaceId);
    expect(again.projects).toHaveLength(1);
    expect(cloud.calls).toHaveLength(9);
  });
});
