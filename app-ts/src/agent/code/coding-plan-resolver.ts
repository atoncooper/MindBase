import type { LanguageModel } from "ai";
import { createLogger } from "../../logger.js";
import { createCodingPlanModel, type CodingPlan } from "../../llm/coding-plan.js";
import type { QuotaKind } from "../../services/quota.js";

/**
 * Chat-turn model resolution for Coding Plans.
 *
 * A configured plan is the DEFAULT model for its owner: an explicit chat-dialog
 * pick wins, otherwise the plan's own model, otherwise the first entry of the
 * provider catalog (served from app-user's Redis cache — never persisted).
 *
 * Every failure path (no uid, no plan, non-VIP/403, membership outage/503,
 * invalid plan, empty catalog, quota exhausted, counter store error) falls OPEN
 * to the platform gateway so a third-party outage never blocks chat.
 *
 * Audit: one [CODING_PLAN] line per actual use with uid/plan_id/provider/model
 * (never the api_key). Quota: one consumeKind("coding_plan") per actual use.
 */

export interface CodingPlanLookup {
  getCodingPlan(uid: string): Promise<CodingPlan | null>;
  /** Redis-cached provider catalog (empty when unknown / provider has no /models). */
  getCodingPlanModels(uid: string): Promise<string[]>;
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

export interface CodingPlanResolution {
  model: LanguageModel;
  /** Concrete model id that ran this turn (billing/ledger). */
  modelId: string;
}

/** Resolver signature consumed by ChatService.resolveModel. */
export type CodingPlanResolver = (input: {
  uid?: string;
  /** Explicit pick from the chat dialog; absent = plan default. */
  model?: string;
  /** stable chat session id → x-opencode-session for OpenCode plans */
  sessionId?: string;
}) => Promise<CodingPlanResolution | undefined>;

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
      // incident worth a warning per turn. Anything else (503 / membership
      // outage / network) is worth surfacing; both fall back.
      const status = (err as { status?: unknown })?.status;
      if (status !== 403) {
        log.warn(`[CODING_PLAN] plan lookup failed uid=${uid}: ${errText(err)} — fallback gateway`);
      }
      return undefined;
    }
    if (!plan) return undefined;

    const planId = String(plan.id ?? "");
    const provider = String(plan.provider ?? "");

    // Explicit chat-dialog pick > the plan's configured model > first cached
    // catalog entry. A plan only becomes the DEFAULT when the user marked it
    // as such; otherwise only an explicit pick routes here.
    const selectedModel = String(input.model ?? "").trim();
    if (!selectedModel && !plan.is_default) {
      return undefined;
    }
    let modelId = selectedModel || String(plan.model ?? "").trim();
    if (!modelId) {
      try {
        const models = await deps.plans.getCodingPlanModels(uid);
        modelId = (models ?? []).map((m) => String(m).trim()).find((m) => m.length > 0) ?? "";
      } catch (err) {
        log.warn(`[CODING_PLAN] model catalog lookup failed uid=${uid}: ${errText(err)}`);
      }
    }
    if (!modelId) {
      log.warn(`[CODING_PLAN] plan has no usable model uid=${uid} plan_id=${planId} — fallback gateway`);
      return undefined;
    }

    let model: LanguageModel;
    try {
      model = createCodingPlanModel({ ...plan, model: modelId }, { sessionId: input.sessionId });
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

    log.info({ uid, plan_id: planId, provider, model: modelId }, "[CODING_PLAN] using third-party coding plan");
    return { model, modelId };
  };
}
