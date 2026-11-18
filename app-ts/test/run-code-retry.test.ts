import { describe, expect, it } from "vitest";
import type { CodeExecutionPort, CodeExecutionResult } from "../src/tools/code/code-execution.js";
import { createRunCodeTool } from "../src/tools/code/index.js";

const ctx = { uid: "7", chatSessionId: "s1", scope: {}, collector: {} } as never;

function timeoutPort(calls: { value: number }): CodeExecutionPort {
  return {
    async run(): Promise<CodeExecutionResult> {
      calls.value += 1;
      return {
        ok: false,
        stdout: "",
        stderr: "timeout",
        sandboxAvailable: true,
        executionId: "exec-" + calls.value,
        error: "沙箱执行超时",
      };
    },
  };
}

describe("run_code retry budget", () => {
  it("相同代码 6 次后拒绝执行，改代码可继续", async () => {
    const calls = { value: 0 };
    const tool = createRunCodeTool(timeoutPort(calls));
    for (let i = 1; i <= 6; i += 1) {
      const output = String(await tool.execute({ language: "python", code: "print(1)" }, ctx));
      expect(output).toContain("retry_budget: attempt " + i + "/6");
      expect(output).toContain("remaining_retries=" + (6 - i));
    }
    const blocked = String(await tool.execute({ language: "python", code: "print(1)" }, ctx));
    expect(blocked).toContain("达到上限，未再执行");
    expect(calls.value).toBe(6);

    const changed = String(await tool.execute({ language: "python", code: "print(2)" }, ctx));
    expect(changed).toContain("retry_budget: attempt 1/6");
    expect(calls.value).toBe(7);
  });
});
