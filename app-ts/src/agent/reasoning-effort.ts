/**
 * Composer reasoning effort (continuous 0–100) → provider `reasoning_effort`.
 *
 * The UI exposes a free slider (0 = lightest, 100 = strongest). The OpenAI-
 * compatible gateway only accepts a small enum, so the continuous value is
 * bucketed here into the values the gateway already understands. The mapping is
 * monotonic and preserves the legacy four-stop ladder:
 *
 *   legacy "min"  (0)   -> minimal
 *   legacy "mid"  (33)  -> low      (the default 50 also lands on "low")
 *   legacy "high" (66)  -> medium
 *   legacy "max"  (100) -> high
 *
 * `normalizeReasoningEffort` accepts a number (0–100, clamped + rounded) or a
 * legacy string ("min"/"mid"/"high"/"max") from older clients; anything else is
 * undefined so the request simply omits the field.
 */

export const REASONING_EFFORT_MIN = 0;
export const REASONING_EFFORT_MAX = 100;

export type ProviderReasoningEffort = "minimal" | "low" | "medium" | "high";

/** Legacy four-stop labels from the pre-slider UI (kept for API compatibility). */
const LEGACY_STOPS: Record<string, number> = { min: 0, mid: 33, high: 66, max: 100 };

export function clampReasoningEffort(value: number): number {
  if (!Number.isFinite(value)) return REASONING_EFFORT_MIN;
  return Math.min(REASONING_EFFORT_MAX, Math.max(REASONING_EFFORT_MIN, Math.round(value)));
}

/** Number | legacy label | numeric string → clamped 0–100 (undefined when unusable). */
export function normalizeReasoningEffort(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? clampReasoningEffort(value) : undefined;
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return undefined;
  if (trimmed in LEGACY_STOPS) return LEGACY_STOPS[trimmed];
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? clampReasoningEffort(parsed) : undefined;
}

/** Bucket the continuous effort into the gateway's enum (monotonic, legacy-aligned). */
export function providerReasoningEffort(effort: number): ProviderReasoningEffort {
  const value = clampReasoningEffort(effort);
  if (value < 30) return "minimal";
  if (value < 55) return "low";
  if (value < 80) return "medium";
  return "high";
}
