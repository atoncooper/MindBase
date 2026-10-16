import { describe, expect, it } from "vitest";
import {
  buildContinuationPlan,
  countByType,
  questionDocToDict,
  remainingDistribution,
  type PlanItem,
} from "../src/services/quiz-generation.js";

describe("questionDocToDict（内容记忆重建）", () => {
  it("映射 Mongo 文档字段并解析 JSON 字符串列表", () => {
    const dict = questionDocToDict({
      question_uuid: "q-1",
      question_text: "什么是 PV 操作？",
      question_type: "essay",
      difficulty: "hard",
      explanation: "信号量机制",
      options: JSON.stringify(["A", "B"]),
      correct_answer: JSON.stringify(["A", "B"]),
      keywords: JSON.stringify(["信号量", "互斥"]),
      related_entities: JSON.stringify(["操作系统"]),
    });
    expect(dict["question"]).toBe("什么是 PV 操作？");
    expect(dict["type"]).toBe("essay");
    expect(dict["difficulty"]).toBe("hard");
    expect(dict["source_chunk_index"]).toBe(0);
    expect(dict["question_uuid"]).toBe("q-1");
    expect(dict["options"]).toEqual(["A", "B"]);
    expect(dict["correct_answer"]).toEqual(["A", "B"]);
    expect(dict["keywords"]).toEqual(["信号量", "互斥"]);
    expect(dict["related_entities"]).toEqual(["操作系统"]);
  });

  it("裸字符串 correct_answer 原样保留（round-trip 稳定）", () => {
    const dict = questionDocToDict({ question_text: "1+1=?", question_type: "single_choice", correct_answer: "B" });
    expect(dict["correct_answer"]).toBe("B");
  });

  it("缺省字段填充安全默认", () => {
    const dict = questionDocToDict({});
    expect(dict["question"]).toBe("");
    expect(dict["difficulty"]).toBe("medium");
    expect(dict["source_chunk_index"]).toBe(0);
    expect("options" in dict).toBe(false);
  });
});

describe("countByType / remainingDistribution（题型对账）", () => {
  it("按题型计数", () => {
    const dicts = [
      { type: "single_choice" },
      { type: "single_choice" },
      { type: "essay" },
      {},
    ] as Array<Record<string, unknown>>;
    expect(countByType(dicts)).toEqual({ single_choice: 2, essay: 1 });
  });

  it("剩余分布 = 目标 − 既有，负数截 0", () => {
    expect(
      remainingDistribution(
        { single_choice: 40, essay: 7 },
        { single_choice: 30, essay: 9 },
      ),
    ).toEqual({ single_choice: 10, essay: 0 });
  });
});

describe("buildContinuationPlan（剩余槽位计划）", () => {
  const plan408: PlanItem[] = [
    ...Array.from({ length: 40 }, () => ({ type: "single_choice", difficulty: "medium", hint: "单项选择题 · 四门混排", score: 2 })),
    ...Array.from({ length: 7 }, () => ({ type: "essay", difficulty: "hard", hint: "综合应用题 · 算法题含复杂度分析", score: 10 })),
  ];

  it("蓝本模式：按题型消耗既有槽位，剩余槽位保持蓝本节序与 hint", () => {
    const out = buildContinuationPlan(plan408, { single_choice: 40, essay: 7 }, { single_choice: 30, essay: 0 });
    expect(out).toHaveLength(17);
    expect(out.filter((p) => p.type === "single_choice")).toHaveLength(10);
    expect(out.filter((p) => p.type === "essay")).toHaveLength(7);
    // 单选在前（蓝本节序），hint 原样保留
    expect(out[0].type).toBe("single_choice");
    expect(out[0].hint).toBe("单项选择题 · 四门混排");
    expect(out[10].type).toBe("essay");
    expect(out[10].hint).toBe("综合应用题 · 算法题含复杂度分析");
  });

  it("蓝本模式：单选已齐时只补剩余综合题", () => {
    const out = buildContinuationPlan(plan408, { single_choice: 40, essay: 7 }, { single_choice: 40, essay: 5 });
    expect(out).toHaveLength(2);
    expect(out.every((p) => p.type === "essay")).toBe(true);
  });

  it("无蓝本（老卷降级）：按剩余分布展开（题型兜底分值）", () => {
    const out = buildContinuationPlan(null, { single_choice: 10, essay: 3 }, { single_choice: 8, essay: 3 });
    expect(out).toEqual([
      { type: "single_choice", difficulty: "medium", hint: "", score: 2 },
      { type: "single_choice", difficulty: "medium", hint: "", score: 2 },
    ]);
  });

  it("已全部完成 → 空计划", () => {
    expect(buildContinuationPlan(plan408, { single_choice: 40, essay: 7 }, { single_choice: 40, essay: 7 })).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { expandBlueprintPlan } from "../src/services/quiz-generation.js";
import { blueprintExamTotal } from "../src/services/quiz-exam-blueprints.js";

describe("expandBlueprintPlan 分值展开", () => {
  const bp408 = {
    id: "kaoyan-408",
    category: "升学 · 考研",
    name: "408 计算机学科基础",
    description: "",
    durationMinutes: 180,
    totalScore: 150,
    sections: [
      { subject: "单项选择题", items: [{ type: "single_choice", count: 40, score: 2 }] },
      { subject: "综合应用题", items: [{ type: "essay", count: 7, score: 10 }] },
    ],
  } as const;

  it("整卷：分值精确且合计等于考试总分", () => {
    const plan = expandBlueprintPlan(bp408, 47, "medium");
    expect(plan).toHaveLength(47);
    const singles = plan.filter((p) => p.type === "single_choice");
    const essays = plan.filter((p) => p.type === "essay");
    expect(singles.every((p) => p.score === 2)).toBe(true);
    expect(essays.every((p) => p.score === 10)).toBe(true);
    expect(plan.reduce((a, p) => a + p.score, 0)).toBe(150);
  });

  it("缩卷（20 题）：每题分值保持固有属性，不随抽题缩水", () => {
    const plan = expandBlueprintPlan(bp408, 20, "medium");
    const singles = plan.filter((p) => p.type === "single_choice");
    const essays = plan.filter((p) => p.type === "essay");
    expect(singles.every((p) => p.score === 2)).toBe(true);
    expect(essays.every((p) => p.score === 10)).toBe(true);
  });

  it("未标注分值项按考试总分均摊（考研数学解答 70/6）", () => {
    const bp = {
      id: "kaoyan-math1",
      category: "升学 · 考研",
      name: "考研数学一",
      description: "",
      durationMinutes: 180,
      totalScore: 150,
      sections: [
        { subject: "单项选择题", items: [{ type: "single_choice", count: 10, score: 5 }] },
        { subject: "填空题", items: [{ type: "short_answer", count: 6, score: 5 }] },
        { subject: "解答题", items: [{ type: "essay", count: 6 }] },
      ],
    } as const;
    const plan = expandBlueprintPlan(bp, 22, "medium");
    const essays = plan.filter((p) => p.type === "essay");
    expect(essays).toHaveLength(6);
    expect(essays.reduce((a, p) => a + p.score, 0)).toBe(70);
    expect(essays[0].score).toBe(12);
    expect(essays[5].score).toBe(11);
    expect(plan.filter((p) => p.type === "single_choice").every((p) => p.score === 5)).toBe(true);
  });

  it("blueprintExamTotal：标注总分优先", () => {
    expect(blueprintExamTotal(bp408)).toBe(150);
  });
});
