import { describe, it, expect } from "vitest";
import {
  gradeMultiChoice,
  gradeShortAnswer,
  gradeSingleChoice,
  questionField,
  safeJson,
} from "../src/services/quiz-grading.js";

/**
 * Quiz grading port (quiz_grader.py): objective grading is deterministic, so
 * these helpers carry the behaviour contract.
 */

describe("safeJson / questionField", () => {
  it("parses JSON strings and passes through other values", () => {
    expect(safeJson('["A","B"]')).toEqual(["A", "B"]);
    expect(safeJson("A")).toBe("A");
    expect(safeJson(null)).toBeNull();
    expect(safeJson({ a: 1 })).toEqual({ a: 1 });
    expect(safeJson("{not json")).toBe("{not json");
  });

  it("prefers the first present non-null field", () => {
    expect(questionField({ answer_template: "t" }, "correct_answer", "answer_template")).toBe("t");
    expect(questionField({ correct_answer: null, answer_template: "t" }, "correct_answer", "answer_template")).toBe("t");
    expect(questionField({}, "a", "b")).toBeNull();
  });
});

describe("gradeSingleChoice", () => {
  it("compares case-insensitively after trimming", () => {
    expect(gradeSingleChoice(" a ", "A")).toMatchObject({ is_correct: true, auto_score: 10 });
    expect(gradeSingleChoice("B", "A")).toMatchObject({ is_correct: false, auto_score: 0 });
  });
});

describe("gradeMultiChoice", () => {
  it("awards full credit for the exact set", () => {
    const r = gradeMultiChoice(["A", "C"], ["A", "C"]);
    expect(r.is_correct).toBe(true);
    expect(r.auto_score).toBe(10);
  });

  it("applies partial credit with a wrong-pick penalty", () => {
    // correct set has 2 -> 5 points per correct pick; 1 correct + 1 wrong => 0
    const r = gradeMultiChoice(["A", "D"], ["A", "C"]);
    expect(r.is_correct).toBe(false);
    expect(r.auto_score).toBe(0);
  });

  it("is order-insensitive", () => {
    expect(gradeMultiChoice(["C", "A"], ["A", "C"]).is_correct).toBe(true);
  });
});

describe("gradeShortAnswer", () => {
  it("scores by keyword match rate and passes at >= 0.8", () => {
    const r = gradeShortAnswer("闭包是函数和词法环境的组合", ["闭包", "函数", "环境"]);
    expect(r.matched_keywords).toEqual(["闭包", "函数", "环境"]);
    expect(r.keyword_match_rate).toBe(1);
    expect(r.is_correct).toBe(true);
    expect(r.auto_score).toBe(10);
    expect(r.grading_note).toContain("关键词自动评分");
  });

  it("returns 0 for no keywords matched", () => {
    const r = gradeShortAnswer("完全无关", ["闭包", "函数"]);
    expect(r.is_correct).toBe(false);
    expect(r.auto_score).toBe(0);
  });

  it("tolerates missing keywords", () => {
    expect(gradeShortAnswer("x", null).auto_score).toBe(0);
  });
});
