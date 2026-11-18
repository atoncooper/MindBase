/**
 * CodeExecutionPort: code sandbox execution (mirrors the Daytona sandbox position
 * of the Python code agent).
 *
 * This port is the ONLY sandbox boundary in the tool layer: `run_code` (and the
 * future academic_evidence tool) call it with a request snapshot, and the
 * composition root decides which implementation backs it :
 *  - HttpCodeExecution → remote app-sandbox control plane (POST /v1/executions +
 *    polling; X-API-Key + X-Uid);
 *  - NoopCodeExecution → honest degradation when `sandbox.enabled=false`.
 *
 * Neither implementation may throw through the ReAct loop: every failure is
 * reported as `sandboxAvailable=false` plus a readable Chinese `error`, so the
 * agent can tell the user the code was NOT actually run instead of pretending.
 */

/** One artifact produced by a sandbox execution (presigned URL when available). */
export interface CodeExecutionArtifact {
  name: string;
  /** byte size as reported by the sandbox */
  sizeBytes?: number;
  /** content hash (sha256) when the control plane computed one */
  sha256?: string;
  /** short-lived presigned download URL (sandbox-owned object storage) */
  url?: string;
}

/**
 * Execution outcome. `ok` is true only for a succeeded run with exit code 0;
 * `sandboxAvailable=false` means the remote sandbox could not be reached/reused
 * and the code was NOT run at all (never confused with a failing program).
 */
export interface CodeExecutionResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  sandboxAvailable: boolean;
  /** remote execution id (absent for the stub or when creation failed) */
  executionId?: string;
  /** process exit code when the sandbox reports one */
  exitCode?: number;
  /** artifact summaries (LLM-visible) */
  artifacts?: CodeExecutionArtifact[];
  /** failure reason (Chinese) shown to the agent; set whenever ok=false */
  error?: string;
  /** wall-clock duration reported by the control plane (ms) */
  durationMs?: number;
  /** total bytes written to stdout/stderr (may exceed the returned preview) */
  stdoutBytes?: number;
  stderrBytes?: number;
  /** true when stdout/stderr was truncated in this result */
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

/**
 * One execution request. `uid` comes from ToolRunContext (the runtime injects
 * identity per call; it is never an LLM-controlled schema field) and rides the
 * X-Uid header to app-sandbox for quota/lease/audit scoping.
 */
export interface CodeExecutionRequest {
  language: string;
  code: string;
  /** per-execution budget handed to the sandbox (ms) */
  timeoutMs?: number;
  /** tenant id from ToolRunContext */
  uid?: string;
  /** research project scope (lease reuse/isolation) from ToolRunContext */
  projectId?: string;
  /** calling surface: chat | experiment | ... */
  purpose?: string;
  /** text files materialized before execution (path must stay under /workspace) */
  files?: Array<{ path: string; content: string }>;
  /** extra output globs under the configured artifact root */
  artifactGlobs?: string[];
}

/** One offset-addressed read of a text file in the sandbox workspace. */
export interface SandboxFileReadRequest {
  path: string;
  /** UTF-8 byte offset; pass nextOffset from the previous read to continue. */
  offset?: number;
  /** max bytes to return; server clamps to 128 KiB */
  limit?: number;
  uid?: string;
  projectId?: string;
  purpose?: string;
}

export interface SandboxFileReadResult {
  path: string;
  content: string;
  offset: number;
  bytes: number;
  totalBytes: number;
  /** true when the file has bytes after nextOffset */
  hasMore: boolean;
  nextOffset: number;
}

export interface SandboxFileWriteRequest {
  path: string;
  content: string;
  encoding?: "utf8" | "base64";
  uid?: string;
  projectId?: string;
  purpose?: string;
}

export interface SandboxFileWriteResult {
  path: string;
  bytes: number;
}

/** File I/O capabilities exposed by the remote sandbox (not the Noop stub). */
export interface CodeFilePort {
  readFile(request: SandboxFileReadRequest, signal?: AbortSignal): Promise<SandboxFileReadResult>;
  writeFile(request: SandboxFileWriteRequest, signal?: AbortSignal): Promise<SandboxFileWriteResult>;
}

/** One offset-addressed read of a terminal execution's stdout/stderr. */
export interface SandboxOutputRequest {
  executionId: string;
  stream?: "stdout" | "stderr";
  offset?: number;
  limit?: number;
  uid?: string;
}

export interface SandboxOutputResult {
  executionId: string;
  stream: "stdout" | "stderr";
  content: string;
  offset: number;
  bytes: number;
  totalBytes: number;
  sourceBytes: number;
  truncated: boolean;
  hasMore: boolean;
  nextOffset: number;
}

/** One paged read of a stored artifact. */
export interface SandboxArtifactReadRequest {
  executionId: string;
  name: string;
  offset?: number;
  limit?: number;
  uid?: string;
}

export interface SandboxArtifactReadResult {
  executionId: string;
  name: string;
  contentType: string;
  encoding: "utf8" | "base64";
  binary: boolean;
  content: string;
  offset: number;
  bytes: number;
  totalBytes: number;
  hasMore: boolean;
  nextOffset: number;
}

export interface CodeArtifactPort {
  readArtifact(request: SandboxArtifactReadRequest, signal?: AbortSignal): Promise<SandboxArtifactReadResult>;
}

/** Static runtime contract exposed by app-sandbox. */
export interface SandboxRuntimeInfo {
  runtime: string;
  image: string;
  cpu: string;
  memory: string;
  networkDefaultAction: string;
  egressAllow: string[];
  acceptedLanguages: string[];
  notes: string[];
}

/** Runtime capability discovery (image/limits/network). */
export interface CodeInfoPort {
  getInfo(signal?: AbortSignal): Promise<SandboxRuntimeInfo>;
}

/** Paged output capability exposed by the remote sandbox. */
export interface CodeOutputPort {
  readOutput(request: SandboxOutputRequest, signal?: AbortSignal): Promise<SandboxOutputResult>;
}

/** Port consumed by run_code; implementations must never reject. */
export interface CodeExecutionPort {
  /**
   * Run one snippet. `signal` is the per-call cancellation from the tool runtime
   * (stop button / timeout manager) and is forwarded to the remote HTTP calls;
   * implementations that cannot be cancelled simply ignore it.
   */
  run(request: CodeExecutionRequest, signal?: AbortSignal): Promise<CodeExecutionResult>;
}

const NOOP_ERROR = "代码沙箱未配置（NoopCodeExecution）";

/**
 * Stub: sandbox not configured. Returns explicit semantics so the agent can
 * honestly tell the user instead of pretending success.
 */
export class NoopCodeExecution implements CodeExecutionPort {
  async run(_request: CodeExecutionRequest, _signal?: AbortSignal): Promise<CodeExecutionResult> {
    return {
      ok: false,
      stdout: "",
      stderr: NOOP_ERROR,
      sandboxAvailable: false,
      error: NOOP_ERROR,
    };
  }
}
