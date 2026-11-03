import { describe, expect, it } from "vitest";
import { maxStepsFor } from "../src/agent/react.js";
import { config } from "../src/config/index.js";

/** Per-agent ReAct budgets (P0): writing-heavy agents need more than the global Q&A budget. */
describe("maxStepsFor", () => {
  it("uses per-agent overrides from config", () => {
    expect(maxStepsFor("academic")).toBe(12);
    expect(maxStepsFor("note")).toBe(5);
    expect(maxStepsFor("code")).toBe(4);
    expect(maxStepsFor("quiz")).toBe(12);
    expect(maxStepsFor("board")).toBe(6);
  });

  it("falls back to the global budget for unlisted agents", () => {
    expect(maxStepsFor("main")).toBe(config.agent.maxSteps);
    expect(maxStepsFor("unknown-agent")).toBe(config.agent.maxSteps);
  });
});
