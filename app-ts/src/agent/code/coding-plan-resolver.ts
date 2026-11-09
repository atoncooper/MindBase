import type { LanguageModel } from "ai";
import { createLogger } from "../../logger.js";
import { createCodingPlanModel, type CodingPlan } from "../../llm/coding-plan.js";
import type { QuotaKind } from "../../services/quota.js";

/**
 * Code agent model resolution: a VIP/SVIP user's Coding Plan wins when it is
 * available and within the daily "coding_plan" quota; every other outcome
 * (no uid, no plan, non-VIP/403, membership outage/503, invalid plan, quota
 * exhausted, counter store error) falls OPEN to the platform gateway so a
 * third-party outage never blocks chat.
 *
 * Audit: one `[CODING_PLAN]` line per actual use with uid/plan_id/provider/model
 * (never the api_key). Quota: one consumeKind("coding_plan") per actual use,
 * mirroring the other AI kinds.
 */

export interface CodingPlanLookup {
  getCodingPlan(uid: string): Promise<CodingPlan | null>;
}

export interface CodingPlanQuota {
  consumeKind(uid: string, kind: QuotaKind, n?: number): Promise<boolean>;
}

export interface CodingPlanLog {
  info(fields: Record<string, unknown>, message: string): void;
  warn(message: string): void;
}

export interface CodingPlanResolverDeps {
  plans: CodingPlanLookup;
  quota: CodingPlanQuota;
  /** Test seam; defaults to the module logger. */
  logger?: CodingPlanLog;
}

/** Resolver signature consumed by ReactAgentOptions.resolveModel. */
export type CodingPlanResolver = (input: { uid?: string }) => Promise<LanguageModel | undefined>;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createCodingPlanResolver(deps: CodingPlanResolverDeps): CodingPlanResolver {
  const log: CodingPlanLog = deps.logger ?? createLogger("CODING_PLAN");

  return async (input) => {
    const uid = input.uid;
    if (!uid) return undefined;

    let plan: CodingPlan | null;
    try {
      plan = await deps.plans.getCodingPlan(uid);
    } catch (err) {
      // 403 = the caller is not VIP/SVIP: the expected "no plan" path, not an
      // incident worth a warning per code-agent run. Anything else (503 /
      // membership outage / network) is worth surfacing; both fall back.
      const status = (err as { status?: unknown })?.status;
      if (status !== 403) {
        log.warn(`[CODING_PLAN] plan lookup failed uid=${uid}: ${errText(err)} — fallback gateway`);
      }
      return undefined;
    }
    if (!plan) return undefined;

    const planId = String(plan.id ?? "");
    const provider = String(plan.provider ?? "");
    const modelId = String(plan.model ?? "");

    let model: LanguageModel;
    try {
      model = createCodingPlanModel(plan);
    } catch (err) {
      // Invalid/misconfigured plan: don't consume quota, don't break the turn.
      log.warn(`[CODING_PLAN] invalid plan uid=${uid} plan_id=${planId}: ${errText(err)} — fallback gateway`);
      return undefined;
    }

    let allowed: boolean;
    try {
      allowed = await deps.quota.consumeKind(uid, "coding_plan");
    } catch (err) {
      // A quota-layer bug must not route traffic to a third party uncontrolled.
      log.warn(`[CODING_PLAN] quota check failed uid=${uid} plan_id=${planId}: ${errText(err)} — fallback gateway`);
      return undefined;
    }
    if (!allowed) {
      log.warn(
        `[CODING_PLAN] daily quota exhausted uid=${uid} plan_id=${planId} provider=${provider} model=${modelId} — fallback gateway`,
      );
      return undefined;
    }

    log.info(
      { uid, plan_id: planId, provider, model: modelId },
      "[CODING_PLAN] using third-party coding plan",
    );
    return model;
  };
}
