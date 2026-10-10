import { config } from "../config/index.js";
import { createLogger } from "../logger.js";

const log = createLogger("MODELS");

/**
 * Model capability registry: answers "does this model support vision / tool calls?".
 *
 * Lookup precedence: local overrides (Higress-rewritten names) > OpenRouter metadata
 * (fetched from the public /api/v1/models endpoint, TTL-refreshed) > safe default.
 * Unknown model → text-only default; a fetch failure degrades silently (text-only)
 * and the next TTL tick retries — the service never crashes on metadata being absent.
 */
export interface ModelCapabilities {
  vision: boolean;
  toolCalls: boolean;
  contextLength?: number;
  source: "override" | "openrouter" | "default";
}

/**
 * Positive-knowledge vision gate: block image input only when a real data
 * source (MODELS__OVERRIDES or OpenRouter metadata) says the model is
 * text-only. Unknown models (source=default) pass through — the operator's
 * explicit model choice (OCR__MODEL / llm.model via Higress) outranks the
 * registry's text-only guess, which would otherwise block Higress-only
 * models (e.g. qwen-vl-ocr) that OpenRouter has never heard of. A truly
 * text-only model then fails at the upstream call and surfaces as an
 * upstream error instead of a local config error.
 */
export function isVisionBlocked(cap: ModelCapabilities): boolean {
  return !cap.vision && cap.source !== "default";
}

interface OpenRouterModel {
  id: string;
  context_length?: number;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  supported_parameters?: string[];
}

type Overrides = Record<string, Partial<Omit<ModelCapabilities, "source">>>;

/**
 * Product-knowledge capability hints for models the OpenRouter registry has
 * never heard of (gateway-native ids like DashScope's qwen3-max). Precedence:
 * MODELS__OVERRIDES (operator) > builtin > openrouter > default. Conservative
 * by design: models named qwen…/qwq… are vision-capable only when the name carries a VL-ish
 * marker (vl/omni/vision/ocr); deepseek* is a text-only family.
 */
export function builtinCapabilitiesFor(model: string): Partial<ModelCapabilities> | undefined {
  const m = model.toLowerCase();
  if (m.includes("/")) return undefined; // org-prefixed ids (openrouter naming) are not ours to judge
  if (/^qwen|^qwq/.test(m)) {
    if (/(vl|omni|vision|ocr)/.test(m)) return undefined; // vision family — let metadata/defaults speak
    return { vision: false };
  }
  if (/^deepseek/.test(m)) return { vision: false };
  return undefined;
}

export class ModelCapabilityRegistry {
  private openrouter = new Map<string, ModelCapabilities>();
  private lastRefresh = 0;
  private refreshing: Promise<void> | null = null;
  private readonly overrides: Overrides;

  constructor(
    private readonly modelsUrl: string = config.openrouter.modelsUrl,
    private readonly refreshHours: number = config.openrouter.refreshHours,
    private readonly timeoutMs: number = config.openrouter.timeoutMs,
    overridesJson: string = config.openrouter.overridesJson,
  ) {
    try {
      this.overrides = JSON.parse(overridesJson) as Overrides;
    } catch {
      log.error("[MODELS] MODELS__OVERRIDES is not valid JSON; overrides ignored");
      this.overrides = {};
    }
  }

  /** Fetch capabilities from OpenRouter. Never throws; returns false on failure. */
  async refresh(): Promise<boolean> {
    try {
      const res = await fetch(this.modelsUrl, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { data?: OpenRouterModel[] };
      const map = new Map<string, ModelCapabilities>();
      for (const m of json.data ?? []) {
        map.set(m.id, {
          vision: (m.architecture?.input_modalities ?? ["text"]).includes("image"),
          toolCalls: (m.supported_parameters ?? []).includes("tools"),
          contextLength: m.context_length,
          source: "openrouter",
        });
      }
      if (map.size === 0) throw new Error("empty model list");
      this.openrouter = map;
      this.lastRefresh = Date.now();
      log.info(`[MODELS] capabilities refreshed from openrouter: ${map.size} models`);
      return true;
    } catch (err) {
      log.warn(`[MODELS] openrouter refresh failed (keeping previous data): ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  /** Boot-time warmup: refresh in the background, then schedule TTL refreshes. */
  startBackgroundRefresh(): void {
    void this.refresh();
    const tick = setInterval(
      () => {
        if (Date.now() - this.lastRefresh >= this.refreshHours * 3_600_000) {
          void this.refresh();
        }
      },
      30 * 60_000,
    );
    tick.unref?.();
  }

  get(model: string): ModelCapabilities {
    const override = this.overrides[model];
    if (override) {
      return {
        vision: override.vision ?? false,
        toolCalls: override.toolCalls ?? true,
        contextLength: override.contextLength,
        source: "override",
      };
    }
    const builtin = builtinCapabilitiesFor(model);
    if (builtin) {
      return {
        vision: builtin.vision ?? false,
        toolCalls: builtin.toolCalls ?? true,
        contextLength: builtin.contextLength,
        source: "override", // product knowledge counts as a real answer, not a guess
      };
    }
    const meta = this.openrouter.get(model);
    if (meta) return meta;
    // safe default: assume text-only; tool calls on (ReAct agents need them)
    return { vision: false, toolCalls: true, source: "default" };
  }

  get known(): number {
    return this.openrouter.size;
  }

  get stale(): boolean {
    return Date.now() - this.lastRefresh > this.refreshHours * 3_600_000;
  }
}
