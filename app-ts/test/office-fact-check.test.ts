import { describe, expect, it } from "vitest";

import {
  FACT_CHECK_LIMITS,
  collectClaims,
  runFactCheck,
  type FactCheckPort,
  type FactCheckVerdict,
  type FactCheckVerdictItem,
} from "../src/services/office/fact-check.js";
import type { DocumentIR, IRBlock } from "../src/services/office/ir.js";

/**
 * Fact-check stage tests: claim extraction and the port-driven verification
 * stage are pure/offline (FakeFactCheckPort), so no gateway, renderer or
 * LibreOffice is involved.
 */

type VerifyInput = { claims: string[]; context?: string };

class FakeFactCheckPort implements FactCheckPort {
  readonly calls: VerifyInput[] = [];
  readonly enabled: boolean;

  constructor(
    enabled: boolean,
    private readonly handler: (input: VerifyInput) => FactCheckVerdictItem[] | Error = () => [],
  ) {
    this.enabled = enabled;
  }

  async verify(input: VerifyInput): Promise<{ checked: FactCheckVerdictItem[] }> {
    this.calls.push(input);
    const result = this.handler(input);
    if (result instanceof Error) throw result;
    return { checked: result };
  }
}

const TITLE = "2026 年第三季度工作报告";

function makeDoc(
  sections: Array<{ heading?: string; blocks: IRBlock[] }>,
  title = TITLE,
): DocumentIR {
  return {
    version: 1,
    title,
    sections: sections.map((section) => ({
      ...(section.heading !== undefined ? { heading: section.heading } : {}),
      blocks: section.blocks,
    })),
  };
}

function paragraph(text: string): IRBlock {
  return { type: "paragraph", text };
}

function verdictOf(claim: string): FactCheckVerdict {
  if (claim.includes("3200")) return "unsupported";
  return "supported";
}

describe("collectClaims", () => {
  it("extracts sentences with digits, percentages, multiples and 万/亿 magnitudes", () => {
    const doc = makeDoc([
      {
        heading: "本季度目标完成情况",
        blocks: [
          paragraph("本季度完成 12 个交付项目，营收 3200 万元。"),
          paragraph("同比增长 30%，活跃用户提升 2 倍。"),
          paragraph("覆盖 1.2 亿用户。"),
          paragraph("团队协作顺畅，客户满意度良好。"),
        ],
      },
    ]);

    expect(collectClaims(doc)).toEqual([
      "本季度完成 12 个交付项目，营收 3200 万元",
      "同比增长 30%，活跃用户提升 2 倍",
      "覆盖 1.2 亿用户",
    ]);
  });

  it("skips the title, section headings, headings and captions (years are not claims)", () => {
    const doc = makeDoc([
      {
        heading: "第 1 章 2026 年计划",
        blocks: [
          { type: "heading", level: 2, text: "2026 年目标" },
          { type: "caption", text: "表 1 采购动因分布" },
          paragraph("营收 3200 万元。"),
        ],
      },
    ]);

    expect(collectClaims(doc)).toEqual(["营收 3200 万元"]);
  });

  it("also checks table rows, list items, kv and metrics values", () => {
    const doc = makeDoc([
      {
        heading: "主要发现",
        blocks: [
          { type: "table", headers: ["动因", "提及率"], rows: [["降低人工成本", "61%"]] },
          { type: "unorderedList", items: ["小微企业预算 5 万元以内", "无需数据的条目"] },
          { type: "kv", items: [{ label: "样本量", value: "812 份有效问卷" }] },
          {
            type: "metrics",
            items: [{ label: "已采购工具", value: "58%", note: "较 2025 年 +9pp" }],
          },
        ],
      },
    ]);

    const claims = collectClaims(doc);
    expect(claims).toContain("降低人工成本，61%");
    expect(claims).toContain("小微企业预算 5 万元以内");
    expect(claims).toContain("样本量：812 份有效问卷");
    expect(claims).toContain("已采购工具：58%（较 2025 年 +9pp）");
    expect(claims).not.toContain("无需数据的条目");
  });

  it("deduplicates repeated sentences regardless of trailing punctuation", () => {
    const doc = makeDoc([
      {
        heading: "营收",
        blocks: [paragraph("营收 3200 万元。"), paragraph("营收 3200 万元"), paragraph("营收 3200 万元！")],
      },
    ]);

    expect(collectClaims(doc)).toEqual(["营收 3200 万元"]);
  });

  it("caps the claim list at 30 sentences", () => {
    const blocks: IRBlock[] = [];
    for (let index = 0; index < 40; index += 1) {
      blocks.push(paragraph("第 " + (index + 1) + " 项指标为 " + (index + 10) + " 万元。"));
    }
    const doc = makeDoc([{ heading: "指标清单", blocks }]);

    const claims = collectClaims(doc);
    expect(claims).toHaveLength(FACT_CHECK_LIMITS.maxClaims);
    expect(claims[0]).toBe("第 1 项指标为 10 万元");
    expect(claims[29]).toBe("第 30 项指标为 39 万元");
  });

  it("does not mutate the document", () => {
    const doc = makeDoc([
      { heading: "营收", blocks: [paragraph("营收 3200 万元。"), paragraph("增长 30%。")] },
    ]);
    const before = JSON.stringify(doc);
    collectClaims(doc);
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe("runFactCheck", () => {
  it("calls the port once with the claims + context and returns findings and a Chinese summary", async () => {
    const doc = makeDoc([
      {
        heading: "主要发现",
        blocks: [
          paragraph("本季度完成 12 个交付项目，营收 3200 万元。"),
          paragraph("同比增长 30%。"),
        ],
      },
    ]);
    const port = new FakeFactCheckPort(true, (input) =>
      input.claims.map((claim) => ({
        claim,
        verdict: verdictOf(claim),
        ...(verdictOf(claim) === "unsupported"
          ? { note: "未在提供的资料中找到出处", source: "内部财务表" }
          : {}),
      })),
    );

    const result = await runFactCheck(doc, port);

    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]?.claims).toEqual(collectClaims(doc));
    expect(port.calls[0]?.claims).toHaveLength(2);
    expect(port.calls[0]?.context).toContain(TITLE);
    expect(port.calls[0]?.context).toContain("主要发现");
    expect(result.available).toBe(true);
    expect(result.checkedCount).toBe(2);
    expect(result.findings).toHaveLength(2);
    expect(result.findings.map((item) => item.verdict)).toEqual(["unsupported", "supported"]);
    expect(result.text).toContain("事实核对");
    expect(result.text).toContain("无依据 1 条");
    expect(result.text).toContain("营收 3200 万元");
    expect(result.text).toContain("内部财务表");
  });

  it("does not call the port and says it is unavailable when disabled", async () => {
    const doc = makeDoc([{ heading: "营收", blocks: [paragraph("营收 3200 万元。")] }]);
    const port = new FakeFactCheckPort(false);

    const result = await runFactCheck(doc, port);

    expect(port.calls).toHaveLength(0);
    expect(result.available).toBe(false);
    expect(result.checkedCount).toBe(0);
    expect(result.findings).toEqual([]);
    expect(result.text).toContain("不可用");
    expect(result.text).toContain("未启用");
  });

  it("reports unavailable when no port is supplied at all", async () => {
    const doc = makeDoc([{ heading: "营收", blocks: [paragraph("营收 3200 万元。")] }]);

    const result = await runFactCheck(doc, undefined);

    expect(result.available).toBe(false);
    expect(result.checkedCount).toBe(0);
    expect(result.text).toContain("不可用");
  });

  it("degrades to available=false instead of throwing when the port rejects", async () => {
    const doc = makeDoc([{ heading: "营收", blocks: [paragraph("营收 3200 万元。")] }]);
    const port = new FakeFactCheckPort(true, () => new Error("verifier upstream 500"));

    const result = await runFactCheck(doc, port);

    expect(port.calls).toHaveLength(1);
    expect(result.available).toBe(false);
    expect(result.checkedCount).toBe(0);
    expect(result.findings).toEqual([]);
    expect(result.text).toContain("调用失败");
    expect(result.text).toContain("正文保持原样");
  });

  it("skips verification and reports success when the document has no numeric claims", async () => {
    const doc = makeDoc([{ heading: "概述", blocks: [paragraph("团队协作顺畅，客户满意度良好。")] }]);
    const port = new FakeFactCheckPort(true);

    const result = await runFactCheck(doc, port);

    expect(port.calls).toHaveLength(0);
    expect(result.available).toBe(true);
    expect(result.checkedCount).toBe(0);
    expect(result.findings).toEqual([]);
    expect(result.text).toContain("未发现");
  });

  it("marks claims as uncertain when the verifier returns no conclusions", async () => {
    const doc = makeDoc([{ heading: "营收", blocks: [paragraph("营收 3200 万元。")] }]);
    const port = new FakeFactCheckPort(true, () => []);

    const result = await runFactCheck(doc, port);

    expect(result.available).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.verdict).toBe("uncertain");
    expect(result.text).toContain("待确认 1 条");
  });

  it("honors the maxClaims option and passes an explicit context override", async () => {
    const doc = makeDoc([
      {
        heading: "指标",
        blocks: [paragraph("营收 3200 万元。"), paragraph("增长 30%。"), paragraph("覆盖 1.2 亿用户。")],
      },
    ]);
    const port = new FakeFactCheckPort(true, (input) =>
      input.claims.map((claim) => ({ claim, verdict: "supported" as const })),
    );

    const result = await runFactCheck(doc, port, { maxClaims: 1, context: "自定义核对上下文" });

    expect(port.calls[0]?.claims).toHaveLength(1);
    expect(port.calls[0]?.context).toBe("自定义核对上下文");
    expect(result.checkedCount).toBe(1);
    expect(result.text).toContain("所有数据性断言均有依据");
  });

  it("does not edit the document while verifying", async () => {
    const doc = makeDoc([{ heading: "营收", blocks: [paragraph("营收 3200 万元。")] }]);
    const before = JSON.stringify(doc);
    const port = new FakeFactCheckPort(true, (input) =>
      input.claims.map((claim) => ({ claim, verdict: "unsupported" as const, note: "需补出处" })),
    );

    await runFactCheck(doc, port);

    expect(JSON.stringify(doc)).toBe(before);
  });
});
