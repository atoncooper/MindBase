import { describe, it, expect } from "vitest";
import {
  answerTexts,
  defaultTypeDistribution,
  splitSummaryToChunks,
  validateQuestion,
  QuizGenerationService,
  type QuizQuestionDict,
} from "../src/services/quiz-generation.js";
import type { SessionSummaryService } from "../src/services/session-summary.js";
import type { AppQuizClient } from "../src/services/app-quiz-client.js";
import { PromptRegistry } from "../src/agent/prompts/loader.js";

/**
 * Quiz generation port (quiz_from_summary.py + app/agent/quiz/graph.py core):
 * summary chunking, type distribution, answer-tracing validation and the batch
 * loop are the behaviours the Python generation owns.
 */

function serviceWith(generate: (args: { system: string; prompt: string; uid: number }) => Promise<QuizQuestionDict[]>) {
  return new QuizGenerationService({
    summaries: {} as unknown as SessionSummaryService,
    appQuiz: {} as unknown as AppQuizClient,
    generate,
    prompts: PromptRegistry.load(),
  });
}

describe("splitSummaryToChunks", () => {
  it("merges short paragraphs and drops fragments below 80 chars", () => {
    const paraA = "A".repeat(100);
    const paraB = "B".repeat(100);
    const chunks = splitSummaryToChunks(paraA + "\n\n" + paraB, 150, 20);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual({ title: "会话总结", content: paraA });
    expect(chunks[1].content).toBe(paraB);
  });

  it("drops paragraphs shorter than 80 chars", () => {
    const chunks = splitSummaryToChunks("too short", 600, 20);
    expect(chunks).toEqual([]);
  });

  it("hard-splits an overlong paragraph and caps maxChunks", () => {
    const long = "C".repeat(7000);
    const chunks = splitSummaryToChunks(long, 600, 20);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThanOrEqual(20);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(3000);
  });
});

describe("defaultTypeDistribution", () => {
  it("always sums to the requested count", () => {
    for (let count = 1; count <= 5; count += 1) {
      const dist = defaultTypeDistribution(count);
      const total = Object.values(dist).reduce((a, b) => a + b, 0);
      expect(total).toBe(count);
      expect(Object.values(dist).every((v) => v > 0)).toBe(true);
    }
  });

  it("is 60/20/20-ish for 5 questions", () => {
    expect(defaultTypeDistribution(5)).toEqual({ single_choice: 3, multi_choice: 1, short_answer: 1 });
  });
});

describe("answerTexts / validateQuestion", () => {
  const options = ["A. 收敛", "B. 发散", "C. 极限", "D. 单调"];
  const choice: QuizQuestionDict = {
    question: "哪个是发散？",
    type: "single_choice",
    difficulty: "medium",
    source_chunk_index: 0,
    options,
    correct_answer: "B",
    explanation: "e",
  };

  it("resolves a bare letter to the option text", () => {
    expect(answerTexts(choice)).toEqual(["发散"]);
  });

  it("accepts a well-formed choice question", () => {
    expect(validateQuestion(choice, [{ title: "t", content: "发散 收敛 极限" }])).toBe(true);
  });

  it("marks an untraced answer low-confidence but still accepts it", () => {
    const q: QuizQuestionDict = { ...choice, correct_answer: "D" };
    expect(validateQuestion(q, [{ title: "t", content: "完全无关的内容" }])).toBe(true);
    expect(q["_low_confidence"]).toBe(true);
  });

  it("rejects a choice question with too few options", () => {
    expect(validateQuestion({ ...choice, options: ["A. x"] }, [{ title: "t", content: "x" }])).toBe(false);
  });

  it("enforces multi_choice answer count", () => {
    const multi: QuizQuestionDict = { ...choice, type: "multi_choice", correct_answer: ["A", "C"] };
    expect(validateQuestion(multi, [{ title: "t", content: "收敛 极限" }])).toBe(true);
    const bad: QuizQuestionDict = { ...multi, correct_answer: ["A"] };
    expect(validateQuestion(bad, [{ title: "t", content: "收敛 极限" }])).toBe(false);
  });

  it("accepts short_answer with 3+ keywords and rejects without a template", () => {
    const short: QuizQuestionDict = {
      question: "q",
      type: "short_answer",
      difficulty: "easy",
      source_chunk_index: 0,
      keywords: ["闭包", "函数", "环境"],
      answer_template: "闭包是函数与其词法环境的组合。",
      explanation: "e",
    };
    expect(validateQuestion(short, [{ title: "t", content: "闭包 函数 环境" }])).toBe(true);
    expect(validateQuestion({ ...short, answer_template: "" }, [{ title: "t", content: "x" }])).toBe(false);
  });

  it("rejects unsupported question types", () => {
    expect(validateQuestion({ ...choice, type: "weird" }, [{ title: "t", content: "x" }])).toBe(false);
  });
});

describe("QuizGenerationService.generateQuestions", () => {
  const chunks = [{ title: "t", content: "收敛 发散 极限" }];
  const valid: QuizQuestionDict = {
    question: "q1",
    type: "single_choice",
    difficulty: "medium",
    source_chunk_index: 0,
    options: ["A. 收敛", "B. 发散", "C. 极限", "D. 单调"],
    correct_answer: "A",
    explanation: "e",
  };

  it("dedupes, drops invalid questions and honours the requested count", async () => {
    const svc = serviceWith(async () => [valid, { ...valid }, { ...valid, question: "q2", type: "weird" }]);
    const out = await svc.generateQuestions({
      chunks,
      totalCount: 2,
      typeDistribution: { single_choice: 2 },
      difficulty: "medium",
      uid: 7,
    });
    expect(out).toHaveLength(1);
    expect(out[0].question).toBe("q1");
  });

  it("returns no questions when the generator fails", async () => {
    const svc = serviceWith(async () => {
      throw new Error("网关 502");
    });
    const out = await svc.generateQuestions({
      chunks,
      totalCount: 1,
      typeDistribution: { single_choice: 1 },
      difficulty: "medium",
      uid: 7,
    });
    expect(out).toEqual([]);
  });
});
