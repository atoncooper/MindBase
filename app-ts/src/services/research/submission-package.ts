import JSZip from "jszip";
import { AcademicError, type AcademicService } from "./academic.js";
import type { ManuscriptDocxService } from "./manuscript-docx.js";
import type { ResearchApprovalService } from "./research-approval.js";
import { describeValidationFailures, type ResearchValidationService } from "./research-validation.js";

export interface SubmissionPackageDeps {
  academic: Pick<AcademicService, "getDocument" | "exportDocument" | "exportBibtex">;
  docx: Pick<ManuscriptDocxService, "exportDocxBuffer">;
  validation?: Pick<ResearchValidationService, "validate">;
  approvals?: Pick<ResearchApprovalService, "consume">;
}

export interface SubmissionPackageResult {
  fileName: string;
  bytes: Buffer;
  approvalId?: string;
}

/** 投稿包：一次性生成 Word、Markdown、LaTeX、BibTeX 与提交检查清单。 */
export class SubmissionPackageService {
  constructor(private readonly deps: SubmissionPackageDeps) {}

  async build(uid: string, documentId: string): Promise<SubmissionPackageResult> {
    const { document } = await this.deps.academic.getDocument(uid, documentId);
    const projectId = document.projectId;

    let validationNote = "未运行校验";
    if (this.deps.validation) {
      const report = await this.deps.validation.validate(uid, projectId, documentId);
      if (!report.pass) {
        throw new AcademicError(
          409,
          "提交包生成被拒绝：学术校验未通过。\n" + describeValidationFailures(report),
        );
      }
      validationNote =
        "校验通过（引用 " +
        report.citations.total +
        " 条，结果章节 " +
        report.results.sections.length +
        " 个）";
    }

    const docx = await this.deps.docx.exportDocxBuffer(uid, documentId, { force: false });
    const markdown = await this.deps.academic.exportDocument(uid, documentId, "markdown", { force: false });
    const latex = await this.deps.academic.exportDocument(uid, documentId, "latex", { force: false });
    const bibtex = await this.deps.academic.exportBibtex(uid, projectId);

    let approvalId: string | undefined;
    if (this.deps.approvals) {
      const approval = await this.deps.approvals.consume(uid, projectId, "submission");
      approvalId = approval.id;
    }

    const zip = new JSZip();
    zip.file("manuscript.docx", docx.buffer);
    zip.file("manuscript.md", markdown.text);
    zip.file("manuscript.tex", latex.text);
    zip.file("references.bib", bibtex.bibtex);
    zip.file(
      "README.txt",
      [
        "MindBase 投稿包",
        "文档：" + document.title,
        "生成时间：" + new Date().toISOString(),
        "校验：" + validationNote,
        ...(approvalId ? ["提交审批：" + approvalId] : []),
        "",
        "内容：",
        "- manuscript.docx：Word 稿件（含按项目引用风格生成的参考文献）",
        "- manuscript.md / manuscript.tex：Markdown / LaTeX 文本",
        "- references.bib：BibTeX 文献库",
        "",
        "投稿前请人工核对：作者与署名、利益冲突声明、伦理审批、数据可用性、期刊投稿要求。",
      ].join("\n"),
    );

    const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    return {
      fileName: (document.title.trim() || "manuscript") + "_submission.zip",
      bytes,
      ...(approvalId ? { approvalId } : {}),
    };
  }
}
