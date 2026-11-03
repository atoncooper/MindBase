import { describe, expect, it, vi } from "vitest";
import { ResultCollector, type ToolRunContext } from "../src/context/types.js";
import { NoopCodeExecution, type CodeExecutionRequest } from "../src/tools/code/code-execution.js";
import { HttpCodeExecution, type SandboxFetch } from "../src/tools/code/http-execution.js";
import { createRunCodeTool } from "../src/tools/code/index.js";

/**
 * HttpCodeExecution (plan/1.0.18 §十): offline unit tests over a fake fetch.
 *
 * Covers the wire mapping (create → poll → terminal state), identity/credential
 * headers, artifacts, every failure class (network / non-2xx / local timeout /
 * cancellation) and the run_code presentation layer. No network, no timers are
 * left behind (sleep + clock are injected).
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface RecordedCall {
  url: string;
  init?: RequestInit;
  body?: unknown;
}

/** Scripted fetch: the handler receives each call and its 0-based index. */
function scriptedFetch(
  handler: (call: RecordedCall, index: number) => Response | Promise<Response>,
): { fetchImpl: SandboxFetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl: SandboxFetch = async (url, init) => {
    const call: RecordedCall = { url, init };
    if (typeof init?.body === "string") {
      try {
        call.body = JSON.parse(init.body) as unknown;
      } catch {
        call.body = init.body;
      }
    }
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return { fetchImpl, calls };
}

function makeExec(options: {
  fetchImpl: SandboxFetch;
  timeoutMs?: number;
  pollIntervalMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
  nowImpl?: () => number;
  apiKey?: string;
}): HttpCodeExecution {
  return new HttpCodeExecution({
    // Trailing slash on purpose: the adapter must normalize it away.
    baseUrl: "http://sandbox.local/internal/sandbox/",
    apiKey: options.apiKey ?? "test-key",
    timeoutMs: options.timeoutMs ?? 5000,
    pollIntervalMs: options.pollIntervalMs ?? 100,
    fetchImpl: options.fetchImpl,
    ...(options.sleepImpl ? { sleepImpl: options.sleepImpl } : {}),
    ...(options.nowImpl ? { nowImpl: options.nowImpl } : {}),
  });
}

function headersOf(call: RecordedCall | undefined): Record<string, string> {
  return (call?.init?.headers ?? {}) as Record<string, string>;
}

function makeCtx(uid?: string): ToolRunContext {
  return { uid, scope: {}, collector: new ResultCollector() };
}

const TOOL_OUTPUT = (out: unknown): string =>
  typeof out === "string" ? out : (out as { content: string }).content;

describe("HttpCodeExecution: 成功路径", () => {
  it("创建 → 轮询 running → succeeded，映射 stdout/exitCode/artifacts 与身份头", async () => {
    const { fetchImpl, calls } = scriptedFetch((_call, index) => {
      if (index === 0) {
        return jsonResponse({ executionId: "exec-1", leaseId: "lease-1", state: "queued" }, 202);
      }
      if (index === 1) return jsonResponse({ status: "running" });
      return jsonResponse({
        status: "succeeded",
        exitCode: 0,
        stdoutPreview: "hello\n",
        stderrPreview: "",
        durationMs: 42,
        artifacts: [
          { name: "out.csv", size: 12, sha256: "abc123", url: "http://minio/presigned" },
        ],
      });
    });
    const sleeps: number[] = [];
    const exec = makeExec({
      fetchImpl,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
    });

    const result = await exec.run({
      language: "python",
      code: "print('hello')",
      timeoutMs: 10_000,
      uid: "42",
    });

    expect(result.ok).toBe(true);
    expect(result.sandboxAvailable).toBe(true);
    expect(result.executionId).toBe("exec-1");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello");
    expect(result.stderr).toBe("");
    expect(result.durationMs).toBe(42);
    expect(result.artifacts).toEqual([
      { name: "out.csv", sizeBytes: 12, sha256: "abc123", url: "http://minio/presigned" },
    ]);

    // create + running + succeeded
    expect(calls).toHaveLength(3);
    expect(calls[0]?.url).toBe("http://sandbox.local/internal/sandbox/v1/executions");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.body).toEqual({
      language: "python",
      code: "print('hello')",
      timeoutMs: 10_000,
    });
    expect(calls[1]?.url).toBe("http://sandbox.local/internal/sandbox/v1/executions/exec-1");
    expect(calls[1]?.init?.method).toBe("GET");

    const createHeaders = headersOf(calls[0]);
    expect(createHeaders.apikey).toBe("test-key"); // APISIX key-auth consumer
    expect(createHeaders["X-API-Key"]).toBe("test-key"); // app-sandbox self-auth
    expect(createHeaders["X-Uid"]).toBe("42");
    expect(createHeaders["Content-Type"]).toBe("application/json");
    // GET has no body → no JSON content-type
    expect(headersOf(calls[1])["Content-Type"]).toBeUndefined();
    expect(sleeps).toEqual([100]); // exactly one wait between the two polls
  });

  it("缺少 uid 时不发送 X-Uid；兼容响应里的 id 别名", async () => {
    const { fetchImpl, calls } = scriptedFetch((_call, index) => {
      if (index === 0) return jsonResponse({ id: "exec-alias", state: "creating" }, 202);
      return jsonResponse({ status: "succeeded", exitCode: 0, stdoutPreview: "ok" });
    });
    const exec = makeExec({ fetchImpl, sleepImpl: async () => {} });
    const result = await exec.run({ language: "javascript", code: "1+1" });

    expect(result.ok).toBe(true);
    expect(result.executionId).toBe("exec-alias");
    expect(headersOf(calls[0])["X-Uid"]).toBeUndefined();
  });
});

describe("HttpCodeExecution: 失败与超时", () => {
  it("终端 failed 状态 → sandboxAvailable=true、ok=false、保留 stderr/exitCode", async () => {
    const { fetchImpl } = scriptedFetch((_call, index) => {
      if (index === 0) return jsonResponse({ executionId: "exec-fail" }, 202);
      return jsonResponse({
        status: "failed",
        exitCode: 2,
        stdoutPreview: "",
        stderrPreview: "Traceback: boom",
        errorCode: "EXIT_NONZERO",
      });
    });
    const exec = makeExec({ fetchImpl, sleepImpl: async () => {} });
    const result = await exec.run({ language: "python", code: "raise SystemExit(2)", uid: "7" });

    expect(result.sandboxAvailable).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Traceback: boom");
    expect(result.error).toContain("失败");
    expect(result.error).toContain("EXIT_NONZERO");
  });

  it("终端 timed_out 状态 → 明确超时错误（沙箱可用）", async () => {
    const { fetchImpl } = scriptedFetch((_call, index) => {
      if (index === 0) return jsonResponse({ executionId: "exec-slow" }, 202);
      return jsonResponse({ status: "timed_out", exitCode: 124, stdoutPreview: "" });
    });
    const exec = makeExec({ fetchImpl, sleepImpl: async () => {} });
    const result = await exec.run({ language: "python", code: "while True: pass", uid: "7" });

    expect(result.sandboxAvailable).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(124);
    expect(result.error).toContain("超时");
  });

  it("连接失败 → sandboxAvailable=false + 中文连接错误（不抛穿）", async () => {
    const fetchImpl: SandboxFetch = async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:9080");
    };
    const exec = makeExec({ fetchImpl });
    const result = await exec.run({ language: "python", code: "print(1)", uid: "7" });

    expect(result.sandboxAvailable).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("连接失败");
    expect(result.error).toContain("ECONNREFUSED");
    expect(result.stdout).toBe("");
  });

  it("非 2xx（配额 429）→ 透传 detail 并标记沙箱不可用", async () => {
    const { fetchImpl } = scriptedFetch(() => jsonResponse({ detail: "今日代码执行次数已用完" }, 429));
    const exec = makeExec({ fetchImpl });
    const result = await exec.run({ language: "python", code: "print(1)", uid: "7" });

    expect(result.sandboxAvailable).toBe(false);
    expect(result.error).toContain("HTTP 429");
    expect(result.error).toContain("今日代码执行次数已用完");
  });

  it("本地超时 → 停止轮询并返回明确超时（不假装成功）", async () => {
    let now = 0;
    const { fetchImpl, calls } = scriptedFetch((_call, index) => {
      if (index === 0) return jsonResponse({ executionId: "exec-poll" }, 202);
      return jsonResponse({ status: "running" });
    });
    const exec = makeExec({
      fetchImpl,
      timeoutMs: 100,
      pollIntervalMs: 30,
      nowImpl: () => now,
      sleepImpl: async (ms) => {
        now += ms;
      },
    });

    const result = await exec.run({ language: "python", code: "print(1)", uid: "7" });

    expect(result.sandboxAvailable).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("超时");
    expect(result.error).toContain("100ms");
    expect(result.executionId).toBe("exec-poll");
    // create + a bounded number of polls; it must stop at the deadline.
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.length).toBeLessThanOrEqual(1 + Math.ceil(100 / 30) + 1);
  });

  it("调用前已取消 → 不发起任何请求", async () => {
    const { fetchImpl, calls } = scriptedFetch(() => jsonResponse({ executionId: "exec-cancel" }, 202));
    const exec = makeExec({ fetchImpl });
    const controller = new AbortController();
    controller.abort();

    const result = await exec.run({ language: "python", code: "print(1)", uid: "7" }, controller.signal);

    expect(calls).toHaveLength(0);
    expect(result.sandboxAvailable).toBe(false);
    expect(result.error).toContain("取消");
  });
});

describe("NoopCodeExecution: 未启用不联网", () => {
  it("返回 sandboxAvailable=false 且绝不触网，run_code 输出诚实提示", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const port = new NoopCodeExecution();
      const result = await port.run({ language: "python", code: "print(1)", uid: "7" });
      expect(result.sandboxAvailable).toBe(false);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("沙箱未配置");

      const tool = createRunCodeTool(port);
      const output = TOOL_OUTPUT(
        await tool.execute({ language: "python", code: "print(1)" }, makeCtx("7")),
      );
      expect(output).toContain("沙箱未配置");
      expect(output).toContain("未经实际运行验证");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("run_code: 展示层", () => {
  it("透传 uid / timeoutMs / signal，并输出 execution_id 与 artifacts 摘要", async () => {
    let captured: CodeExecutionRequest | undefined;
    let capturedSignal: AbortSignal | undefined;
    const tool = createRunCodeTool({
      async run(request, signal) {
        captured = request;
        capturedSignal = signal;
        return {
          ok: true,
          stdout: "hi\n",
          stderr: "",
          sandboxAvailable: true,
          executionId: "exec-42",
          exitCode: 0,
          artifacts: [{ name: "out.csv", sizeBytes: 12, url: "http://minio/x" }],
        };
      },
    });

    const controller = new AbortController();
    const output = TOOL_OUTPUT(
      await tool.execute(
        { language: "python", code: "print('hi')", timeoutMs: 1000 },
        makeCtx("9"),
        controller.signal,
      ),
    );

    expect(captured).toEqual({
      language: "python",
      code: "print('hi')",
      timeoutMs: 1000,
      uid: "9",
    });
    expect(capturedSignal).toBe(controller.signal);
    expect(output).toContain("exit: ok");
    expect(output).toContain("exit_code: 0");
    expect(output).toContain("execution_id: exec-42");
    expect(output).toContain("artifacts (1):");
    expect(output).toContain("- out.csv (12 bytes) http://minio/x");
    expect(output).toContain("hi");
  });

  it("sandboxAvailable=false 的输出带原因且提示代码未运行", async () => {
    const tool = createRunCodeTool({
      async run() {
        return {
          ok: false,
          stdout: "",
          stderr: "",
          sandboxAvailable: false,
          error: "代码沙箱连接失败：ECONNREFUSED",
        };
      },
    });
    const output = TOOL_OUTPUT(
      await tool.execute({ language: "python", code: "print(1)" }, makeCtx("7")),
    );
    expect(output).toContain("沙箱不可用");
    expect(output).toContain("代码沙箱连接失败");
    expect(output).toContain("未经实际运行验证");
  });
});
