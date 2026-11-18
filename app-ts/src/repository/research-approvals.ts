export const RESEARCH_APPROVAL_KINDS = ["experiment", "submission"] as const;
export type ResearchApprovalKind = (typeof RESEARCH_APPROVAL_KINDS)[number];

export type ResearchApprovalStatus = "pending" | "approved" | "rejected";

/**
 * What the approval authorises. `kind` stays the coarse, backward-compatible
 * field (experiment/submission); `scope` narrows a decision to one class of
 * action. Rows written before approval v2 have no scope and keep behaving as
 * project-level approvals (see hasApprovedProjectLevel in the service).
 */
export const RESEARCH_APPROVAL_SCOPES = ["experiment", "submission", "export"] as const;
export type ResearchApprovalScope = (typeof RESEARCH_APPROVAL_SCOPES)[number];

/** Who created the approval request: the agent acting for the user or the user. */
export type ResearchApprovalRequester = "agent" | "user";

/** 人工审批记录；AI 只能创建 pending，批准/拒绝由用户 REST 完成。 */
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
  /** Action class this decision applies to (v2; absent on legacy rows). */
  scope?: ResearchApprovalScope;
  /** Experiment the approval is bound to once a submit consumes it (one-shot). */
  experimentId?: string;
  /** Epoch ms after which an approved decision is no longer usable (v2). */
  expiresAt?: number;
  /** Epoch ms when the approved decision was spent; set once (v2). */
  consumedAt?: number;
  /** Optional hash binding the approval to the payload/plan it approved (v2). */
  payloadHash?: string;
  /** Source of the request (v2); absent on legacy rows. */
  requestedBy?: ResearchApprovalRequester;
}

export interface ResearchApprovalRepository {
  create(approval: ResearchApproval): Promise<void>;
  get(id: string): Promise<ResearchApproval | undefined>;
  listByProject(uid: string, projectId: string): Promise<ResearchApproval[]>;
  save(approval: ResearchApproval): Promise<void>;
  /** 永久删除项目下所有审批记录（级联清理），返回删除条数。 */
  removeByProject(uid: string, projectId: string): Promise<number>;
}

/**
 * Time-based validity helper shared by the service implementations so the
 * legacy "no expiresAt = never expires" rule cannot drift between callers.
 */
export function isApprovalExpired(
  approval: Pick<ResearchApproval, "expiresAt">,
  now: number = Date.now(),
): boolean {
  return approval.expiresAt !== undefined && approval.expiresAt <= now;
}

/** True once an approved decision has been spent (one-shot consumption). */
export function isApprovalConsumed(approval: Pick<ResearchApproval, "consumedAt">): boolean {
  return approval.consumedAt !== undefined;
}
