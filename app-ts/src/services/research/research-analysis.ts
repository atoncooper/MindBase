import type { AcademicDocumentRepository, AcademicProjectRepository } from "../../repository/academic.js";
import type {
  AcademicEvidenceRepository,
  AcademicRun,
  AcademicRunMetric,
} from "../../repository/academic-evidence.js";
import type { ResearchWorkspaceService } from "./research-workspace.js";

/** Newest runs considered when compareRuns gets no explicit runIds. */
const RUN_LIMIT = 100;
/** Longest label kept from a run name (chart categories stay readable). */
const MAX_LABEL_CHARS = 40;
/** Cell value for a run without metrics. */
const NO_METRICS = "—";

function statusCell(run: AcademicRun): string {
  return run.status;
}

/** Markdown table cells must not break the pipe-delimited table. */
function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

/** Display value: raw number plus its display-only unit ("%" / "ms" / ...). */
function metricDisplay(metric: AcademicRunMetric): string {
  return String(metric.value) + (metric.unit ?? "");
}

function metricsCell(run: AcademicRun): string {
  if (!run.metrics || run.metrics.length === 0) return NO_METRICS;
  return run.metrics.map((metric) => escapeCell(metric.name) + "=" + metricDisplay(metric)).join(", ");
}

/** Short label for tables/charts: run name, or a short id when unnamed. */
function runLabel(run: AcademicRun): string {
  const name = (run.name ?? "").trim();
  const label = name || run.id.slice(0, 8);
  return label.length > MAX_LABEL_CHARS ? label.slice(0, MAX_LABEL_CHARS) + "…" : label;
}

/** Duplicate names get a numeric suffix so chart categories stay unique keys. */
function uniqueRunLabels(runs: AcademicRun[]): string[] {
  const seen = new Map<string, number>();
  return runs.map((run) => {
    const label = runLabel(run);
    const count = (seen.get(label) ?? 0) + 1;
    seen.set(label, count);
    return count === 1 ? label : label + " #" + count;
  });
}

function metricOf(run: AcademicRun, name: string): AcademicRunMetric | undefined {
  return (run.metrics ?? []).find((metric) => metric.name === name);
}

/** Metric names present in every run, ordered by the first run's output. */
function sharedMetricNames(runs: AcademicRun[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const metric of runs[0]?.metrics ?? []) {
    if (seen.has(metric.name)) continue;
    seen.add(metric.name);
    if (runs.every((run) => metricOf(run, metric.name) !== undefined)) names.push(metric.name);
  }
  return names;
}

/** Chart payload: one category per run, one numeric series per shared metric. */
export interface RunComparisonChart {
  categories: string[];
  series: Array<{ name: string; values: number[] }>;
}

/** Comparison result: markdown table + chart data + summary counts. */
export interface RunComparisonResult {
  markdown: string;
  chart: RunComparisonChart;
  /** number of metric-bearing runs compared */
  runs: number;
  /** metric names shared by every compared run */
  metrics: string[];
  uploadUuid?: string;
  folderId?: number;
}

/**
 * Deterministic result-table / multi-run comparison generator over the evidence
 * ledger. Result-table rows carry a [[run:<id>]] marker so academic_validation
 * can prove the manuscript numbers came from real executions.
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
    const runs = await this.evidence.listRuns(uid, projectId, { limit: RUN_LIMIT });
    if (runs.length === 0) throw new Error("项目还没有实验记录，无法生成结果表");

    const lines = [
      "| 实验 | 状态 | exit | 语言 | 耗时 | 指标 | 证据 |",
      "|---|---|---|---|---|---|---|",
      ...runs.map((run) => {
        const duration = run.finishedAt && run.startedAt ? ((run.finishedAt - run.startedAt) / 1000).toFixed(1) + "s" : "-";
        return (
          "| " +
          escapeCell(run.name || run.id) +
          " | " +
          statusCell(run) +
          " | " +
          String(run.exitCode ?? "-") +
          " | " +
          escapeCell(run.language) +
          " | " +
          duration +
          " | " +
          metricsCell(run) +
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

  /**
   * Compare recorded metrics across runs. Runs without metrics are ignored and
   * only metrics present on every compared run are charted (a series with holes
   * would misrepresent the comparison), so a comparison without any shared metric
   * returns guidance instead of a misleading chart. Explicit runIds must resolve
   * inside the project; otherwise the newest RUN_LIMIT runs are used.
   */
  async compareRuns(uid: string, projectId: string, runIds?: string[]): Promise<RunComparisonResult> {
    const project = await this.projects.get(uid, projectId);
    if (!project) throw new Error("项目不存在或无权访问");
    const selected = await this.selectRuns(uid, projectId, runIds);
    if (selected.length === 0) throw new Error("项目还没有实验记录，无法生成多 run 对比");
    const runs = selected.filter((run) => (run.metrics?.length ?? 0) > 0);
    if (runs.length === 0) {
      throw new Error(
        "项目还没有可对比的指标：请让实验在标准输出打印 `METRIC 名称=数值` 行（如 `METRIC acc=0.91`，也支持 JSON 行），记录后再执行 compare。",
      );
    }
    const metrics = sharedMetricNames(runs);
    if (metrics.length === 0) {
      throw new Error(
        "选中的运行还没有共同的指标，无法对比：请选择指标名一致的运行，或让实验输出相同名称的 METRIC 行后重试。",
      );
    }

    const labels = uniqueRunLabels(runs);
    const header = "| 实验 | " + metrics.map(escapeCell).join(" | ") + " |";
    const separator = "|---|" + metrics.map(() => "---").join("|") + "|";
    const rows = runs.map((run, index) => {
      const cells = metrics.map((name) => {
        const metric = metricOf(run, name);
        return metric ? metricDisplay(metric) : NO_METRICS;
      });
      return "| " + escapeCell(labels[index]) + " | " + cells.join(" | ") + " |";
    });
    const skipped = selected.length - runs.length;
    const markdown =
      "## 多 run 对比\n\n" +
      "- 对比运行：" + runs.length + " 个\n" +
      "- 共同指标：" + metrics.length + " 个（" + metrics.join(" / ") + "）\n" +
      (skipped > 0 ? "- 已忽略：" + skipped + " 个运行没有指标\n" : "") +
      "\n" +
      [header, separator, ...rows].join("\n") +
      "\n";

    const chart: RunComparisonChart = {
      categories: labels,
      // Shared metrics always have a value here; the 0 fallback keeps values numeric.
      series: metrics.map((name) => ({
        name,
        values: runs.map((run) => metricOf(run, name)?.value ?? 0),
      })),
    };

    let upload: { upload_uuid: string; folderId: number } | undefined;
    try {
      upload = await this.workspace.uploadFile(
        uid,
        projectId,
        "results",
        "results_comparison.md",
        new TextEncoder().encode(markdown),
        "text/markdown; charset=utf-8",
      );
    } catch {
      // Cloud storage is best-effort; the comparison is still returned for the model.
    }
    return {
      markdown,
      chart,
      runs: runs.length,
      metrics,
      ...(upload ? { uploadUuid: upload.upload_uuid, folderId: upload.folderId } : {}),
    };
  }

  /** Resolve the comparison set: explicit runIds (project-scoped) or the newest page. */
  private async selectRuns(uid: string, projectId: string, runIds?: string[]): Promise<AcademicRun[]> {
    const requested = [...new Set((runIds ?? []).map((runId) => runId.trim()).filter(Boolean))].slice(0, RUN_LIMIT);
    if (requested.length === 0) return this.evidence.listRuns(uid, projectId, { limit: RUN_LIMIT });
    const runs: AcademicRun[] = [];
    for (const runId of requested) {
      const run = await this.evidence.getRun(uid, projectId, runId);
      if (run) runs.push(run);
    }
    if (runs.length === 0) throw new Error("指定的运行不存在或无权访问");
    return runs;
  }
}
