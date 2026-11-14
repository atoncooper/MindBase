import { describe, expect, it } from "vitest";
import { ResearchApprovalService } from "../src/services/research-approval.js";
import { MemoryResearchApprovalRepository } from "../src/repository/memory/research-approvals.js";
import { ResearchWorkspaceService } from "../src/services/research-workspace.js";
import { MemoryResearchWorkspaceRepository } from "../src/repository/memory/research-workspaces.js";

describe("ResearchApprovalService", () => {
  it("AI requests, user approves, gate becomes true", async () => {
    const service = new ResearchApprovalService(new MemoryResearchApprovalRepository());
    const approval = await service.request("1", "p1", "experiment", "run training");
    expect(approval.status).toBe("pending");
    expect(await service.isApproved("1", "p1", "experiment")).toBe(false);
    const decided = await service.decide("1", approval.id, true, "looks good");
    expect(decided.status).toBe("approved");
    expect(await service.isApproved("1", "p1", "experiment")).toBe(true);
  });

  it("cannot decide someone else's approval", async () => {
    const service = new ResearchApprovalService(new MemoryResearchApprovalRepository());
    const approval = await service.request("1", "p1", "submission");
    await expect(service.decide("2", approval.id, true)).rejects.toThrow();
  });
});

describe("ResearchWorkspace retention", () => {
  it("deletes only expired temporary files, never permanent folders", async () => {
    const now = Date.now();
    const deleted: string[] = [];
    const cloud = {
      configured: true,
      async createFolder(_uid: string, name: string) {
        return { id: 1, name };
      },
      async listFiles(_uid: string, folderId: number) {
        if (folderId === 3) {
          return [
            { upload_uuid: "old-temp", name: "old.csv", size: 1, mime_type: "text/csv", createdAt: now - 90 * 24 * 3600 * 1000 },
            { upload_uuid: "new-temp", name: "new.csv", size: 1, mime_type: "text/csv", createdAt: now },
          ];
        }
        if (folderId === 7) {
          return [{ upload_uuid: "paper", name: "manuscript.tex", size: 1, mime_type: "text/plain", createdAt: now - 999 * 24 * 3600 * 1000 }];
        }
        return [];
      },
      async deleteFile(_uid: string, uploadUuid: string) {
        deleted.push(uploadUuid);
      },
    };
    const repo = new MemoryResearchWorkspaceRepository();
    await repo.create({
      workspaceId: "w1",
      uid: "1",
      title: "space",
      rootFolderId: 1,
      projects: [
        {
          projectId: "p1",
          title: "paper",
          rootFolderId: 2,
          folders: { plan: 8, literature: 9, data: 3, code: 4, results: 5, manuscript: 7, submission: 6 },
        },
      ],
      createdAt: now,
      updatedAt: now,
    });
    const service = new ResearchWorkspaceService(repo, cloud as never);
    const result = await service.cleanupTemporary(60);
    expect(result.deleted).toBe(1);
    expect(deleted).toEqual(["old-temp"]);
  });
});
