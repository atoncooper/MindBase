import { describe, expect, it } from "vitest";
import type { CodeOutputPort } from "../src/tools/code/code-execution.js";
import { createSandboxExecutionOutputTool } from "../src/tools/code/output.js";

const ctx = { uid: "7", academicProjectId: "p1", scope: {}, collector: {} } as never;

function port(): CodeOutputPort {
  return {
    async readOutput() {
      return {
        executionId: "exec-1",
        stream: "stdout",
        content: "page",
        offset: 0,
        bytes: 4,
        totalBytes: 100,
        sourceBytes: 200,
        truncated: true,
        hasMore: true,
        nextOffset: 4,
      };
    },
  };
}

describe("sandbox_execution_output", () => {
  it("返回 has_more、next_offset 与 capture 截断提示", async () => {
    const tool = createSandboxExecutionOutputTool(port());
    const result = String(await tool.execute({ execution_id: "exec-1" }, ctx));
    expect(result).toContain("has_more: true");
    expect(result).toContain("next_offset: 4");
    expect(result).toContain("source_bytes: 200");
    expect(result).toContain("truncated: true");
    expect(result).toContain("offset=4");
  });
});
