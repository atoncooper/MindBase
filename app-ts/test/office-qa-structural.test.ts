import { describe, expect, it } from "vitest";

import { validateDocumentIR, type DocumentIR } from "../src/services/office/ir.js";
import { auditDocumentStructure, renderStructuralAudit } from "../src/services/office/qa-structural.js";
import { getDocTemplate } from "../src/services/office/templates.js";

function doc(overrides: Record<string, unknown> = {}): DocumentIR {
  return validateDocumentIR({
    version: 1,
    title: "季度经营分析报告",
    cover: true,
    sections: [
      { heading: "经营概况", blocks: [{ type: "paragraph", text: "本季度营业收入 1,200 万元，同比增长 18%。" }] },
      { heading: "下一步计划", blocks: [{ type: "orderedList", items: ["上线智能问答 2.0"] }] },
    ],
    ...overrides,
  });
}

describe("render-free structural audit", () => {
  it("counts section headings as H1 and passes a reasonable document", () => {
    const audit = auditDocumentStructure(doc(), getDocTemplate("work-report"));
    expect(audit.findings.filter((finding) => finding.code === "no_h1")).toHaveLength(0);
    expect(audit.score).toBeGreaterThanOrEqual(90);
    expect(audit.estimatedPages).toBeGreaterThanOrEqual(1);
    expect(renderStructuralAudit(audit)).toContain("结构自检");
  });

  it("flags hierarchy jumps, missing table captions and over-wide images", () => {
    const audit = auditDocumentStructure(
      doc({
        sections: [
          {
            heading: "一、现状",
            blocks: [
              { type: "heading", level: 3, text: "数据概览" },
              { type: "table", headers: ["a", "b"], rows: [["1", "2"]] },
              { type: "image", uploadUuid: "u-1", widthCm: 17 },
            ],
          },
        ],
      }),
      getDocTemplate("research-report"),
    );
    const codes = audit.findings.map((finding) => finding.code);
    expect(codes).toContain("heading_level_jump");
    expect(codes).toContain("table_no_caption");
    expect(codes).toContain("image_too_wide");
    expect(audit.score).toBeLessThan(100);
  });

  it("flags genre expectations (meeting minutes without action items)", () => {
    const audit = auditDocumentStructure(
      doc({
        sections: [
          { heading: "会议背景", blocks: [{ type: "paragraph", text: "本次会议讨论第三季度交付情况。" }] },
          { heading: "讨论记录", blocks: [{ type: "paragraph", text: "与会人员就交付延期原因进行了讨论。" }] },
        ],
      }),
      getDocTemplate("meeting-minutes"),
    );
    expect(audit.findings.some((finding) => finding.code === "minutes_no_actions")).toBe(true);
  });
});
