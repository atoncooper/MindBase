import { describe, it, expect } from "vitest";
import {
  noteTurnLevel,
  currentTurnLevel,
  searchKFor,
  historyLimitFor,
  maxOutputTokensFor,
} from "../src/utils/degrade.js";
import { config } from "../src/config/index.js";

/**
 * 降级阶梯（L1 省流）的登记/读取与三个取值杠杆：检索条数、历史窗口、
 * 输出预算。登记按 uid 隔离；匿名（无 uid）恒为 L0。
 */

describe("degrade ladder registry", () => {
  it("notes and reads the per-uid level; unknown uids are L0", () => {
    noteTurnLevel("u1", "L1");
    expect(currentTurnLevel("u1")).toBe("L1");
    expect(currentTurnLevel("u2")).toBe("L0");
    expect(currentTurnLevel(undefined)).toBe("L0");
  });

  it("L1 halves the retrieval k with a floor of 3; explicit k is not overridden here", () => {
    noteTurnLevel("u1", "L1");
    expect(searchKFor("u1", 8)).toBe(4);
    expect(searchKFor("u1", 5)).toBe(3); // floor
    noteTurnLevel("u1", "L0");
    expect(searchKFor("u1", 8)).toBe(8);
  });

  it("L1 halves the history keep with a floor of 2", () => {
    expect(historyLimitFor(6, "L1")).toBe(3);
    expect(historyLimitFor(3, "L1")).toBe(2); // floor
    expect(historyLimitFor(6, "L0")).toBe(6);
  });

  it("L1 caps the output budget from config; L0 is unlimited (0)", () => {
    const saved = config.quota.l1MaxOutputTokens;
    try {
      config.quota.l1MaxOutputTokens = 2048;
      noteTurnLevel("u1", "L1");
      expect(maxOutputTokensFor("u1")).toBe(2048);
      noteTurnLevel("u1", "L0");
      expect(maxOutputTokensFor("u1")).toBe(0);
      expect(maxOutputTokensFor(undefined)).toBe(0);
    } finally {
      config.quota.l1MaxOutputTokens = saved;
    }
  });
});
