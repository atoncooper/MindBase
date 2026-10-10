/**
 * CodeExecutionPort: code sandbox execution (mirrors the Daytona sandbox position of the Python code agent).
 * v1 stub returns not-configured; swap the implementation when Daytona lands, zero changes to agents and tools.
 */
export interface CodeExecutionResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  sandboxAvailable: boolean;
}

export interface CodeExecutionPort {
  run(language: string, code: string, timeoutMs?: number): Promise<CodeExecutionResult>;
}

/** stub: sandbox not configured. Returns explicit semantics so the agent can honestly tell the user instead of pretending success. */
export class NoopCodeExecution implements CodeExecutionPort {
  async run(_language: string, _code: string, _timeoutMs?: number): Promise<CodeExecutionResult> {
    return {
      ok: false,
      stdout: "",
      stderr: "代码沙箱未配置（NoopCodeExecution）",
      sandboxAvailable: false,
    };
  }
}
