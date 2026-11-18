import { describe, expect, it } from "vitest";
import { createRunCodeTool } from "../src/tools/code/index.js";
import type { CodeExecutionPort, CodeExecutionResult } from "../src/tools/code/code-execution.js";

function okPort(called: { value: boolean }): CodeExecutionPort {
  return {
    async run(): Promise<CodeExecutionResult> {
      called.value = true;
      return { ok: true, stdout: "1", stderr: "", sandboxAvailable: true, exitCode: 0 };
    },
  };
}

const ctx = { uid: "u1", academicProjectId: "p1" } as never;

describe("research execution guard (D1)", () => {
 it("blocks run_code in a project chat until an experiment is approved", async () => {
    const called = { value: false };
    const tool = createRunCodeTool(okPort(called), async () => "需要人工审批");
    const result = await tool.execute({ language: "python", code: "print(1)" }, ctx);
    expect(result).toBe("需要人工审批");
    expect(called.value).toBe(false);
  });

 it("runs when the guard allows (no project / approved)", async () => {
    const called = { value: false };
    const tool = createRunCodeTool(okPort(called), async () => undefined);
    const result = await tool.execute({ language: "python", code: "print(1)" }, ctx);
    expect(called.value).toBe(true);
    expect(String(result)).toContain("exit_code: 0");
  });
});
