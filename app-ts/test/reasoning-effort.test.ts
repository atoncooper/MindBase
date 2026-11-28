import { describe, expect, it } from "vitest";
import {
  clampReasoningEffort,
  normalizeReasoningEffort,
  providerReasoningEffort,
} from "../src/agent/reasoning-effort.js";

describe("reasoning effort: continuous 0–100", () => {
  it("accepts numbers, clamps to 0–100 and rounds", () => {
    expect(normalizeReasoningEffort(0)).toBe(0);
    expect(normalizeReasoningEffort(50)).toBe(50);
    expect(normalizeReasoningEffort(100)).toBe(100);
    expect(normalizeReasoningEffort(42.6)).toBe(43);
    expect(normalizeReasoningEffort(-10)).toBe(0);
    expect(normalizeReasoningEffort(180)).toBe(100);
  });

  it("migrates legacy four-stop labels to their old positions", () => {
    expect(normalizeReasoningEffort("min")).toBe(0);
    expect(normalizeReasoningEffort("mid")).toBe(33);
    expect(normalizeReasoningEffort("high")).toBe(66);
    expect(normalizeReasoningEffort("max")).toBe(100);
    expect(normalizeReasoningEffort(" MID ")).toBe(33);
  });

  it("accepts numeric strings from older clients", () => {
    expect(normalizeReasoningEffort("75")).toBe(75);
    expect(normalizeReasoningEffort(" 5 ")).toBe(5);
  });

  it("drops unusable values so the request simply omits the field", () => {
    expect(normalizeReasoningEffort(undefined)).toBeUndefined();
    expect(normalizeReasoningEffort(null)).toBeUndefined();
    expect(normalizeReasoningEffort("")).toBeUndefined();
    expect(normalizeReasoningEffort("warm")).toBeUndefined();
    expect(normalizeReasoningEffort({})).toBeUndefined();
    expect(normalizeReasoningEffort(Number.NaN)).toBeUndefined();
  });

  it("buckets monotonically into the gateway enum, preserving the legacy ladder", () => {
    expect(providerReasoningEffort(0)).toBe("minimal");
    expect(providerReasoningEffort(29)).toBe("minimal");
    expect(providerReasoningEffort(30)).toBe("low");
    expect(providerReasoningEffort(33)).toBe("low"); // legacy mid
    expect(providerReasoningEffort(54)).toBe("low");
    expect(providerReasoningEffort(55)).toBe("medium");
    expect(providerReasoningEffort(66)).toBe("medium"); // legacy high
    expect(providerReasoningEffort(79)).toBe("medium");
    expect(providerReasoningEffort(80)).toBe("high");
    expect(providerReasoningEffort(100)).toBe("high"); // legacy max

    const order = ["minimal", "low", "medium", "high"];
    let previous = -1;
    for (let value = 0; value <= 100; value += 5) {
      const index = order.indexOf(providerReasoningEffort(value));
      expect(index).toBeGreaterThanOrEqual(previous);
      previous = index;
    }
  });

  it("clamp helper is the single normalization point for the slider", () => {
    expect(clampReasoningEffort(Number.NaN)).toBe(0);
    expect(clampReasoningEffort(101)).toBe(100);
  });
});
