export const RESEARCH_APPROVAL_KINDS = ["experiment", "submission"] as const;
export type ResearchApprovalKind = (typeof RESEARCH_APPROVAL_KINDS)[number];
export type ResearchApprovalStatus = "pending" | "approved" | "rejected";

export interface ResearchApproval {
  id: string;
  uid: string;
  projectId: string;
  kind: ResearchApprovalKind;
  status: ResearchApprovalStatus;
  note?: string;
  requestedAt: number;
  decidedAt?: number;
  decidedBy?: string;
  decisionNote?: string;
}

export interface ResearchApprovalRepository {
  create(approval: ResearchApproval): Promise<void>;
  get(id: string): Promise<ResearchApproval | undefined>;
  listByProject(uid: string, projectId: string): Promise<ResearchApproval[]>;
  save(approval: ResearchApproval): Promise<void>;
}
