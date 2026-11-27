import { describe, expect, it } from "vitest";

import type { DocumentIR, IRBlock, IRSection } from "../src/services/office/ir.js";
import {
  QUALITY_CODES,
  QUALITY_PASS_SCORE,
  QUALITY_THRESHOLDS,
  checkDocumentQuality,
  countConnectors,
  normalizeForComparison,
  splitSentences,
} from "../src/services/office/content-quality.js";

/**
 * Content quality rules: every rule is exercised with a hand-built DocumentIR
 * (no renderer, no LLM, no fixtures), plus the genre checks warning paths and
 * the exported text helpers.
 */

function paragraph(text: string): IRBlock {
  return { type: "paragraph", text, style: "body" };
}

function headingBlock(text: string, level: 1 | 2 | 3 = 2): IRBlock {
  return { type: "heading", level, text };
}

function section(heading: string, blocks: IRBlock[]): IRSection {
  return { heading, blocks };
}

function doc(sections: IRSection[], extra: Partial<DocumentIR> = {}): DocumentIR {
  return { version: 1, title: "测试文档", sections, ...extra };
}

function codesOf(report: ReturnType<typeof checkDocumentQuality>): string[] {
  return report.findings.map((finding) => finding.code);
}

describe("text helpers", () => {
  it("normalizeForComparison strips whitespace and punctuation, lowercases", () => {
    expect(normalizeForComparison("你好， 世界！ABC")).toBe("你好世界abc");
    expect(normalizeForComparison("  “数据” 驱动\n决策。 ")).toBe("数据驱动决策");
  });

  it("splitSentences splits Chinese and English punctuation", () => {
    expect(splitSentences("第一句。第二句！第三句？")).toHaveLength(3);
    expect(splitSentences("没有标点的一句话")).toEqual(["没有标点的一句话"]);
  });

  it("countConnectors counts AI-tone connectors", () => {
    expect(countConnectors("首先……其次……最后")).toBe(3);
    expect(countConnectors("综上所述，希望本文能帮助你。")).toBe(2);
    expect(countConnectors("本季度完成三个项目。")).toBe(0);
  });
});

describe("clean content", () => {
  it("scores a concrete document 100 with no findings and correct stats", () => {
    const report = checkDocumentQuality(
      doc([
        section("本季度营收", [paragraph("本季度营收 3200 万元，同比增长 18%，数据来自财务部季度报表。")]),
        section("下季度计划", [paragraph("下季度把华东区渠道从 12 个扩展到 18 个，由张三在 12 月底前完成。")]),
      ]),
      { templateId: "work-report" },
    );
    expect(report.findings).toEqual([]);
    expect(report.score).toBe(100);
    expect(report.score).toBeGreaterThanOrEqual(QUALITY_PASS_SCORE);
    expect(report.stats.paragraphs).toBe(2);
    expect(report.stats.chars).toBeGreaterThan(40);
    expect(report.stats.connectorsPer1000).toBe(0);
    expect(report.stats.duplicateSentences).toBe(0);
  });

  it("counts headings, tables and lists in stats", () => {
    const report = checkDocumentQuality(
      doc([
        section("第一章", [
          headingBlock("小节标题"),
          paragraph("本季度完成三个交付项目，客户满意度提升，团队补充两名工程师。"),
          { type: "unorderedList", items: ["渠道扩容", "流程优化"] },
          { type: "table", headers: ["指标", "数值"], rows: [["交付项目", "3"], ["工程师", "2"]] },
        ]),
      ]),
    );
    expect(report.stats.paragraphs).toBe(1);
    expect(report.stats.headings).toBe(2);
    expect(report.stats.tables).toBe(1);
    expect(report.stats.lists).toBe(1);
  });
});

describe("AI-tone connector rules", () => {
  it("flags connector overuse as error and reports per-1000 density", () => {
    const text =
      "首先，需要明确季度目标与交付边界，避免目标在执行中反复变化；" +
      "其次，团队要按模块分工协作并互相备份，减少单点依赖；" +
      "再次，执行过程要持续跟踪风险、进度与资源占用情况；" +
      "最后，必须及时复盘，把经验沉淀为可复用的流程与清单；" +
      "此外，还要关注预算与资源投入的匹配度，避免中途追加；" +
      "同时，保持跨部门沟通顺畅，关键决策要有书面记录；" +
      "因此，建立每周例会与月度评审机制，让问题尽早暴露；" +
      "总之，这套方法可以提升整体效率，但需要负责人持续推动；" +
      "综上所述，执行方法本身不是目的，稳定交付才是目的。";
    const report = checkDocumentQuality(doc([section("执行方法", [paragraph(text)])]));
    const overuse = report.findings.find((finding) => finding.code === QUALITY_CODES.connectorOveruse);
    expect(overuse).toBeDefined();
    expect(overuse?.severity).toBe("error");
    expect(report.stats.connectorsPer1000).toBeGreaterThan(QUALITY_THRESHOLDS.connectorPer1000Warning);
  });

  it("flags per-paragraph connector clustering", () => {
    const report = checkDocumentQuality(
      doc([section("方法", [paragraph("首先整理数据，其次核对口径，最后输出结论。")])]),
    );
    const cluster = report.findings.find((finding) => finding.code === QUALITY_CODES.connectorCluster);
    expect(cluster).toBeDefined();
    expect(cluster?.sectionIndex).toBe(0);
    expect(cluster?.blockIndex).toBe(0);
  });

  it("does not flag a normal amount of connectors", () => {
    const report = checkDocumentQuality(
      doc([
        section("进展", [
          paragraph(
            "本季度完成三个交付项目，团队补充两名工程师，客户满意度从 82 分提升到 89 分，数据来自季度满意度调查。",
          ),
          paragraph("同时，我们把周会从四次压缩到两次，减少沟通成本。"),
        ]),
      ]),
    );
    expect(codesOf(report)).not.toContain(QUALITY_CODES.connectorOveruse);
    expect(codesOf(report)).not.toContain(QUALITY_CODES.connectorCluster);
  });
});

describe("repetition rules", () => {
  it("flags duplicate sentences across the document", () => {
    const report = checkDocumentQuality(
      doc([
        section("现状", [paragraph("渠道结构持续优化，市场投入回报率显著提升。")]),
        section("问题", [
          paragraph("渠道结构持续优化，市场投入回报率显著提升。"),
          paragraph("研发团队完成两次版本迭代，线上稳定性问题下降。"),
        ]),
      ]),
    );
    expect(report.stats.duplicateSentences).toBe(1);
    expect(codesOf(report)).toContain(QUALITY_CODES.duplicateSentence);
  });

  it("flags high-frequency 4-gram repetition", () => {
    const report = checkDocumentQuality(
      doc([
        section("方法", [
          paragraph("我们坚持数据驱动决策的原则推进渠道管理。"),
          paragraph("研发排期也遵循数据驱动决策的流程减少返工。"),
          paragraph("市场投放依据数据驱动决策的模型分配预算。"),
          paragraph("客服改进通过数据驱动决策的闭环验证效果。"),
        ]),
      ]),
    );
    expect(codesOf(report)).toContain(QUALITY_CODES.ngramRepetition);
    const finding = report.findings.find((item) => item.code === QUALITY_CODES.ngramRepetition);
    expect(finding?.severity).toBe("warning");
  });
});

describe("hollow paragraph rule", () => {
  it("flags filler templates and too-short paragraphs without substance", () => {
    const report = checkDocumentQuality(
      doc([
        section("概述", [
          paragraph("本节介绍了系统的整体设计思路，具有重要意义。"),
          paragraph("增长显著。"),
          paragraph("本季度华东区新增 18 个渠道，覆盖 6 个城市，数据来自渠道部周报。"),
        ]),
      ]),
    );
    const hollow = report.findings.filter((finding) => finding.code === QUALITY_CODES.hollowParagraph);
    expect(hollow.length).toBeGreaterThanOrEqual(2);
    expect(hollow.some((finding) => finding.blockIndex === 0)).toBe(true);
  });

  it("does not flag concrete short paragraphs that carry data", () => {
    const report = checkDocumentQuality(
      doc([section("数据", [paragraph("预算 120 万元。")])]),
      { templateId: "work-report" },
    );
    expect(codesOf(report)).not.toContain(QUALITY_CODES.hollowParagraph);
  });
});

describe("mechanical structure rule", () => {
  it("flags cloned chapters with identical block sequences and similar length", () => {
    const report = checkDocumentQuality(
      doc([
        section("第一部分", [
          paragraph("第一部分围绕渠道建设展开，包含三项具体行动与对应负责人，按季度推进落地。"),
        ]),
        section("第二部分", [
          paragraph("第二部分围绕产品打磨展开，包含三项具体动作与对应负责人，按双周推进落地。"),
        ]),
        section("第三部分", [
          paragraph("第三部分围绕服务提效展开，包含三项具体措施与对应负责人，按月度推进落地。"),
        ]),
      ]),
    );
    expect(codesOf(report)).toContain(QUALITY_CODES.mechanicalStructure);
  });

  it("does not flag chapters whose lengths differ a lot", () => {
    const longText =
      "本部分详细说明渠道建设的背景、目标、约束条件与推进方式，先梳理现有渠道的覆盖范围与转化效率，" +
      "再按区域拆解增量来源，随后明确每一步的负责人、时间点与验收标准，最后补充风险预案与复盘机制，" +
      "确保计划可以按季度滚动调整而不是停留在口号层面。";
    const report = checkDocumentQuality(
      doc([
        section("背景", [paragraph("背景部分说明项目由来。")]),
        section("详述", [paragraph(longText)]),
        section("结论", [paragraph("结论部分给出三条建议。")]),
      ]),
    );
    expect(codesOf(report)).not.toContain(QUALITY_CODES.mechanicalStructure);
  });
});

describe("unsourced data rule", () => {
  it("reports info when numbers lack provenance markers", () => {
    const report = checkDocumentQuality(
      doc([section("增长情况", [paragraph("本季度用户增长 35%，复购率提升 2 倍。")])]),
    );
    const finding = report.findings.find((item) => item.code === QUALITY_CODES.unsupportedData);
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("info");
  });

  it("does not report when the paragraph carries an evidence marker", () => {
    const report = checkDocumentQuality(
      doc([
        section("增长情况", [
          paragraph("本季度用户增长 35%，复购率提升 2 倍，数据来源于运营部季度统计报告。"),
        ]),
      ]),
    );
    expect(codesOf(report)).not.toContain(QUALITY_CODES.unsupportedData);
  });
});

describe("document type rules", () => {
  it("warns when meeting minutes miss place/decision/owner", () => {
    const report = checkDocumentQuality(
      doc(
        [
          section("会议信息", [
            paragraph("时间：2026 年 11 月 3 日 14:00；参会人员：产品、研发、测试代表各一名。"),
          ]),
        ],
        { title: "产品评审会纪要" },
      ),
      { templateId: "meeting-minutes" },
    );
    const finding = report.findings.find((item) => item.code === QUALITY_CODES.docTypeMissing);
    expect(finding).toBeDefined();
    expect(finding?.message).toContain("地点");
  });

  it("accepts complete meeting minutes", () => {
    const report = checkDocumentQuality(
      doc(
        [
          section("会议信息", [
            paragraph(
              "时间：2026 年 11 月 3 日 14:00；地点：3 号会议室；参会人员：产品、研发、测试代表；" +
                "结论：通过 V2 排期方案；待办：张三在 11 月 10 日前完成接口联调。",
            ),
          ]),
        ],
        { title: "产品评审会纪要" },
      ),
      { templateId: "meeting-minutes" },
    );
    expect(codesOf(report)).not.toContain(QUALITY_CODES.docTypeMissing);
  });

  it("warns when a notice misses the time element", () => {
    const report = checkDocumentQuality(
      doc(
        [section("通知内容", [paragraph("系统将于本周升级，升级期间部分功能不可用，请提前保存数据。")])],
        { title: "关于系统升级的通知" },
      ),
      { templateId: "notice" },
    );
    const finding = report.findings.find((item) => item.code === QUALITY_CODES.docTypeMissing);
    expect(finding).toBeDefined();
    expect(finding?.message).toContain("时间");
  });

  it("accepts a complete notice", () => {
    const report = checkDocumentQuality(
      doc(
        [
          section("通知内容", [
            paragraph(
              "现将系统升级事项通知如下：升级时间为 2026 年 12 月 5 日 22:00 至次日 2:00，" +
                "请各部门提前保存数据，升级期间不得提交新任务。",
            ),
          ]),
        ],
        { title: "关于系统升级的通知" },
      ),
      { templateId: "notice" },
    );
    expect(codesOf(report)).not.toContain(QUALITY_CODES.docTypeMissing);
  });

  it("warns when academic headings miss the conclusion chapter", () => {
    const report = checkDocumentQuality(
      doc([
        section("引言", [paragraph("本研究围绕渠道效率问题展开，说明研究缺口与目标。")]),
        section("研究方法", [paragraph("研究采用访谈与问卷结合的方式，明确样本口径与处理流程。")]),
        section("结果分析", [paragraph("结果显示区域差异明显，渠道结构影响转化效率。")]),
      ]),
      { templateId: "academic" },
    );
    const finding = report.findings.find((item) => item.code === QUALITY_CODES.docTypeMissing);
    expect(finding).toBeDefined();
    expect(finding?.message).toContain("结论");
  });

  it("accepts academic documents with method/result/conclusion headings", () => {
    const report = checkDocumentQuality(
      doc([
        section("引言", [paragraph("本研究围绕渠道效率问题展开，说明研究缺口与目标。")]),
        section("研究方法", [paragraph("研究采用访谈与问卷结合的方式，明确样本口径与处理流程。")]),
        section("结果分析", [paragraph("结果显示区域差异明显，渠道结构影响转化效率。")]),
        section("结论与展望", [paragraph("结论部分给出三条管理建议并说明后续研究方向。")]),
      ]),
      { templateId: "academic" },
    );
    expect(codesOf(report)).not.toContain(QUALITY_CODES.docTypeMissing);
  });

  it("warns when tech design misses interface/deployment content", () => {
    const report = checkDocumentQuality(
      doc([section("总体说明", [paragraph("本方案说明系统的整体设计，涵盖主要模块与数据流。")])]),
      { templateId: "tech-design" },
    );
    const finding = report.findings.find((item) => item.code === QUALITY_CODES.docTypeMissing);
    expect(finding).toBeDefined();
    expect(finding?.message).toContain("接口");
  });

  it("accepts tech design covering architecture/interface/deployment", () => {
    const report = checkDocumentQuality(
      doc([
        section("总体说明", [
          paragraph("本方案说明系统的整体架构，涵盖主要模块与数据流。"),
          paragraph("对外接口采用 REST 风格，部署在容器平台，按环境变量切换配置。"),
        ]),
      ]),
      { templateId: "tech-design" },
    );
    expect(codesOf(report)).not.toContain(QUALITY_CODES.docTypeMissing);
  });

  it("warns when business plan misses goals/implementation/risk/budget", () => {
    const report = checkDocumentQuality(
      doc([
        section("项目介绍", [
          paragraph("本项目为中小企业提供自动化报表服务，团队具备相关行业经验。"),
        ]),
      ]),
      { templateId: "business-plan" },
    );
    const finding = report.findings.find((item) => item.code === QUALITY_CODES.docTypeMissing);
    expect(finding).toBeDefined();
    expect(finding?.message).toContain("预算");
  });

  it("accepts business plans with goals/implementation/risk/budget", () => {
    const report = checkDocumentQuality(
      doc([
        section("项目介绍", [
          paragraph(
            "项目目标是为中小企业提供自动化报表服务，实施路径分三个阶段推进，" +
              "主要风险是客户数据接入合规，预算需财务按人力成本测算。",
          ),
        ]),
      ]),
      { templateId: "business-plan" },
    );
    expect(codesOf(report)).not.toContain(QUALITY_CODES.docTypeMissing);
  });

  it("warns when a resume has a cover and over-long paragraphs", () => {
    const longParagraph =
      "负责企业数据平台建设，主导从需求调研到上线运维的完整流程，协调产品、研发与运营三方资源，" +
      "推动报表自动化覆盖率提升，沉淀数据口径与权限规范，牵头完成三次跨部门专项优化，" +
      "并建立月度复盘机制，持续降低人工取数成本，支撑管理层经营决策。" +
      "在团队建设方面，承担新人培养与代码评审职责，制定数据开发规范与交付清单，" +
      "组织季度技术分享，推动跨团队知识沉淀，形成可复用的数据资产目录。";
    const report = checkDocumentQuality(
      doc([section("工作经历", [paragraph(longParagraph)])], { title: "张三的简历", cover: true }),
      { templateId: "resume" },
    );
    const mismatch = report.findings.filter((finding) => finding.code === QUALITY_CODES.docTypeMismatch);
    expect(mismatch.length).toBeGreaterThanOrEqual(2);
  });

  it("does not apply genre rules for unknown template ids", () => {
    const report = checkDocumentQuality(
      doc([section("概述", [paragraph("本节介绍了相关工作，具有重要意义。")])]),
      { templateId: "unknown-template" },
    );
    expect(codesOf(report)).toContain(QUALITY_CODES.hollowParagraph);
    expect(codesOf(report)).not.toContain(QUALITY_CODES.docTypeMissing);
    expect(codesOf(report)).not.toContain(QUALITY_CODES.docTypeMismatch);
  });
});

describe("score", () => {
  it("drops below the pass line for a heavily AI-flavored document", () => {
    const filler =
      "首先，众所周知，本节介绍了相关工作，具有重要意义，综上所述，希望对你有帮助。";
    const report = checkDocumentQuality(
      doc([
        section("第一部分", [paragraph(filler)]),
        section("第二部分", [paragraph(filler)]),
        section("第三部分", [paragraph(filler)]),
      ]),
    );
    expect(report.score).toBeLessThan(QUALITY_PASS_SCORE);
    expect(report.score).toBeGreaterThanOrEqual(0);
  });
});
