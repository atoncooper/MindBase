import { randomUUID } from "node:crypto";
import type { ResearchApproval, ResearchApprovalKind, ResearchApprovalRepository } from "../repository/research-approvals.js";

export class ResearchApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResearchApprovalError";
  }
}

/**
 * Human-in-the-loop gate for high-cost / irreversible research actions.
 * The AI tool can only request; approving/rejecting is a user REST action
 * (X-Uid authenticated), so the model can never approve itself.
 */
export class ResearchApprovalService {
  constructor(private readonly repo: ResearchApprovalRepository) {}

  async request(uid: string, projectId: string, kind: ResearchApprovalKind, note?: string): Promise<ResearchApproval> {
    const existing = (await this.repo.listByProject(uid, projectId)).find(
      (a) => a.kind === kind && a.status === "pending",
    );
    if (existing) return existing;
    const approval: ResearchApproval = {
      id: randomUUID(),
      uid,
      projectId,
      kind,
      status: "pending",
      ...(note ? { note } : {}),
      requestedAt: Date.now(),
    };
    await this.repo.create(approval);
    return approval;
  }

  async decide(
    uid: string,
    approvalId: string,
    approved: boolean,
    note?: string,
  ): Promise<ResearchApproval> {
    const approval = await this.repo.get(approvalId);
    if (!approval || approval.uid !== uid) throw new ResearchApprovalError("审批不存在或无权访问");
    if (approval.status !== "pending") throw new ResearchApprovalError("该审批已处理");
    approval.status = approved ? "approved" : "rejected";
    approval.decidedAt = Date.now();
    approval.decidedBy = uid;
    if (note) approval.decisionNote = note;
    await this.repo.save(approval);
    return approval;
  }

  async isApproved(uid: string, projectId: string, kind: ResearchApprovalKind): Promise<boolean> {
    const rows = await this.repo.listByProject(uid, projectId);
    return rows.some((a) => a.kind === kind && a.status === "approved");
  }

  async list(uid: string, projectId: string): Promise<ResearchApproval[]> {
    return this.repo.listByProject(uid, projectId);
  }
}
