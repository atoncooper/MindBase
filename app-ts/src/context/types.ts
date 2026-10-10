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

/** Collects tool-produced sources / artifacts / interactions within a single conversation turn, emitted together at the SSE stream tail */
export class ResultCollector {
  readonly sources: Source[] = [];
  readonly artifacts: Artifact[] = [];
  readonly interactions: InteractionPayload[] = [];

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
