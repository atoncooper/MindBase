import { randomUUID } from "node:crypto";
import { createLogger } from "../../logger.js";
import type { AcademicActor, AcademicEventRepository } from "../../repository/academic.js";
import {
  isApprovalConsumed,
  isApprovalExpired,
  type ResearchApproval,
  type ResearchApprovalKind,
  type ResearchApprovalRepository,
  type ResearchApprovalRequester,
  type ResearchApprovalScope,
} from "../../repository/research-approvals.js";

const log = createLogger("APPROVAL");

/** Default validity of a decision before it must be re-requested (24h). */
export const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

/** Machine-readable reason behind a rejected approval operation. */
export type ResearchApprovalErrorCode =
  | "invalid"
  | "not_found"
  | "not_pending"
  | "not_approved"
  | "rejected"
  | "expired"
  | "consumed"
  | "unavailable";

export class ResearchApprovalError extends Error {
  constructor(
    message: string,
    /** Stable reason for the REST layer (409/422 mapping) and tool guidance. */
    readonly code: ResearchApprovalErrorCode = "invalid",
  ) {
    super(message);
    this.name = "ResearchApprovalError";
  }
}

/** Optional knobs for a new request; every field is backward compatible. */
export interface ResearchApprovalRequestOptions {
  /** Action class the decision authorises ("experiment"/"submission"/"export"). */
  scope?: ResearchApprovalScope;
  /** Pre-bind the approval to a planned experiment. */
  experimentId?: string;
  /** Validity window from `requestedAt` in ms (default 24h; <= 0 = already expired). */
  ttlMs?: number;
  /** Optional hash binding the decision to the payload/plan it approved. */
  payloadHash?: string;
  /** Source of the request (agent tool vs user REST); defaults to "agent". */
  requestedBy?: ResearchApprovalRequester;
}

/** Convenience filter for listActive(). */
export interface ResearchApprovalActiveFilter {
  kind?: ResearchApprovalKind;
  scope?: ResearchApprovalScope;
}

/**
 * Human-in-the-loop gate for high-cost / irreversible research actions.
 *
 * Definition (approval v2):
 * - a decision is usable only while it is `approved`, not past `expiresAt`
 * and not spent (`consumedAt` unset); legacy rows without those fields keep
 * the old "approved forever" semantics;
 * - `consume`/`consumeById` spend a decision exactly once (each experiment
 * submit, export or submission needs its own approval);
 * - lifecycle changes are appended to the project event feed through the
 * optional AcademicEventRepository injection (approval.requested /
 * approval.decided / approval.expired / approval.consumed).
 *
 * The AI tool can only request; approving/rejecting is a user REST action
 * (X-Uid authenticated), so the model can never approve itself.
 */
export class ResearchApprovalService {
  constructor(
    private readonly repo: ResearchApprovalRepository,
    /**
     * Optional audit sink. It is deliberately `Pick<..., "append">` so the
     * composition root can inject the academic event repository without this
     * service depending on any storage implementation.
     */
    private readonly events?: Pick<AcademicEventRepository, "append">,
  ) {}

  async request(
    uid: string,
    projectId: string,
    kind: ResearchApprovalKind,
    note?: string,
    opts: ResearchApprovalRequestOptions = {},
  ): Promise<ResearchApproval> {
    const existing = (await this.repo.listByProject(uid, projectId)).find(
      (a) =>
        a.kind === kind &&
        a.status === "pending" &&
        a.scope === opts.scope &&
        !isApprovalExpired(a),
    );
    if (existing) return existing;
    const now = Date.now();
    const requestedBy = opts.requestedBy ?? "agent";
    const approval: ResearchApproval = {
      id: randomUUID(),
      uid,
      projectId,
      kind,
      status: "pending",
      ...(note ? { note } : {}),
      requestedAt: now,
      expiresAt: now + (opts.ttlMs ?? DEFAULT_APPROVAL_TTL_MS),
      requestedBy,
      ...(opts.scope ? { scope: opts.scope } : {}),
      ...(opts.experimentId ? { experimentId: opts.experimentId } : {}),
      ...(opts.payloadHash ? { payloadHash: opts.payloadHash } : {}),
    };
    await this.repo.create(approval);
    await this.emit(uid, projectId, "approval.requested", {
      approvalId: approval.id,
      kind,
      ...(approval.scope ? { scope: approval.scope } : {}),
      ...(approval.experimentId ? { experimentId: approval.experimentId } : {}),
      expiresAt: approval.expiresAt,
    }, requestedBy === "user" ? "user" : "agent");
    return approval;
  }

  async decide(
    uid: string,
    approvalId: string,
    approved: boolean,
    note?: string,
  ): Promise<ResearchApproval> {
    const approval = await this.repo.get(approvalId);
    if (!approval || approval.uid !== uid) {
      throw new ResearchApprovalError("审批不存在或无权访问", "not_found");
    }
    if (approval.status !== "pending") {
      throw new ResearchApprovalError("该审批已处理", "not_pending");
    }
    if (isApprovalExpired(approval)) {
      // Expiry is only discovered lazily (on decide/consume); record it once so
      // the activity feed shows why the user could not act on a stale request.
      await this.emit(uid, approval.projectId, "approval.expired", {
        approvalId: approval.id,
        kind: approval.kind,
        ...(approval.scope ? { scope: approval.scope } : {}),
        expiresAt: approval.expiresAt,
      }, "user");
      throw new ResearchApprovalError("该审批已过期，请重新发起审批", "expired");
    }
    if (isApprovalConsumed(approval)) {
      throw new ResearchApprovalError("该审批已被消费（一次一用），请重新发起审批", "consumed");
    }
    approval.status = approved ? "approved" : "rejected";
    approval.decidedAt = Date.now();
    approval.decidedBy = uid;
    if (note) approval.decisionNote = note;
    await this.repo.save(approval);
    await this.emit(uid, approval.projectId, "approval.decided", {
      approvalId: approval.id,
      kind: approval.kind,
      approved,
      ...(approval.scope ? { scope: approval.scope } : {}),
      ...(note ? { note } : {}),
    }, "user");
    return approval;
  }

  /**
   * True when the project holds an approved, unexpired, unconsumed decision of
   * `kind`. Legacy rows without expiresAt/consumedAt stay approved forever.
   */
  async isApproved(uid: string, projectId: string, kind: ResearchApprovalKind): Promise<boolean> {
    const now = Date.now();
    const rows = await this.repo.listByProject(uid, projectId);
    return rows.some(
      (a) =>
        a.kind === kind &&
        a.status === "approved" &&
        !isApprovalExpired(a, now) &&
        !isApprovalConsumed(a),
    );
  }

  /**
   * Active decisions (approved, unexpired, unconsumed), newest first — the
   * read-only view DAG/export gates use before deciding to pause.
   */
  async listActive(
    uid: string,
    projectId: string,
    filter: ResearchApprovalActiveFilter = {},
  ): Promise<ResearchApproval[]> {
    const now = Date.now();
    return (await this.repo.listByProject(uid, projectId))
      .filter(
        (a) =>
          a.status === "approved" &&
          !isApprovalExpired(a, now) &&
          !isApprovalConsumed(a) &&
          (filter.kind === undefined || a.kind === filter.kind) &&
          (filter.scope === undefined || a.scope === filter.scope),
      )
      .sort((a, b) => b.requestedAt - a.requestedAt);
  }

  /**
   * Convenience gate for DAG/export/submission paths (non-consuming): true
   * when an active project-level decision of `kind` exists — one that is not
   * bound to a concrete experiment. An explicit `scope` narrows the match;
   * legacy rows without scope count for any scope (pre-v2 "kind approval").
   */
  async hasApprovedProjectLevel(
    uid: string,
    projectId: string,
    kind: ResearchApprovalKind,
    scope?: ResearchApprovalScope,
  ): Promise<boolean> {
    const rows = await this.listActive(uid, projectId, { kind });
    return rows.some((a) => {
      if (a.experimentId !== undefined) return false;
      if (scope !== undefined) return a.scope === undefined || a.scope === scope;
      return a.scope === undefined || a.scope === kind;
    });
  }

  /**
   * Spend the newest approved decision of `kind` for the project.
   * One-shot: the row's `consumedAt` is stamped before returning, so a second
   * call fails with an explicit reason instead of silently reusing the gate.
   */
  async consume(
    uid: string,
    projectId: string,
    kind: ResearchApprovalKind,
    actor: AcademicActor = "agent",
  ): Promise<ResearchApproval> {
    const rows = await this.repo.listByProject(uid, projectId);
    const approved = rows
      .filter((a) => a.kind === kind && a.status === "approved")
      .sort((a, b) => b.requestedAt - a.requestedAt);
    if (approved.length === 0) {
      throw new ResearchApprovalError("没有已批准的人工审批，请先申请并等待用户批准", "unavailable");
    }
    const now = Date.now();
    const usable = approved.find((a) => !isApprovalConsumed(a) && !isApprovalExpired(a, now));
    if (!usable) {
      if (approved.every((a) => isApprovalConsumed(a))) {
        throw new ResearchApprovalError("审批已被消费（一次一用），请重新申请人工审批", "consumed");
      }
      if (approved.every((a) => isApprovalExpired(a, now))) {
        throw new ResearchApprovalError("审批已过期，请重新申请人工审批", "expired");
      }
      throw new ResearchApprovalError(
        "没有可用的人工审批（最近一条已过期或已消费），请重新申请人工审批",
        "unavailable",
      );
    }
    usable.consumedAt = now;
    await this.repo.save(usable);
    await this.emit(uid, projectId, "approval.consumed", {
      approvalId: usable.id,
      kind,
      ...(usable.scope ? { scope: usable.scope } : {}),
      ...(usable.experimentId ? { experimentId: usable.experimentId } : {}),
      consumedAt: now,
    }, actor);
    return usable;
  }

  /** Spend one specific decision (used when the caller passes approvalId). */
  async consumeById(
    uid: string,
    approvalId: string,
    actor: AcademicActor = "agent",
  ): Promise<ResearchApproval> {
    const approval = await this.repo.get(approvalId);
    if (!approval || approval.uid !== uid) {
      throw new ResearchApprovalError("审批不存在或无权访问", "not_found");
    }
    if (approval.status === "pending") {
      throw new ResearchApprovalError("审批尚未批准，请等待用户在审批中心确认", "not_approved");
    }
    if (approval.status === "rejected") {
      throw new ResearchApprovalError("审批已被拒绝，请重新发起审批", "rejected");
    }
    if (isApprovalConsumed(approval)) {
      throw new ResearchApprovalError("审批已被消费（一次一用），请重新申请人工审批", "consumed");
    }
    if (isApprovalExpired(approval)) {
      throw new ResearchApprovalError("审批已过期，请重新申请人工审批", "expired");
    }
    approval.consumedAt = Date.now();
    await this.repo.save(approval);
    await this.emit(uid, approval.projectId, "approval.consumed", {
      approvalId: approval.id,
      kind: approval.kind,
      ...(approval.scope ? { scope: approval.scope } : {}),
      consumedAt: approval.consumedAt,
    }, actor);
    return approval;
  }

  /**
   * Bind a consumed decision to the experiment it authorised. The first bind
   * wins: a request that already carries experimentId keeps it, so history is
   * never rewritten by a later submit.
   */
  async bindExperiment(
    uid: string,
    approvalId: string,
    experimentId: string,
  ): Promise<ResearchApproval> {
    const approval = await this.repo.get(approvalId);
    if (!approval || approval.uid !== uid) {
      throw new ResearchApprovalError("审批不存在或无权访问", "not_found");
    }
    if (approval.experimentId !== undefined) return approval;
    approval.experimentId = experimentId;
    await this.repo.save(approval);
    return approval;
  }

  async list(uid: string, projectId: string): Promise<ResearchApproval[]> {
    return this.repo.listByProject(uid, projectId);
  }

  /** Best-effort audit append: a failed event must not fail the approval. */
  private async emit(
    uid: string,
    projectId: string,
    type: string,
    payload: Record<string, unknown>,
    actor: AcademicActor,
  ): Promise<void> {
    if (!this.events) return;
    try {
      await this.events.append(uid, projectId, type, payload, actor);
    } catch (err) {
      log.warn(
        "[APPROVAL] event append failed type=" + type + " project_id=" + projectId + ": " +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }
}
