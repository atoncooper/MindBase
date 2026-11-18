import type { AcademicDocumentKind, AcademicSectionInput } from "../../repository/academic.js";
import { defaultManuscriptSections } from "../../repository/academic.js";

/** 按文档类型返回默认章节大纲。 */
export function defaultSectionsForKind(kind: AcademicDocumentKind): AcademicSectionInput[] {
  switch (kind) {
    case "proposal":
      return sections([
        ["abstract", "摘要"],
        ["background", "研究背景"],
        ["question", "研究问题与目标"],
        ["methodology", "研究方法"],
        ["feasibility", "可行性分析"],
        ["schedule", "进度安排"],
        ["references", "参考文献"],
      ]);
    case "plan":
      return sections([
        ["objectives", "研究目标"],
        ["content", "研究内容"],
        ["method", "技术路线"],
        ["schedule", "时间安排"],
        ["outcomes", "预期成果"],
        ["risks", "风险与应对"],
      ]);
    case "response_letter":
      return sections([
        ["comments", "审稿意见汇总"],
        ["responses", "逐条回复"],
        ["changes", "修改清单"],
      ]);
    case "cover_letter":
      return sections([
        ["journal", "目标期刊与稿件信息"],
        ["summary", "稿件要点"],
        ["contribution", "贡献与契合度"],
        ["declarations", "声明（原创性/利益冲突/数据可用性）"],
      ]);
    case "stage_report":
      return sections([
        ["overview", "阶段进展概述"],
        ["completed", "已完成工作"],
        ["results", "阶段性结果"],
        ["issues", "问题与原因"],
        ["next", "下一步计划"],
      ]);
    case "midterm_report":
      return sections([
        ["progress", "中期进展"],
        ["achievements", "阶段性成果"],
        ["issues", "问题与风险"],
        ["next", "后续研究计划"],
      ]);
    case "final_report":
      return sections([
        ["abstract", "摘要"],
        ["content", "研究内容与方法"],
        ["results", "主要结果"],
        ["contributions", "创新点与贡献"],
        ["outputs", "成果清单"],
        ["limitations", "不足与展望"],
      ]);
    case "draft":
    case "revision":
    case "custom":
    default:
      return defaultManuscriptSections();
  }
}

function sections(rows: Array<[string, string]>): AcademicSectionInput[] {
  return rows.map(([key, title], order) => ({ key, title, order }));
}
