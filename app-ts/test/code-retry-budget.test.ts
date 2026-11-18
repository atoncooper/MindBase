import { describe, expect, it } from "vitest";
import { CodeRetryBudget } from "../src/tools/code/retry-budget.js";

describe("CodeRetryBudget", () => {
  it("同一代码版本最多 6 次（首次 + 5 retry），改动代码后重置", () => {
    const budget = new CodeRetryBudget();
    const identity = { uid: "7", sessionId: "s1", language: "python", code: "print(1)" };
    const first = budget.begin(identity);
    expect(first.allowed).toBe(true);
    expect(first.attempt).toBe(1);
    for (let i = 2; i <= 6; i += 1) {
      const decision = budget.begin(identity);
      expect(decision.allowed).toBe(true);
      expect(decision.attempt).toBe(i);
    }
    const blocked = budget.begin(identity);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remainingRetries).toBe(0);

    const changed = budget.begin({ ...identity, code: "print(2)" });
    expect(changed.allowed).toBe(true);
    expect(changed.attempt).toBe(1);
  });

  it("成功或未执行会清除/退还预算", () => {
    const budget = new CodeRetryBudget();
    const identity = { uid: "7", sessionId: "s1", language: "python", code: "print(1)" };
    const first = budget.begin(identity);
    budget.success(first.key);
    expect(budget.begin(identity).attempt).toBe(1);

    const second = budget.begin(identity);
    expect(second.attempt).toBe(2);
    budget.refund(second.key);
    const third = budget.begin(identity);
    expect(third.attempt).toBe(2);
  });
});
