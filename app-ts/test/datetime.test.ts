import { describe, it, expect } from "vitest";
import { formatDateIn, today, partitionNameForMonth, isValidTimeZone } from "../src/utils/datetime.js";

// 2026-10-03T16:30:00Z  →  UTC date 2026-10-03, Asia/Shanghai 2026-10-04 00:30
const UTC_SHANGHAI_BOUNDARY = new Date("2026-10-03T16:30:00Z");
// 2026-12-31T16:30:00Z  →  Asia/Shanghai 2027-01-01 00:30 (month AND year rollover)
const MONTH_YEAR_BOUNDARY = new Date("2026-12-31T16:30:00Z");

describe("formatDateIn", () => {
  it("uses the target timezone, not UTC (the daily 00:00–08:00 CST bug)", () => {
    expect(formatDateIn(UTC_SHANGHAI_BOUNDARY, "UTC")).toBe("2026-10-03");
    expect(formatDateIn(UTC_SHANGHAI_BOUNDARY, "Asia/Shanghai")).toBe("2026-10-04");
  });

  it("handles month and year rollover", () => {
    expect(formatDateIn(MONTH_YEAR_BOUNDARY, "Asia/Shanghai")).toBe("2027-01-01");
    expect(formatDateIn(MONTH_YEAR_BOUNDARY, "UTC")).toBe("2026-12-31");
  });

  it("invalid timezone falls back to UTC instead of throwing", () => {
    expect(formatDateIn(UTC_SHANGHAI_BOUNDARY, "Mars/Olympus")).toBe("2026-10-03");
  });

  it("isValidTimeZone", () => {
    expect(isValidTimeZone("Asia/Shanghai")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
  });
});

describe("partitionNameForMonth", () => {
  it("names partitions by local month (Asia/Shanghai)", () => {
    expect(partitionNameForMonth(UTC_SHANGHAI_BOUNDARY, "Asia/Shanghai")).toBe("_2026_10");
    // 16:00 UTC on Dec 31 is already Jan 1 in Shanghai
    expect(partitionNameForMonth(new Date("2026-12-31T16:00:00Z"), "Asia/Shanghai")).toBe("_2027_01");
    expect(partitionNameForMonth(new Date("2026-12-31T15:59:00Z"), "Asia/Shanghai")).toBe("_2026_12");
    expect(partitionNameForMonth(new Date("2026-12-31T23:59:00Z"), "UTC")).toBe("_2026_12");
  });
});

describe("today", () => {
  it("returns YYYY-MM-DD in the configured timezone shape", () => {
    expect(today("UTC")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(today("Asia/Shanghai")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
