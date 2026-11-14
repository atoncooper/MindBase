import { z } from "zod";
import { defineTool } from "../base.js";
import type { Artifact } from "../../context/types.js";
import { buildFileArtifact } from "../../artifacts/file.js";
import { DOCX_MIME } from "../../doc-parser/docx.js";
import type { CodeExecutionPort, CodeExecutionResult } from "./code-execution.js";

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

export function createRunCodeTool(exec: CodeExecutionPort) {
  return defineTool({
    name: "run_code",
    description:
      "在隔离沙箱中运行一段代码并返回 stdout/stderr，附带 execution_id 与产物列表（如有）。用于验证代码正确性。",
    inputSchema: z.object({
      language: z.enum(["javascript", "python"]).describe("语言"),
      code: z.string().min(1).max(20_000).describe("完整代码"),
      timeoutMs: z.number().int().positive().optional().describe("超时毫秒，默认 10000"),
    }),
    async execute(args, ctx, signal) {
      const res = await exec.run(
        {
          language: args.language,
          code: args.code,
          ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
          ...(ctx.uid !== undefined ? { uid: ctx.uid } : {}),
        },
        signal,
      );

      if (!res.sandboxAvailable) {
        const reason = res.error?.trim() || res.stderr.trim() || "沙箱未配置";
        return `沙箱不可用：${reason}。\n无法运行代码，请直接给出代码与讲解，并注明未经实际运行验证。`;
      }

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
      lines.push(res.stdout ? `stdout:\n${res.stdout.slice(0, 4000)}` : "stdout: (空)");
      if (res.stderr) lines.push(`stderr:\n${res.stderr.slice(0, 2000)}`);
      if (!res.ok && res.error) lines.push(`error: ${res.error}`);

      const content = lines.join("\n");
      // File cards ride the SSE artifact frame; when the run produced none the
      // plain-string contract stays untouched.
      const artifacts = fileArtifactsOf(res);
      return artifacts.length > 0 ? { content, artifacts } : content;
    },
  });
}
