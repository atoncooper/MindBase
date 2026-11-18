import { describe, expect, it } from "vitest";
import type { CodeArtifactPort, CodeFilePort } from "../src/tools/code/code-execution.js";
import { createSandboxImportCloudFilesTool } from "../src/tools/code/import-cloud.js";
import { createSandboxReadArtifactTool } from "../src/tools/code/artifacts.js";
import { createSandboxInfoTool } from "../src/tools/code/info.js";

const ctx = { uid: "7", academicProjectId: "p1", scope: { uploadUuids: ["u1"] }, collector: {} } as never;

function filePort(): CodeFilePort {
  return {
    async readFile() { throw new Error("unused"); },
    async writeFile(request) { return { path: request.path, bytes: 3 }; },
  };
}

describe("sandbox P3/P5 tools", () => {
  it("import_cloud_files 把云盘字节按 base64 写入沙箱", async () => {
    const writes: Array<{ path: string; encoding?: string }> = [];
    const tool = createSandboxImportCloudFilesTool(
      {
        async readFile() { throw new Error("unused"); },
        async writeFile(request) {
          writes.push({ path: request.path, ...(request.encoding ? { encoding: request.encoding } : {}) });
          return { path: request.path, bytes: 3 };
        },
      },
      {
        async downloadFile() {
          return { contentType: "text/csv", data: new Uint8Array([1, 2, 3]) };
        },
      },
    );
    const output = String(await tool.execute({}, ctx));
    expect(output).toContain("/workspace/analysis/data/u1.csv");
    expect(writes[0]?.encoding).toBe("base64");
  });

  it("read_artifact 返回 has_more/next_offset 与二进制标记", async () => {
    const port: CodeArtifactPort = {
      async readArtifact() {
        return {
          executionId: "exec-1",
          name: "r.csv",
          contentType: "text/csv",
          encoding: "utf8",
          binary: false,
          content: "page",
          offset: 0,
          bytes: 4,
          totalBytes: 20,
          hasMore: true,
          nextOffset: 4,
        };
      },
    };
    const tool = createSandboxReadArtifactTool(port);
    const output = String(await tool.execute({ execution_id: "exec-1", name: "r.csv" }, ctx));
    expect(output).toContain("has_more: true");
    expect(output).toContain("next_offset: 4");
    expect(output).toContain("encoding: utf8");
  });

  it("sandbox_info 暴露镜像/限制/网络", async () => {
    const tool = createSandboxInfoTool({
      async getInfo() {
        return {
          runtime: "opensandbox",
          image: "python:3.12-alpine",
          cpu: "250m",
          memory: "256Mi",
          networkDefaultAction: "allow",
          egressAllow: [],
          acceptedLanguages: ["python", "bash"],
          notes: ["bash may be absent"],
        };
      },
    });
    const output = String(await tool.execute({}, ctx));
    expect(output).toContain("image: python:3.12-alpine");
    expect(output).toContain("memory: 256Mi");
    expect(output).toContain("network_default_action: allow");
  });
});
