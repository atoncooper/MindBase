import { z } from "zod";
import { defineTool } from "../base.js";
import type { Artifact } from "../../context/types.js";
import { buildFileArtifact } from "../../artifacts/file.js";
import { DOCX_MIME } from "../../doc-parser/docx.js";
import type { CodeExecutionPort, CodeExecutionResult } from "./code-execution.js";
import type { ResearchExecutionGuard } from "./execution-guard.js";
import { CodeRetryBudget } from "./retry-budget.js";

/**
 * run_code: executes code in the sandbox .
 *
 * The tool only orchestrates the injected CodeExecutionPort: identity (uid) comes
 * from ToolRunContext, the cancellation signal from the tool runtime, and the
 * port decides whether the backend is the remote app-sandbox control plane or the
 * honest Noop stub. Output is Chinese plain text for the ReAct loop: execution id
 * and artifact summaries are included so the agent can cite what actually ran.
 *
 * Sandbox files are additionally emitted as kind="file" artifacts (bounded, up to
 * MAX_FILE_ARTIFACTS) so the web client can render download/preview cards; the
 * text output keeps listing every artifact so the model still knows they exist.
 *
 * Failure policy: a port result with `sandboxAvailable=false` is rendered as
 * guidance telling the model the code was NOT executed — the tool never throws and
 * never fabricates a successful run.
 */

/** Sandbox artifacts turned into file cards per run (the text output still lists all of them). */
const MAX_FILE_ARTIFACTS = 4;

/**
 * Extension → MIME map for the artifacts a sandbox run usually emits. Unknown
 * extensions fall back to application/octet-stream so the card still renders
 * with a generic icon.
 */
const MIME_BY_EXTENSION: Record<string, string> = {
  py: "text/x-python",
  js: "text/javascript",
  json: "application/json",
  csv: "text/csv",
  md: "text/markdown",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  docx: DOCX_MIME,
};
const DEFAULT_MIME = "application/octet-stream";

/** MIME for a sandbox artifact name (extension only; the port does not report a type). */
function mimeForFileName(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return DEFAULT_MIME;
  return MIME_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? DEFAULT_MIME;
}

/**
 * Convert a succeeded run's artifacts into kind="file" cards (bounded; artifacts
 * rejected by validation are dropped rather than failing the whole run).
 *
 * Only succeeded runs are converted: a failed program may leave half-written
 * files that must not be offered to the user as a deliverable. Files without a
 * download URL and without an uploadUuid are still useful cards (name + size),
 * so they are kept.
 */
function fileArtifactsOf(res: CodeExecutionResult): Artifact[] {
  if (!res.ok) return [];
  const artifacts: Artifact[] = [];
  for (const artifact of res.artifacts ?? []) {
    if (artifacts.length >= MAX_FILE_ARTIFACTS) break;
    const built = buildFileArtifact({
      name: artifact.name,
      description: "由沙箱代码生成",
      action: "generated",
      mime: mimeForFileName(artifact.name),
      ...(artifact.sizeBytes !== undefined ? { sizeBytes: artifact.sizeBytes } : {}),
      ...(artifact.url ? { url: artifact.url } : {}),
    });
    if (built.ok) artifacts.push(built.artifact);
  }
  return artifacts;
}

export function createRunCodeTool(exec: CodeExecutionPort, guard?: ResearchExecutionGuard) {
  const retryBudget = new CodeRetryBudget();
  return defineTool({
    name: "run_code",
    description:
      "在隔离沙箱中运行一段代码并返回 stdout/stderr，附带 execution_id 与产物列表（如有）。" +
      "python 始终可用；javascript 需要镜像包含 node（默认镜像没有）。" +
      "长任务必须显式传 timeoutMs（默认 130000ms，上限 1 小时）；输出被截断时用 sandbox_execution_output 续读。" +
      "同一份完整代码版本（language+code+files 都未变）最多执行 6 次（首次 + 5 次重试）；改代码会重新获得重试预算。",
    maxRepeats: 6,
    defaultTimeoutMs: 130_000,
    inputSchema: z.object({
      language: z.enum(["javascript", "python"]).describe("语言"),
      code: z.string().min(1).max(20_000).describe("完整代码"),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .max(3_600_000)
        .optional()
        .describe("本次执行超时毫秒，默认 130000；长任务请显式加大（最长 1 小时）"),
      files: z
        .array(
          z.object({
            path: z.string().min(1).max(512).describe("沙箱内的绝对路径，必须在 /workspace 下"),
            content: z.string().max(1_000_000).describe("文件文本内容"),
          }),
        )
        .max(20)
        .optional()
        .describe("执行前写入 /workspace 的文本输入文件（最多 20 个，单个 ≤1MB）"),
      artifactGlobs: z
        .array(z.string().min(1).max(512))
        .max(10)
        .optional()
        .describe("额外产物 glob，必须在 /workspace/analysis/outputs 下"),
    }),
    async execute(args, ctx, signal) {
      // Research project chats require an approved experiment first ().
      if (guard) {
        const blocked = await guard(ctx);
        if (blocked) return blocked;
      }
      const retry = retryBudget.begin({
        ...(ctx.uid !== undefined ? { uid: ctx.uid } : {}),
        ...(ctx.chatSessionId !== undefined ? { sessionId: ctx.chatSessionId } : {}),
        language: args.language,
        code: args.code,
        ...(args.files ? { files: args.files } : {}),
      });
      if (!retry.allowed) {
        return (
          "同一份代码版本（language+code+files 均未变化）已执行 " +
          retry.maxAttempts +
          " 次（首次 + 5 次重试），达到上限，未再执行。\n" +
          "请修改代码/输入文件后再试，或改用 sandbox_bash 分步排查。\n" +
          "code_version: " + retry.version
        );
      }
      const res = await exec.run(
        {
          language: args.language,
          code: args.code,
          ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
          ...(ctx.uid !== undefined ? { uid: ctx.uid } : {}),
          ...(ctx.academicProjectId
            ? { projectId: ctx.academicProjectId, purpose: "chat" }
            : {}),
          ...(args.files && args.files.length > 0 ? { files: args.files } : {}),
          ...(args.artifactGlobs && args.artifactGlobs.length > 0
            ? { artifactGlobs: args.artifactGlobs }
            : {}),
        },
        signal,
      );

      if (!res.sandboxAvailable) {
        // No execution id = transport/quota refusal, not a real attempt: refund.
        if (!res.executionId) retryBudget.refund(retry.key);
        const reason = res.error?.trim() || res.stderr.trim() || "沙箱未配置";
        const retryInfo = res.executionId
          ? `\nretry_budget: attempt ${retry.attempt}/${retry.maxAttempts}, remaining_retries=${retry.remainingRetries}, code_version=${retry.version}`
          : "";
        return `沙箱不可用：${reason}。\n无法运行代码，请直接给出代码与讲解，并注明未经实际运行验证。${retryInfo}`;
      }
      if (res.ok) retryBudget.success(retry.key);

      const lines = [`exit: ${res.ok ? "ok" : "failed"}`];
      if (res.exitCode !== undefined) lines.push(`exit_code: ${res.exitCode}`);
      if (res.executionId) lines.push(`execution_id: ${res.executionId}`);
      if (res.artifacts && res.artifacts.length > 0) {
        lines.push(`artifacts (${res.artifacts.length}):`);
        for (const artifact of res.artifacts) {
          const size = artifact.sizeBytes !== undefined ? ` (${artifact.sizeBytes} bytes)` : "";
          const url = artifact.url ? ` ${artifact.url}` : "";
          lines.push(`- ${artifact.name}${size}${url}`);
        }
      }
      if (res.stdoutTruncated || res.stderrTruncated) {
        const total = (res.stdoutTruncated ? res.stdoutBytes : res.stderrBytes) ?? 0;
        lines.push(
          "output_truncated: true (total " +
            total +
            " bytes; use sandbox_execution_output execution_id=" +
            (res.executionId ?? "?") +
            " with offset/next_offset to read the full stream)",
        );
      }
      lines.push(res.stdout ? `stdout:\n${res.stdout.slice(0, 4000)}` : "stdout: (空)");
      if (res.stderr) lines.push(`stderr:\n${res.stderr.slice(0, 2000)}`);
      if (!res.ok && res.error) lines.push(`error: ${res.error}`);
      if (!res.ok) {
        lines.push(
          "retry_budget: attempt " +
            retry.attempt +
            "/" +
            retry.maxAttempts +
            ", remaining_retries=" +
            retry.remainingRetries +
            ", code_version=" +
            retry.version,
        );
        if (retry.remainingRetries > 0) {
          lines.push(
            "提示：若确认是超时/瞬时问题，可用相同代码和更大 timeoutMs 重试；剩余 " +
              retry.remainingRetries +
              " 次。修改代码会重置预算。",
          );
        } else {
          lines.push("提示：本代码版本重试预算已用尽，请修改代码或改用其他排查方式。");
        }
      }

      const content = lines.join("\n");
      // File cards ride the SSE artifact frame; when the run produced none the
      // plain-string contract stays untouched.
      const artifacts = fileArtifactsOf(res);
      return artifacts.length > 0 ? { content, artifacts } : content;
    },
  });
}
