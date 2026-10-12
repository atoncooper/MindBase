import { describe, it, expect } from "vitest";
import {
  answerTexts,
  defaultTypeDistribution,
  splitSummaryToChunks,
  validateQuestion,
  buildPersonalizationSection,
  buildExistingQuestionsBlock,
  extractQuestionRecords,
  renderExtractedProfile,
  isQuizImageFile,
  isQuizUploadFilename,
  normalizeStem,
  isNearDuplicateStem,
  stemSimilarity,
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

describe("generateQuestions free-mode source_chunk_index", () => {
  const chunk = { title: "出题主题", content: "数学1 模拟测试" };
  const base: QuizQuestionDict = {
    question: "q",
    type: "single_choice",
    difficulty: "medium",
    source_chunk_index: 0,
    options: ["A. 收敛", "B. 发散", "C. 极限", "D. 单调"],
    correct_answer: "A",
    explanation: "e",
  };
  const free = { topic: "数学1", material: "", difficultyPlan: "medium" };

  it("coerces out-of-range / non-integer indices to 0 instead of rejecting the batch", async () => {
    const svc = serviceWith(async () => [
      { ...structuredClone(base), source_chunk_index: 1 },
      { ...structuredClone(base), question: "q2", source_chunk_index: "x" },
      { ...structuredClone(base), question: "q3", source_chunk_index: -2 },
    ]);
    const out = await svc.generateQuestions({
      chunks: [chunk],
      totalCount: 3,
      typeDistribution: { single_choice: 3 },
      difficulty: "medium",
      uid: 7,
      free,
    });
    expect(out).toHaveLength(3);
    expect(out.every((q) => q.source_chunk_index === 0)).toBe(true);
  });

  it("kb mode still rejects an out-of-range source_chunk_index (provenance matters)", async () => {
    const svc = serviceWith(async () => [{ ...structuredClone(base), source_chunk_index: 3 }]);
    const out = await svc.generateQuestions({
      chunks: [chunk],
      totalCount: 1,
      typeDistribution: { single_choice: 1 },
      difficulty: "medium",
      uid: 7,
    });
    expect(out).toEqual([]);
  });
});

describe("buildPersonalizationSection", () => {
  it("returns empty when nothing is set", () => {
    expect(buildPersonalizationSection({})).toBe("");
  });

  it("composes style + skills + injection-wrapped instructions", () => {
    const out = buildPersonalizationSection({
      styleSection: "## 出题风格：高考卷面",
      skillsSection: "## 用户指定技能（本次对话必须遵循）### 技能：x",
      instructions: "多出计算题",
    });
    expect(out).toContain("## 出题风格：高考卷面");
    expect(out).toContain("### 技能：x");
    expect(out).toContain("<custom_instructions>");
    expect(out).toContain("多出计算题");
    // instructions come last
    expect(out.indexOf("<custom_instructions>")).toBeGreaterThan(out.indexOf("### 技能：x"));
  });

  it("caps instruction length at 4000 chars", () => {
    const out = buildPersonalizationSection({ instructions: "x".repeat(5000) });
    const body = out.slice(out.indexOf("<custom_instructions>"), out.indexOf("</custom_instructions>"));
    expect(body.length).toBeLessThan(4200);
  });
});

describe("extractQuestionRecords", () => {
  it("parses the object form and validates against the schema", () => {
    const raw = JSON.stringify({
      questions: [
        { question: "求极限", options: ["A. 1", "B. 0"], answer: "A", knowledge_points: ["极限", "洛必达"], subject: "数学" },
        { question: "简述闭包", knowledge_points: ["闭包"] },
      ],
    });
    const out = extractQuestionRecords("前置噪声 {\n" + raw + "\n} 后置噪声");
    expect(out).toHaveLength(2);
    expect(out![0].knowledge_points).toEqual(["极限", "洛必达"]);
    expect(out![1].answer).toBeUndefined();
  });

  it("accepts the bare array form", () => {
    const raw = JSON.stringify([{ question: "q", knowledge_points: ["kp"] }]);
    expect(extractQuestionRecords(raw)).toHaveLength(1);
  });

  it("rejects records without knowledge_points", () => {
    expect(extractQuestionRecords(JSON.stringify({ questions: [{ question: "q" }] }))).toBeUndefined();
  });

  it("returns undefined for non-JSON text", () => {
    expect(extractQuestionRecords("完全没有 JSON 的文本")).toBeUndefined();
  });
});

describe("renderExtractedProfile", () => {
  const records = [
    { question: "求 f(x) 的极值", options: ["A. 极大", "B. 极小"], answer: "A", knowledge_points: ["导数", "极值"], subject: "数学" },
    { question: "证明中值定理", knowledge_points: ["微分中值定理"] },
  ];

  it("wrong_images mode renders the reinforcement directive", () => {
    const out = renderExtractedProfile(records, "wrong_images");
    expect(out).toContain("错题材料共 2 道题");
    expect(out).toContain("已标注答案：A");
    expect(out).toContain("（材料中未见答案）");
    expect(out).toContain("变式新题");
  });

  it("mimic mode renders the imitation directive", () => {
    const out = renderExtractedProfile(records, "mimic");
    expect(out).toContain("参考试卷/练习材料共 2 道题");
    expect(out).toContain("模仿");
  });
});

describe("upload filename gates", () => {
  it("classifies images and text documents", () => {
    expect(isQuizImageFile("IMG_1.PNG")).toBe(true);
    expect(isQuizImageFile("a.pdf")).toBe(false);
    expect(isQuizUploadFilename("a.pdf")).toBe(true);
    expect(isQuizUploadFilename("a.docx")).toBe(true);
    expect(isQuizUploadFilename("a.exe")).toBe(false);
    expect(isQuizUploadFilename("no-ext")).toBe(false);
  });
});

describe("cross-batch dedupe helpers", () => {
  it("normalizes punctuation / whitespace / case", () => {
    expect(normalizeStem("  Hello, World! ")).toBe("helloworld");
    expect(normalizeStem("TCP 三次握手？")).toBe(normalizeStem("tcp三次握手"));
  });

  it("flags normalized-exact and paraphrase-level duplicates", () => {
    const existing = [normalizeStem("TCP 三次握手的过程中，SYN 报文的作用是什么？")];
    expect(isNearDuplicateStem("TCP三次握手的过程中，SYN报文的作用是什么?", existing)).toBe(true);
    expect(isNearDuplicateStem("UDP 协议与 TCP 协议的核心区别是什么？", existing)).toBe(false);
    expect(isNearDuplicateStem("", existing)).toBe(true);
  });

  it("similarity is 1 for identical and 0 for empty", () => {
    expect(stemSimilarity("三次握手", "三次握手")).toBe(1);
    expect(stemSimilarity("", "x")).toBe(0);
  });
});

describe("buildExistingQuestionsBlock", () => {
  it("is empty when nothing accepted yet", () => {
    expect(buildExistingQuestionsBlock([])).toBe("");
  });

  it("lists stems, knowledge points and the avoidance instruction", () => {
    const out = buildExistingQuestionsBlock([
      { question: "题干一", related_entities: ["TCP", "三次握手"] },
      { question: "题干二", related_entities: [] },
    ]);
    expect(out).toContain("已生成的题目");
    expect(out).toContain("1. 题干一");
    expect(out).toContain("2. 题干二");
    expect(out).toContain("已覆盖知识点：TCP、三次握手");
  });

  it("caps the stem list to the most recent ones", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ question: "q" + i, related_entities: [] }));
    const out = buildExistingQuestionsBlock(many, 24);
    // 取最近 24 条（后段），题号在块内重新编号
    expect(out).toContain("1. q16");
    expect(out).toContain("24. q39");
    expect(out).not.toContain("q15");
  });
});

describe("generateQuestions with checkpoint + anti-dup context", () => {
  const chunk = { title: "t", content: "TCP 三次握手用于建立可靠连接，SYN 报文用于同步序号。UDP 是无连接的传输层协议。" };
  const q1: QuizQuestionDict = {
    question: "TCP 三次握手用于建立什么？",
    type: "single_choice",
    difficulty: "medium",
    source_chunk_index: 0,
    options: ["A. 可靠连接", "B. 无连接服务", "C. 流量控制", "D. 拥塞控制"],
    correct_answer: "A",
    explanation: "e",
    related_entities: ["TCP"],
  };
  const q2: QuizQuestionDict = {
    question: "SYN 报文在握手中的作用是？",
    type: "single_choice",
    difficulty: "medium",
    source_chunk_index: 0,
    options: ["A. 同步序号", "B. 释放连接", "C. 流量控制", "D. 校验数据"],
    correct_answer: "A",
    explanation: "e",
    related_entities: ["SYN"],
  };
  const q3: QuizQuestionDict = {
    question: "UDP 的传输层特点是什么？",
    type: "single_choice",
    difficulty: "medium",
    source_chunk_index: 0,
    options: ["A. 无连接", "B. 可靠传输", "C. 面向字节流", "D. 拥塞退避"],
    correct_answer: "A",
    explanation: "e",
    related_entities: ["UDP"],
  };

  it("dedupes paraphrase repeats across batches and checkpoints cumulatively", async () => {
    const prompts: string[] = [];
    let call = 0;
    const svc = serviceWith(async (args) => {
      prompts.push(args.prompt);
      call += 1;
      if (call === 1) return [structuredClone(q1), structuredClone(q2)];
      return [structuredClone(q1), structuredClone(q3)]; // batch2: q1 换皮重复 + q3 新题
    });
    const checkpoints: number[] = [];
    const out = await svc.generateQuestions({
      chunks: [chunk],
      totalCount: 3,
      typeDistribution: { single_choice: 3 },
      difficulty: "medium",
      uid: 7,
      checkpoint: async (accepted) => {
        checkpoints.push(accepted.length);
      },
    });
    expect(out).toHaveLength(3);
    // 第二批 prompt 注入了已生成题目负面清单
    expect(prompts[1]).toContain("已生成的题目");
    expect(prompts[1]).toContain("TCP 三次握手用于建立什么？");
    // checkpoint 每批累计调用：第一批 2 题，第二批 3 题
    expect(checkpoints).toEqual([2, 3]);
  });
});
