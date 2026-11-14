import type { AcademicDocumentRepository, AcademicProjectRepository } from "../repository/academic.js";
import type { AcademicEvidenceRepository, AcademicRun } from "../repository/academic-evidence.js";
import type { ResearchWorkspaceService } from "./research-workspace.js";

function statusCell(run: AcademicRun): string {
  return run.status;
}

/**
 * Deterministic result-table generator over the evidence ledger. Every row
 * carries a [[run:<id>]] marker so academic_validation can prove the manuscript
 * numbers came from real executions.
 */
export class ResearchAnalysisService {
  constructor(
    private readonly projects: AcademicProjectRepository,
    private readonly evidence: AcademicEvidenceRepository,
    private readonly documents: AcademicDocumentRepository,
    private readonly workspace: ResearchWorkspaceService,
  ) {}

  async generateResultsTable(uid: string, projectId: string, documentId?: string): Promise<{
    markdown: string;
    uploadUuid?: string;
    folderId?: number;
  }> {
    const project = await this.projects.get(uid, projectId);
    if (!project) throw new Error("项目不存在或无权访问");
    const runs = await this.evidence.listRuns(uid, projectId, { limit: 100 });
    if (runs.length === 0) throw new Error("项目还没有实验记录，无法生成结果表");

    const lines = [
      "| 实验 | 状态 | exit | 语言 | 耗时 | 证据 |",
      "|---|---|---|---|---|---|",
      ...runs.map((run) => {
        const duration = run.finishedAt && run.startedAt ? ((run.finishedAt - run.startedAt) / 1000).toFixed(1) + "s" : "-";
        return (
          "| " +
          (run.name || run.id).replace(/\|/g, "\\|") +
          " | " +
          statusCell(run) +
          " | " +
          String(run.exitCode ?? "-") +
          " | " +
          run.language +
          " | " +
          duration +
          " | [[run:" +
          run.id +
          "]] |"
        );
      }),
    ];
    const markdown = "## 结果\n\n" + lines.join("\n") + "\n";
    let upload: { upload_uuid: string; folderId: number } | undefined;
    try {
      upload = await this.workspace.uploadFile(
        uid,
        projectId,
        "results",
        "results_summary.md",
        new TextEncoder().encode(markdown),
        "text/markdown; charset=utf-8",
      );
    } catch {
      // Cloud storage is best-effort; the table is still returned for the model.
    }
    if (documentId) {
      await this.documents.upsertSection(uid, documentId, {
        key: "results",
        title: "结果",
        content: markdown,
      });
    }
    return {
      markdown,
      ...(upload ? { uploadUuid: upload.upload_uuid, folderId: upload.folderId } : {}),
    };
  }
}
