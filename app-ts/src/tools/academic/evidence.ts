import { z } from "zod";
import { defineTool } from "../base.js";
import type { ToolRunContext } from "../../context/types.js";
import {
  ACADEMIC_EVIDENCE_ARTIFACT_KIND,
  ACADEMIC_MAX_SCRIPT_CHARS,
  ACADEMIC_RUN_STATUSES,
  ACADEMIC_RUN_STATUS_LABELS,
  runListWindow,
  type AcademicDataset,
  type AcademicEvidenceFile,
  type AcademicEvidenceRepository,
  type AcademicRun,
  type AcademicRunStatus,
} from "../../repository/academic-evidence.js";
import type { AcademicEventRepository, AcademicProjectRepository } from "../../repository/academic.js";

/**
 * academic_evidence: experiment evidence for the academic workspace
 * (desktop academic_evidence parity).
 *
 * Layer: agent tool layer. It orchestrates the injected repositories only; the
 * memory and Mongo evidence adapters stay interchangeable behind the contract.
 *
 * Scope of the tool:
 *  - add_dataset / list_datasets: the input side of an experiment (metadata only,
 *    file content never enters app-ts);
 *  - record_run / list_runs / get_run: what was executed and what came out. The
 *    script is persisted as sha256 + a bounded prefix, previews are bounded and
 *    artifacts are metadata only, so an evidence row can never become a copy of
 *    the full execution log.
 *
 * Invariants:
 *  - Multi-tenant: uid comes from ToolRunContext and never appears in the
 *    schema; every repository call is uid-scoped and every action also verifies
 *    project ownership through deps.projects before touching evidence.
 *  - Expected failures (missing uid/project/run, foreign dataset) degrade into
 *    plain Chinese guidance text so the ReAct loop keeps going.
 *  - All user/LLM-facing copy in this file is Chinese product text and must not
 *    be translated; comments are English.
 */

/**
 * Repositories injected by the composition root. events is optional: when wired,
 * record_run appends the academic.run_recorded audit event (so the project brief
 * timeline shows evidence activity); without it the evidence write still works.
 */
export interface AcademicEvidenceToolDeps {
  runs: AcademicEvidenceRepository;
  projects: AcademicProjectRepository;
  events?: AcademicEventRepository;
}

/** Guidance fallbacks returned instead of throwing (recoverable by re-prompting). */
const NO_USER_TEXT = "当前会话没有用户身份，无法访问学术工作区。";
const NO_PROJECT_TEXT = "项目不存在或无权访问。";
const MISSING_PROJECT_TEXT =
  "缺少 project_id：请先用 academic_project(action=list) 查看研究项目，或 action=create 新建项目。";

/** Display caps for tool text (stored bounds are enforced by the contract builders). */
const SCRIPT_DISPLAY_CHARS = 1200;
const PREVIEW_DISPLAY_CHARS = 1500;
const SHA_DISPLAY_CHARS = 16;

/** Epoch milliseconds to a UTC YYYY-MM-DD date (empty string for unset values). */
function dateOf(ms: number | undefined): string {
  if (!ms) return "";
  return new Date(ms).toISOString().slice(0, 10);
}

/** Epoch milliseconds to a compact UTC "YYYY-MM-DD HH:mm" timestamp. */
function dateTimeOf(ms: number | undefined): string {
  if (!ms) return "";
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

/** Human duration from milliseconds; "" when unset, so callers render "未知". */
function durationText(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return Math.round(ms) + " ms";
  if (ms < 60_000) return (ms / 1000).toFixed(1) + " s";
  return (ms / 60_000).toFixed(1) + " min";
}

/** Human byte size for metadata display ("大小未知" when the caller omitted it). */
function sizeText(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "大小未知";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

/** Truthful prefix for display; "…" marks that the stored value continues. */
function clipForDisplay(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars) + "…" : text;
}

/** Shortened sha256 for prose; the full hash stays in the artifact payload. */
function shortSha(sha: string | undefined): string {
  if (!sha) return "";
  return sha.length > SHA_DISPLAY_CHARS ? sha.slice(0, SHA_DISPLAY_CHARS) + "…" : sha;
}

/** Chinese label for a run status (labels live in the contract). */
function statusText(run: AcademicRun): string {
  return ACADEMIC_RUN_STATUS_LABELS[run.status] ?? run.status;
}

/**
 * Infer the terminal status when the caller omits it: no exit code means the run
 * was only recorded (never claimed as success), 0 means succeeded, anything else
 * failed. An explicit status (e.g. timed_out from the sandbox) always wins.
 */
function inferRunStatus(status: AcademicRunStatus | undefined, exitCode: number | undefined): AcademicRunStatus {
  if (status) return status;
  if (exitCode === undefined) return "recorded";
  return exitCode === 0 ? "succeeded" : "failed";
}

/** File/artifact metadata list for prose, capped so one huge artifact set stays readable. */
function renderFiles(files: readonly AcademicEvidenceFile[]): string {
  const shown = files
    .slice(0, 5)
    .map((file) => file.name + (file.sizeBytes !== undefined ? "（" + sizeText(file.sizeBytes) + "）" : ""));
  const more = files.length > shown.length ? " 等 " + files.length + " 个" : "";
  return shown.join("、") + more;
}

/** Emit the typed evidence payload as a tool artifact for the web client card. */
function pushEvidenceArtifact(ctx: ToolRunContext, data: Record<string, unknown>): void {
  ctx.collector.pushArtifacts([{ kind: ACADEMIC_EVIDENCE_ARTIFACT_KIND, data }]);
}

/** One dataset line for list_datasets (id/source/file count/date plus optional description). */
function renderDataset(dataset: AcademicDataset, index: number): string {
  const lines = [
    (index + 1) +
      ". [" +
      dataset.id +
      "]「" +
      dataset.name +
      "」｜来源：" +
      dataset.source +
      "｜文件 " +
      dataset.files.length +
      " 个｜创建：" +
      dateOf(dataset.createdAt),
  ];
  if (dataset.description) lines.push("   说明：" + dataset.description);
  if (dataset.files.length > 0) lines.push("   文件：" + renderFiles(dataset.files));
  return lines.join("\n");
}

/** One compact run line for list_runs. */
function renderRunRow(run: AcademicRun, index: number, offset: number): string {
  const parts = [
    (offset + index + 1) +
      ". [" +
      run.id +
      "]「" +
      run.name +
      "」｜状态：" +
      statusText(run) +
      "｜语言：" +
      run.language,
  ];
  if (run.exitCode !== undefined) parts.push("退出码：" + run.exitCode);
  const duration = durationText(
    run.startedAt !== undefined && run.finishedAt !== undefined ? run.finishedAt - run.startedAt : undefined,
  );
  if (duration) parts.push("耗时：" + duration);
  parts.push("产物 " + run.artifacts.length + " 个");
  parts.push("创建：" + dateTimeOf(run.createdAt));
  return parts.join("｜");
}

/** Full detail block for get_run: identity, status, timing, script digest, artifacts, previews. */
function renderRunDetail(run: AcademicRun): string {
  const duration = durationText(
    run.startedAt !== undefined && run.finishedAt !== undefined ? run.finishedAt - run.startedAt : undefined,
  );
  const lines = [
    "运行记录「" + run.name + "」（run_id: " + run.id + "）",
    "状态：" +
      statusText(run) +
      "｜语言：" +
      run.language +
      "｜退出码：" +
      (run.exitCode !== undefined ? String(run.exitCode) : "无") +
      "｜耗时：" +
      (duration || "未知"),
    "创建：" +
      dateTimeOf(run.createdAt) +
      (run.startedAt !== undefined ? "｜开始：" + dateTimeOf(run.startedAt) : "") +
      (run.finishedAt !== undefined ? "｜结束：" + dateTimeOf(run.finishedAt) : ""),
  ];
  if (run.datasetId) lines.push("数据集：dataset_id " + run.datasetId);
  if (run.executionId) lines.push("沙箱执行 id：" + run.executionId);
  if (run.cpuMillis !== undefined) lines.push("CPU 耗时：" + durationText(run.cpuMillis));

  if (run.scriptSha256) {
    const storedChars = run.script !== undefined ? run.script.length : 0;
    const boundNote =
      run.script !== undefined && run.script.length >= ACADEMIC_MAX_SCRIPT_CHARS
        ? "，正文超限时只存前 " + ACADEMIC_MAX_SCRIPT_CHARS + " 字符"
        : "";
    lines.push("脚本：sha256=" + run.scriptSha256 + "（已保存正文 " + storedChars + " 字符" + boundNote + "）");
    if (run.script) {
      lines.push("脚本正文（前 " + Math.min(run.script.length, SCRIPT_DISPLAY_CHARS) + " 字符）：");
      lines.push(clipForDisplay(run.script, SCRIPT_DISPLAY_CHARS));
    }
  } else {
    lines.push("脚本：未提供（仅登记了运行元数据）");
  }

  if (run.artifacts.length > 0) {
    lines.push("产物（" + run.artifacts.length + " 个，仅元数据）：");
    for (const artifact of run.artifacts) {
      const detail = [artifact.name];
      if (artifact.sizeBytes !== undefined) detail.push(sizeText(artifact.sizeBytes));
      if (artifact.sha256) detail.push("sha256: " + shortSha(artifact.sha256));
      if (artifact.url) detail.push(artifact.url);
      lines.push("- " + detail.join("｜"));
    }
  } else {
    lines.push("产物：无");
  }

  if (run.stdoutPreview) {
    lines.push("", "标准输出（预览）：", clipForDisplay(run.stdoutPreview, PREVIEW_DISPLAY_CHARS));
  }
  if (run.stderrPreview) {
    lines.push("", "标准错误（预览）：", clipForDisplay(run.stderrPreview, PREVIEW_DISPLAY_CHARS));
  }
  lines.push("", "说明：证据记录只保存脚本摘要、输出预览与产物元数据，不保存完整执行输出。");
  return lines.join("\n");
}

/** File/artifact metadata shape accepted from the model (content is never accepted). */
const evidenceFileSchema = z.object({
  name: z.string().min(1).max(300).describe("文件名"),
  sizeBytes: z.number().int().min(0).optional().describe("字节数（可选）"),
  sha256: z.string().max(128).optional().describe("文件内容 sha256 十六进制（可选）"),
  url: z.string().max(2000).optional().describe("下载/预览 URL（可选）"),
});

/**
 * Tool input schema. uid is deliberately absent: identity comes from the tool
 * context, so the model cannot address another user workspace. Every action
 * requires projectId (evidence is project-scoped).
 */
const evidenceInputSchema = z.object({
  action: z
    .enum(["add_dataset", "list_datasets", "record_run", "list_runs", "get_run"])
    .describe(
      "add_dataset=登记数据集；list_datasets=列出数据集；record_run=记录一次实验运行；list_runs=列出运行记录（分页）；get_run=查看单次运行详情",
    ),
  projectId: z
    .string()
    .min(1)
    .optional()
    .describe("项目 id（所有 action 必填，来自 academic_project(action=list) 或 create 的输出）"),
  name: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("数据集名称（add_dataset 必填）或运行名称（record_run 必填）"),
  description: z.string().max(2000).optional().describe("数据集说明（add_dataset 可选）"),
  source: z
    .string()
    .max(100)
    .optional()
    .describe("数据集来源（add_dataset 可选，缺省 manual：manual / upload / sandbox / url 等）"),
  files: z
    .array(evidenceFileSchema)
    .max(50)
    .optional()
    .describe("数据集文件列表（add_dataset 可选，仅元数据：名称/大小/sha256/URL）"),
  datasetId: z.string().max(100).optional().describe("数据集 id（record_run 可选，必须属于当前项目）"),
  runId: z.string().max(100).optional().describe("运行记录 id（get_run 必填，来自 record_run 或 list_runs 的输出）"),
  language: z.string().min(1).max(40).optional().describe("脚本语言（record_run 必填，如 python / javascript）"),
  script: z
    .string()
    .max(200_000)
    .optional()
    .describe("执行脚本原文（record_run 可选；只保存 sha256 与最多 20000 字符正文）"),
  executionId: z.string().max(100).optional().describe("沙箱执行 id（record_run 可选，来自 run_code 输出）"),
  status: z
    .enum([...ACADEMIC_RUN_STATUSES])
    .optional()
    .describe("运行状态（record_run 可选：succeeded/failed/timed_out/recorded；缺省按 exitCode 推断，0=成功、非 0=失败、无 exitCode=已记录）"),
  exitCode: z.number().int().optional().describe("进程退出码（record_run 可选；用于推断状态）"),
  stdoutPreview: z.string().max(20_000).optional().describe("标准输出预览（record_run 可选，存储时截断至 4000 字符）"),
  stderrPreview: z.string().max(20_000).optional().describe("标准错误预览（record_run 可选，存储时截断至 4000 字符）"),
  artifacts: z
    .array(evidenceFileSchema)
    .max(50)
    .optional()
    .describe("产物元数据列表（record_run 可选：名称/大小/sha256/URL，不接收产物内容）"),
  durationMs: z
    .number()
    .int()
    .min(0)
    .max(24 * 3600 * 1000)
    .optional()
    .describe("运行耗时毫秒（record_run 可选；据此换算 startedAt/finishedAt）"),
  limit: z.number().int().min(1).max(100).optional().describe("list_runs 返回条数（默认 20，上限 100）"),
  offset: z.number().int().min(0).max(10_000).optional().describe("list_runs 偏移（默认 0）"),
});

/**
 * Build the academic_evidence tool.
 *
 * Actions: add_dataset / list_datasets / record_run / list_runs / get_run. Every
 * action verifies project ownership first, then returns Chinese-readable text and
 * pushes an academic_evidence artifact with the typed dataset/run payload. Side
 * effects: evidence writes plus an optional academic.run_recorded project event;
 * no sandbox, network or object storage is touched here.
 */
export function createAcademicEvidenceTool(deps: AcademicEvidenceToolDeps) {
  return defineTool({
    name: "academic_evidence",
    description:
      "学术执行证据（数据集与实验运行记录）。" +
      "action=add_dataset：登记数据集（name 必填，description/source/files 可选；只存文件元数据）；" +
      "action=list_datasets：列出项目已登记数据集；" +
      "action=record_run：记录一次实验运行（name/language 必填；executionId/script/artifacts/exitCode/stdoutPreview/stderrPreview/durationMs 可选），脚本只保存 sha256 与最多 20000 字符正文；" +
      "action=list_runs：列出运行记录（limit/offset 分页，默认 20 条、上限 100）；" +
      "action=get_run：查看单次运行详情（runId 必填）。" +
      "所有 action 都需要 project_id；请与 run_code 配合：执行后用 record_run 登记结果，不要把完整日志当作证据。",
    inputSchema: evidenceInputSchema,
    async execute(args, ctx) {
      const uid = ctx.uid;
      if (!uid) return NO_USER_TEXT;
      const projectId = args.projectId?.trim() ?? "";
      if (!projectId) return MISSING_PROJECT_TEXT;
      const project = await deps.projects.get(uid, projectId);
      if (!project) return NO_PROJECT_TEXT;

      switch (args.action) {
        case "add_dataset": {
          const name = (args.name ?? "").trim();
          if (!name) {
            return "add_dataset 需要 name：给出数据集名称（如「实验一 抽样数据」），可附 files 元数据与 source。";
          }
          const dataset = await deps.runs.addDataset(uid, projectId, {
            name,
            description: args.description?.trim() || undefined,
            source: args.source?.trim() || undefined,
            files: args.files,
          });
          pushEvidenceArtifact(ctx, { action: "add_dataset", projectId, dataset });
          const lines = [
            "已登记数据集「" + dataset.name + "」（dataset_id: " + dataset.id + "）",
            "来源：" +
              dataset.source +
              "｜文件 " +
              dataset.files.length +
              " 个｜创建：" +
              dateOf(dataset.createdAt),
          ];
          if (dataset.description) lines.push("说明：" + dataset.description);
          if (dataset.files.length > 0) lines.push("文件：" + renderFiles(dataset.files));
          lines.push(
            "",
            "下一步：用 action=record_run + datasetId 记录使用该数据集的分析运行；也可用 action=list_datasets 查看全部数据集。",
          );
          return lines.join("\n");
        }

        case "list_datasets": {
          const datasets = await deps.runs.listDatasets(uid, projectId);
          pushEvidenceArtifact(ctx, {
            action: "list_datasets",
            projectId,
            datasets,
            total: datasets.length,
          });
          if (datasets.length === 0) {
            return (
              "项目「" +
              project.title +
              "」还没有登记数据集。可用 action=add_dataset 登记（name 必填，可附文件元数据）。"
            );
          }
          const lines = ["项目「" + project.title + "」共有 " + datasets.length + " 个数据集："];
          datasets.forEach((dataset, index) => lines.push(renderDataset(dataset, index)));
          lines.push("", "可用 action=record_run（datasetId）记录使用某个数据集的分析运行。");
          return lines.join("\n");
        }

        case "record_run": {
          const name = (args.name ?? "").trim();
          if (!name) {
            return "record_run 需要 name：给这次运行一个可识别的名称（如「基线模型训练」）。";
          }
          const language = (args.language ?? "").trim();
          if (!language) {
            return "record_run 需要 language：说明脚本语言（如 python / javascript）。";
          }

          let datasetId: string | undefined;
          const requestedDataset = args.datasetId?.trim() ?? "";
          if (requestedDataset) {
            const datasets = await deps.runs.listDatasets(uid, projectId);
            if (!datasets.some((dataset) => dataset.id === requestedDataset)) {
              return (
                "数据集不存在或不属于该项目：" +
                requestedDataset +
                "。可先用 action=list_datasets 查看已登记数据集，或直接省略 datasetId。"
              );
            }
            datasetId = requestedDataset;
          }

          const status = inferRunStatus(args.status, args.exitCode);
          const now = Date.now();
          const run = await deps.runs.recordRun(uid, projectId, {
            name,
            language,
            status,
            ...(datasetId !== undefined ? { datasetId } : {}),
            ...(args.script !== undefined ? { script: args.script } : {}),
            ...(args.executionId?.trim() ? { executionId: args.executionId.trim() } : {}),
            ...(args.exitCode !== undefined ? { exitCode: args.exitCode } : {}),
            ...(args.stdoutPreview !== undefined ? { stdoutPreview: args.stdoutPreview } : {}),
            ...(args.stderrPreview !== undefined ? { stderrPreview: args.stderrPreview } : {}),
            ...(args.artifacts !== undefined ? { artifacts: args.artifacts } : {}),
            ...(args.durationMs !== undefined ? { startedAt: now - args.durationMs, finishedAt: now } : {}),
          });

          if (deps.events) {
            await deps.events.append(
              uid,
              projectId,
              "academic.run_recorded",
              {
                runId: run.id,
                name: run.name,
                language: run.language,
                status: run.status,
                ...(run.datasetId !== undefined ? { datasetId: run.datasetId } : {}),
                ...(run.executionId !== undefined ? { executionId: run.executionId } : {}),
                ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
                ...(run.scriptSha256 !== undefined ? { scriptSha256: run.scriptSha256 } : {}),
                artifactCount: run.artifacts.length,
              },
              "agent",
            );
          }

          pushEvidenceArtifact(ctx, { action: "record_run", projectId, run });
          const duration = durationText(
            run.startedAt !== undefined && run.finishedAt !== undefined
              ? run.finishedAt - run.startedAt
              : undefined,
          );
          const lines = [
            "已记录运行「" + run.name + "」（run_id: " + run.id + "）",
            "状态：" +
              statusText(run) +
              "｜语言：" +
              run.language +
              "｜退出码：" +
              (run.exitCode !== undefined ? String(run.exitCode) : "无") +
              "｜耗时：" +
              (duration || "未提供"),
          ];
          if (run.datasetId) lines.push("数据集：dataset_id " + run.datasetId);
          if (run.executionId) lines.push("沙箱执行 id：" + run.executionId);
          if (run.scriptSha256) {
            const storedChars = run.script !== undefined ? run.script.length : 0;
            lines.push(
              "脚本：sha256=" + shortSha(run.scriptSha256) + "（已保存正文 " + storedChars + " 字符；完整文本未落库）",
            );
          } else {
            lines.push("脚本：未提供（只登记运行元数据）");
          }
          if (run.artifacts.length > 0) lines.push("产物（" + run.artifacts.length + " 个）：" + renderFiles(run.artifacts));
          if (run.stdoutPreview) {
            lines.push("", "标准输出（预览）：", clipForDisplay(run.stdoutPreview, PREVIEW_DISPLAY_CHARS));
          }
          if (run.stderrPreview) {
            lines.push("", "标准错误（预览）：", clipForDisplay(run.stderrPreview, PREVIEW_DISPLAY_CHARS));
          }
          lines.push("", "可用 action=get_run（runId）查看完整元数据，或 action=list_runs 查看最近运行记录。");
          return lines.join("\n");
        }

        case "list_runs": {
          const window = runListWindow({ limit: args.limit, offset: args.offset });
          const runs = await deps.runs.listRuns(uid, projectId, window);
          pushEvidenceArtifact(ctx, {
            action: "list_runs",
            projectId,
            runs,
            total: runs.length,
            limit: window.limit,
            offset: window.offset,
          });
          if (runs.length === 0) {
            return (
              "项目「" +
              project.title +
              "」还没有运行记录。可用 action=record_run 登记一次实验运行（name/language 必填）。"
            );
          }
          const lines = [
            "项目「" +
              project.title +
              "」的运行记录（offset=" +
              window.offset +
              "，显示 " +
              runs.length +
              " 条，按时间倒序）：",
          ];
          runs.forEach((run, index) => lines.push(renderRunRow(run, index, window.offset)));
          if (runs.length === window.limit) {
            lines.push("", "如需更早记录，可用 action=list_runs，把 offset 增大到 " + (window.offset + runs.length) + "。");
          }
          return lines.join("\n");
        }

        case "get_run": {
          const runId = (args.runId ?? "").trim();
          if (!runId) {
            return "get_run 需要 runId：先 action=list_runs 查看运行记录 id，或用 record_run 返回的 run_id。";
          }
          const run = await deps.runs.getRun(uid, projectId, runId);
          if (!run) {
            return "运行记录不存在或不属于该项目：" + runId + "。可用 action=list_runs 查看该项目的运行记录。";
          }
          pushEvidenceArtifact(ctx, { action: "get_run", projectId, run });
          return renderRunDetail(run);
        }

        default: {
          const action = String((args as { action?: unknown }).action ?? "");
          return (
            "未知 action：" +
            action +
            "（可用：add_dataset / list_datasets / record_run / list_runs / get_run）"
          );
        }
      }
    },
  });
}
