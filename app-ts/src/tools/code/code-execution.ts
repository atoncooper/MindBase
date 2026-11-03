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
