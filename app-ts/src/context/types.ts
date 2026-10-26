/**
 * ToolRunContext: the explicit version of Python's implicit `runtime_dispatch` kwargs (_uid/_bvids/...).
 * Injected via closure when building the AI SDK tools on each call; uid/session context never appears in the LLM's inputSchema.
 */
export interface SearchScope {
  /** bvid scope resolved from favorites; empty = unrestricted */
  bvids?: string[];
  /** Cloud-drive file scope */
  uploadUuids?: string[];
  /** Video page (P) metadata id scope (used by the list_videos tool) */
  mediaIds?: number[];
}

export interface Source {
  bvid?: string;
  uploadUuid?: string;
  title?: string;
  pageTitle?: string;
  url?: string;
  chunkId?: string;
  score?: number;
  rerankScore?: number;
  /** kg_search sources: which page of the video the evidence came from */
  pageIndex?: number;
}

export interface Artifact {
  kind: string;
  data: unknown;
}

/**
 * Structured user-interaction payload (emitted as an `interact` SSE frame):
 * the model asks via the ask_user tool instead of embedding questions in prose,
 * so the frontend can render dedicated UI (confirm card / option chips / form).
 * The user's answer arrives as the next ordinary message — execution stays round-based.
 */
export interface InteractionOption {
  label: string;
  value: string;
}

export interface InteractionField {
  name: string;
  label: string;
  type: "text" | "email" | "datetime" | "select";
  required: boolean;
  options?: InteractionOption[];
}

export interface InteractionPayload {
  kind: "clarify" | "confirm" | "form";
  question: string;
  options?: InteractionOption[];
  fields?: InteractionField[];
  context?: string;
}

/**
 * One step of the agent's task plan (plan tool). Mirrors the desktop PlanStepView
 * and is serialized verbatim into the `plan` SSE frame.
 */
export type PlanStepStatus = "pending" | "in_progress" | "done" | "failed" | "skipped";

export interface PlanStepView {
  desc: string;
  status: PlanStepStatus;
  note: string;
}

/**
 * Read-only plan snapshot shown to the user. `done` counts done + skipped steps;
 * the frontend keeps it in memory for the turn only (never persisted, no resume
 * protocol, refresh loses it — same nature as the reasoning stream).
 */
export interface PlanSnapshot {
  version: number;
  steps: PlanStepView[];
  done: number;
  total: number;
}

/** Collects tool-produced sources / artifacts / interactions within a single conversation turn, emitted together at the SSE stream tail */
export class ResultCollector {
  readonly sources: Source[] = [];
  readonly artifacts: Artifact[] = [];
  readonly interactions: InteractionPayload[] = [];
  /**
   * Latest plan snapshot produced by the plan tool this turn (source of the
   * `plan` SSE frame). Absent until a plan mutation succeeds; the ReAct loop
   * emits a frame at every step boundary where the version changed.
   */
  plan?: PlanSnapshot;

  /** Register the latest plan snapshot (one per successful plan-tool mutation). */
  setPlan(plan: PlanSnapshot): void {
    this.plan = plan;
  }

  pushSources(sources: Source[] | undefined): void {
    if (!sources) return;
    const seen = new Set(this.sources.map((s) => s.chunkId ?? s.bvid ?? s.uploadUuid ?? ""));
    for (const s of sources) {
      const key = s.chunkId ?? s.bvid ?? s.uploadUuid ?? "";
      if (!seen.has(key)) {
        seen.add(key);
        this.sources.push(s);
      }
    }
  }

  pushArtifacts(artifacts: Artifact[] | undefined): void {
    if (artifacts) this.artifacts.push(...artifacts);
  }

  /** One interaction per turn: returns false when one was already registered. */
  pushInteraction(payload: InteractionPayload): boolean {
    if (this.interactions.length > 0) return false;
    this.interactions.push(payload);
    return true;
  }
}

export interface ToolRunContext {
  uid?: string;
  chatSessionId?: string;
  scope: SearchScope;
  collector: ResultCollector;
}
