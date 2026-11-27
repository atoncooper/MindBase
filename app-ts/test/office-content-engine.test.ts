import { describe, expect, it } from "vitest";

import {
  ContentEngineError,
  composeDocument,
  type ComposeResult,
  type TextGenerationPort,
} from "../src/services/office/content-engine.js";
import type { FactCheckPort, FactCheckVerdictItem } from "../src/services/office/fact-check.js";
import { validateDocumentIR } from "../src/services/office/ir.js";

/**
 * Stage engine tests: a FakeLlm returns fixed JSON per stage purpose so the
 * pipeline order, repair retries, quality-fix trigger and error mapping can all
 * be asserted offline (no gateway, no filesystem writes).
 */

type GenerateInput = Parameters<TextGenerationPort["generate"]>[0];

class FakeLlm implements TextGenerationPort {
  readonly calls: GenerateInput[] = [];

  constructor(private readonly handler: (input: GenerateInput, callIndex: number) => string | Error) {}

  async generate(input: GenerateInput): Promise<string> {
    this.calls.push(input);
    const result = this.handler(input, this.calls.length - 1);
    if (result instanceof Error) throw result;
    return result;
  }

  callsFor(purpose: string): GenerateInput[] {
    return this.calls.filter((call) => call.purpose === purpose);
  }
}

const SECTION_ONE_TEXT = "本季度完成 12 个交付项目，营收 3200 万元，数据来自财务部季度报表。";
const SECTION_TWO_TEXT = "交付延期集中在接口联调环节，下季度增加联调环境并明确责任人。";

const PLAN_JSON = JSON.stringify({
  title: "2026 年第三季度工作报告",
  subtitle: "经营复盘与下季度计划",
  meta: { date: "2026 年 10 月" },
  sections: [
    { heading: "本季度目标完成情况", goal: "用数据说明目标完成度", blockPlan: ["paragraph"] },
    { heading: "问题与改进", goal: "说明主要问题与改进动作", blockPlan: ["paragraph"] },
  ],
});

function sectionJson(text: string): string {
  return JSON.stringify({ blocks: [{ type: "paragraph", text }] });
}

function documentJson(title: string, sections: Array<{ heading: string; text: string }>): string {
  return JSON.stringify({
    version: 1,
    title,
    sections: sections.map((entry) => ({
      heading: entry.heading,
      blocks: [{ type: "paragraph", text: entry.text }],
    })),
  });
}

const GOOD_DOCUMENT_JSON = documentJson("2026 年第三季度工作报告", [
  { heading: "本季度目标完成情况", text: SECTION_ONE_TEXT },
  { heading: "问题与改进", text: SECTION_TWO_TEXT },
]);

const FILLER =
  "首先，众所周知，本节介绍了相关工作，具有重要意义，综上所述，希望对你有帮助。";

const BAD_DOCUMENT_JSON = documentJson("低质量报告", [
  { heading: "第一部分", text: FILLER },
  { heading: "第二部分", text: FILLER },
  { heading: "第三部分", text: FILLER },
]);

function defaultHandler(input: GenerateInput): string {
  if (input.purpose === "office_content_plan") return PLAN_JSON;
  if (input.purpose === "office_content_section") {
    return input.user.includes("问题与改进") ? sectionJson(SECTION_TWO_TEXT) : sectionJson(SECTION_ONE_TEXT);
  }
  return GOOD_DOCUMENT_JSON;
}

const BASE_INPUT = {
  brief: "写一份第三季度工作报告，覆盖目标完成情况与问题改进。",
  templateId: "work-report" as const,
  facts: "本季度完成 12 个交付项目，营收 3200 万元；交付延期主要出现在接口联调环节。",
};

describe("composeDocument pipeline", () => {
  it("runs plan -> sections -> edit -> quality in order and returns valid IR", async () => {
    const llm = new FakeLlm(defaultHandler);
    const result: ComposeResult = await composeDocument(BASE_INPUT, { llm });

    expect(result.stages.map((stage) => stage.stage)).toEqual([
      "plan",
      "sections",
      "sections",
      "edit",
      "quality",
    ]);
    expect(result.stages.every((stage) => stage.ok)).toBe(true);
    expect(llm.calls.map((call) => call.purpose)).toEqual([
      "office_content_plan",
      "office_content_section",
      "office_content_section",
      "office_content_edit",
    ]);
    expect(result.document.version).toBe(1);
    expect(result.document.template).toBe("work-report");
    expect(result.document.sections).toHaveLength(2);
    expect(() => validateDocumentIR(result.document)).not.toThrow();
    expect(result.quality.score).toBeGreaterThanOrEqual(70);

    // Prompt copy comes from prompts/office/*.md (strategy + genre rules).
    expect(llm.calls[0].system).toContain("写作策略");
    expect(llm.calls[0].system).toContain("工作报告");
    expect(llm.calls[0].user).toContain("第三季度工作报告");
    expect(llm.calls[3].user).toContain("本季度目标完成情况");
  });

  it("retries the plan stage on invalid JSON and feeds the error back", async () => {
    let planCalls = 0;
    const llm = new FakeLlm((input) => {
      if (input.purpose === "office_content_plan") {
        planCalls += 1;
        return planCalls === 1 ? "这不是 JSON" : PLAN_JSON;
      }
      return defaultHandler(input);
    });

    const result = await composeDocument(BASE_INPUT, { llm });
    const planStages = result.stages.filter((stage) => stage.stage === "plan");
    expect(planCalls).toBe(2);
    expect(planStages).toHaveLength(2);
    expect(planStages[0].ok).toBe(false);
    expect(planStages[0].detail).toContain("JSON");
    expect(planStages[1].ok).toBe(true);
    expect(llm.callsFor("office_content_plan")[1].user).toContain("模型输出里没有 JSON 对象");
  });

  it("retries the edit stage when the model returns invalid IR", async () => {
    let editCalls = 0;
    const llm = new FakeLlm((input) => {
      if (input.purpose === "office_content_edit") {
        editCalls += 1;
        return editCalls === 1 ? JSON.stringify({ title: "" }) : GOOD_DOCUMENT_JSON;
      }
      return defaultHandler(input);
    });

    const result = await composeDocument(BASE_INPUT, { llm });
    const editStages = result.stages.filter((stage) => stage.stage === "edit");
    expect(editCalls).toBe(2);
    expect(editStages).toHaveLength(2);
    expect(editStages[0].ok).toBe(false);
    expect(editStages[1].ok).toBe(true);
    expect(llm.callsFor("office_content_edit")[1].user).toContain("文档结构不合法");
  });

  it("throws ContentEngineError(invalid) when invalid output persists", async () => {
    const llm = new FakeLlm(() => "这不是 JSON");
    let caught: unknown;
    try {
      await composeDocument(BASE_INPUT, { llm, maxRepair: 1 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ContentEngineError);
    const error = caught as ContentEngineError;
    expect(error.code).toBe("invalid");
    expect(llm.callsFor("office_content_plan")).toHaveLength(2);
  });

  it("maps model failures to ContentEngineError(model) without leaking upstream text", async () => {
    const llm = new FakeLlm(() => new Error("upstream 500: secret provider stack"));
    let caught: unknown;
    try {
      await composeDocument(BASE_INPUT, { llm });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ContentEngineError);
    const error = caught as ContentEngineError;
    expect(error.code).toBe("model");
    expect(error.message).toContain("模型");
    expect(error.message).not.toContain("upstream 500");
    expect(error.message).not.toContain("secret provider stack");
  });

  it("triggers one targeted quality fix when the edit pass scores below 70", async () => {
    const llm = new FakeLlm((input) => {
      if (input.purpose === "office_content_edit") return BAD_DOCUMENT_JSON;
      if (input.purpose === "office_content_fix") return GOOD_DOCUMENT_JSON;
      return defaultHandler(input);
    });

    const result = await composeDocument(BASE_INPUT, { llm });
    const fixCalls = llm.callsFor("office_content_fix");
    expect(fixCalls).toHaveLength(1);
    expect(fixCalls[0].user).toContain("质量检查发现");
    expect(fixCalls[0].user).toContain("空心段落");
    expect(result.quality.score).toBeGreaterThanOrEqual(70);

    const qualityStages = result.stages.filter((stage) => stage.stage === "quality");
    expect(qualityStages[0].ok).toBe(false);
    expect(qualityStages.some((stage) => stage.ok && stage.attempt >= 2)).toBe(true);
    expect(result.document.title).toContain("工作报告");
  });

  it("keeps the low-scoring document when maxRepair is 0 (no fix turn)", async () => {
    const llm = new FakeLlm((input) => {
      if (input.purpose === "office_content_edit") return BAD_DOCUMENT_JSON;
      return defaultHandler(input);
    });

    const result = await composeDocument(BASE_INPUT, { llm, maxRepair: 0 });
    expect(llm.callsFor("office_content_fix")).toHaveLength(0);
    expect(result.quality.score).toBeLessThan(70);
    expect(result.stages.filter((stage) => stage.stage === "quality")).toHaveLength(1);
  });
});
class FakeFactCheck implements FactCheckPort {
  readonly enabled: boolean;
  readonly calls: Array<{ claims: string[]; context?: string }> = [];

  constructor(
    enabled: boolean,
    private readonly handler: (
      input: { claims: string[]; context?: string },
    ) => FactCheckVerdictItem[] | Error = () => [],
  ) {
    this.enabled = enabled;
  }

  async verify(input: { claims: string[]; context?: string }): Promise<{ checked: FactCheckVerdictItem[] }> {
    this.calls.push(input);
    const result = this.handler(input);
    if (result instanceof Error) throw result;
    return { checked: result };
  }
}

describe("composeDocument fact-check stage", () => {
  it("runs after the quality stage when the port is enabled and puts findings in the result", async () => {
    const port = new FakeFactCheck(true, (input) =>
      input.claims.map((claim) => {
        const unsupported = claim.includes("3200");
        return {
          claim,
          verdict: unsupported ? ("unsupported" as const) : ("supported" as const),
          ...(unsupported ? { note: "缺少财务出处", source: "季度报表" } : {}),
        };
      }),
    );
    const llm = new FakeLlm(defaultHandler);

    const result = await composeDocument({ ...BASE_INPUT, factCheck: port }, { llm });

    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]?.claims.some((claim) => claim.includes("3200"))).toBe(true);
    expect(port.calls[0]?.claims.some((claim) => claim.includes("12 个交付项目"))).toBe(true);
    expect(port.calls[0]?.context).toContain("2026 年第三季度工作报告");

    expect(result.document.sections).toHaveLength(2);
    expect(result.factCheck?.available).toBe(true);
    expect(result.factCheck?.checkedCount).toBeGreaterThan(0);
    expect(result.factCheck?.findings.some((item) => item.verdict === "unsupported")).toBe(true);
    expect(result.factCheck?.text).toContain("事实核对");

    const stageOrder = result.stages.map((stage) => stage.stage);
    expect(stageOrder[stageOrder.length - 1]).toBe("factCheck");
    const factStages = result.stages.filter((stage) => stage.stage === "factCheck");
    expect(factStages).toHaveLength(1);
    expect(factStages[0]?.ok).toBe(true);
    // Fact check adds no model calls to the authoring pipeline.
    expect(llm.calls.map((call) => call.purpose)).toEqual([
      "office_content_plan",
      "office_content_section",
      "office_content_section",
      "office_content_edit",
    ]);
  });

  it("does not run or record the stage when the port is disabled", async () => {
    const port = new FakeFactCheck(false);
    const llm = new FakeLlm(defaultHandler);

    const result = await composeDocument({ ...BASE_INPUT, factCheck: port }, { llm });

    expect(port.calls).toHaveLength(0);
    expect(result.factCheck).toBeUndefined();
    expect(result.stages.some((stage) => stage.stage === "factCheck")).toBe(false);
    expect(result.document.sections).toHaveLength(2);
  });

  it("degrades to available=false without blocking document generation when the port rejects", async () => {
    const port = new FakeFactCheck(true, () => new Error("verifier upstream 500"));
    const llm = new FakeLlm(defaultHandler);

    const result = await composeDocument({ ...BASE_INPUT, factCheck: port }, { llm });

    expect(port.calls).toHaveLength(1);
    expect(result.factCheck?.available).toBe(false);
    expect(result.factCheck?.checkedCount).toBe(0);
    expect(result.factCheck?.findings).toEqual([]);
    expect(result.factCheck?.text).toContain("调用失败");
    expect(result.document.sections).toHaveLength(2);
    expect(result.quality.score).toBeGreaterThanOrEqual(70);

    const factStages = result.stages.filter((stage) => stage.stage === "factCheck");
    expect(factStages).toHaveLength(1);
    expect(factStages[0]?.ok).toBe(false);
  });
});
