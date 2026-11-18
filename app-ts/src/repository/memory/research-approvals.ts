import type { ResearchApproval, ResearchApprovalRepository } from "../research-approvals.js";

/**
 * In-process approval store (tests + Mongo-unreachable fallback). Rows are
 * stored verbatim, so approval v2 fields (scope/experimentId/expiresAt/
 * consumedAt/payloadHash/requestedBy) persist without extra code; rows that
 * never set them keep the legacy semantics.
 */
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

  async removeByProject(uid: string, projectId: string): Promise<number> {
    let removed = 0;
    for (const [id, approval] of [...this.items]) {
      if (approval.uid !== uid || approval.projectId !== projectId) continue;
      this.items.delete(id);
      removed += 1;
    }
    return removed;
  }
}
