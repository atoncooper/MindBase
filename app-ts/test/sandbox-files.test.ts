import { describe, expect, it } from "vitest";
import type { CodeFilePort } from "../src/tools/code/code-execution.js";
import { createSandboxReadFileTool, createSandboxWriteFileTool } from "../src/tools/code/files.js";

const ctx = { uid: "7", academicProjectId: "p1", scope: {}, collector: {} } as never;

function port(overrides: Partial<CodeFilePort> = {}): CodeFilePort {
  return {
    async readFile() {
      return {
        path: "/workspace/a.txt",
        content: "first page",
        offset: 0,
        bytes: 10,
        totalBytes: 25,
        hasMore: true,
        nextOffset: 10,
      };
    },
    async writeFile() {
      return { path: "/workspace/b.txt", bytes: 3 };
    },
    ...overrides,
  };
}

describe("sandbox file tools", () => {
  it("read_file 明确返回 has_more 与 next_offset", async () => {
    const tool = createSandboxReadFileTool(port());
    const result = String(await tool.execute({ path: "/workspace/a.txt" }, ctx));
    expect(result).toContain("has_more: true");
    expect(result).toContain("next_offset: 10");
    expect(result).toContain("offset=");
    expect(result).toContain("first page");
  });

  it("read_file 尊重审批 guard", async () => {
    const tool = createSandboxReadFileTool(port(), async () => "需要人工审批");
    const result = await tool.execute({ path: "/workspace/a.txt" }, ctx);
    expect(result).toBe("需要人工审批");
  });

  it("write_file 返回写入字节数与路径", async () => {
    const tool = createSandboxWriteFileTool(port());
    const result = await tool.execute({ path: "/workspace/b.txt", content: "ok!" }, ctx);
    expect(result).toContain("已写入 3 bytes");
    expect(result).toContain("/workspace/b.txt");
  });
});
