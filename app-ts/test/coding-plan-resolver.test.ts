import { describe, expect, it } from "vitest";
import {
  createCodingPlanResolver,
  type CodingPlanLookup,
  type CodingPlanQuota,
} from "../src/agent/code/coding-plan-resolver.js";
import type { CodingPlan } from "../src/llm/coding-plan.js";

function plan(over: Partial<CodingPlan> = {}): CodingPlan {
  return {
    id: 1,
    provider: "custom",
    protocol: "openai",
    label: "test-plan",
    base_url: "https://api.example.com/v1",
    model: "",
    api_key: "sk-test",
    is_default: true,
    ...over,
  };
}

function lookup(over: Partial<CodingPlanLookup> = {}): CodingPlanLookup {
  return {
    getCodingPlan: async () => plan(),
    getCodingPlanModels: async () => ["model-a", "model-b"],
    ...over,
  };
}

function quota(allowed = true): CodingPlanQuota {
  return { consumeKind: async () => allowed };
}

const silent = { info: () => {}, warn: () => {} };

describe("coding plan resolver", () => {
  it("uses the plan's configured model by default", async () => {
    const resolve = createCodingPlanResolver({
      plans: lookup({ getCodingPlan: async () => plan({ model: "picked-model" }) }),
      quota: quota(),
      logger: silent,
    });
    const res = await resolve({ uid: "1", sessionId: "s1" });
    expect(res?.modelId).toBe("picked-model");
  });

  it("falls back to the first cached catalog entry when the plan has no model", async () => {
    const resolve = createCodingPlanResolver({
      plans: lookup(),
      quota: quota(),
      logger: silent,
    });
    const res = await resolve({ uid: "1" });
    expect(res?.modelId).toBe("model-a");
  });

  it("lets an explicit chat-dialog pick win", async () => {
    const resolve = createCodingPlanResolver({
      plans: lookup(),
      quota: quota(),
      logger: silent,
    });
    const res = await resolve({ uid: "1", model: "model-b" });
    expect(res?.modelId).toBe("model-b");
  });

  it("falls back to the gateway when the catalog is empty", async () => {
    const resolve = createCodingPlanResolver({
      plans: lookup({ getCodingPlanModels: async () => [] }),
      quota: quota(),
      logger: silent,
    });
    await expect(resolve({ uid: "1" })).resolves.toBeUndefined();
  });

  it("falls back to the gateway when the plan is not the default (no explicit pick)", async () => {
    const resolve = createCodingPlanResolver({
      plans: lookup({ getCodingPlan: async () => plan({ is_default: false }) }),
      quota: quota(),
      logger: silent,
    });
    await expect(resolve({ uid: "1" })).resolves.toBeUndefined();
  });

  it("still honors an explicit pick on a non-default plan", async () => {
    const resolve = createCodingPlanResolver({
      plans: lookup({ getCodingPlan: async () => plan({ is_default: false }) }),
      quota: quota(),
      logger: silent,
    });
    const res = await resolve({ uid: "1", model: "model-b" });
    expect(res?.modelId).toBe("model-b");
  });

  it("falls back to the gateway when the plan quota is exhausted", async () => {
    const resolve = createCodingPlanResolver({
      plans: lookup(),
      quota: quota(false),
      logger: silent,
    });
    await expect(resolve({ uid: "1" })).resolves.toBeUndefined();
  });
});
