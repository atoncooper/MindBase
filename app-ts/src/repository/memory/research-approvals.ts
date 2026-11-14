import type { ResearchApproval, ResearchApprovalRepository } from "../research-approvals.js";

export class MemoryResearchApprovalRepository implements ResearchApprovalRepository {
  private readonly items = new Map<string, ResearchApproval>();

  async create(approval: ResearchApproval): Promise<void> {
    this.items.set(approval.id, structuredClone(approval));
  }

  async get(id: string): Promise<ResearchApproval | undefined> {
    const found = this.items.get(id);
    return found ? structuredClone(found) : undefined;
  }

  async listByProject(uid: string, projectId: string): Promise<ResearchApproval[]> {
    return [...this.items.values()]
      .filter((a) => a.uid === uid && a.projectId === projectId)
      .sort((a, b) => b.requestedAt - a.requestedAt)
      .map((a) => structuredClone(a));
  }

  async save(approval: ResearchApproval): Promise<void> {
    this.items.set(approval.id, structuredClone(approval));
  }
}
