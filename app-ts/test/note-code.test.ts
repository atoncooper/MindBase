import { describe, it, expect } from "vitest";
import type { McpToolsClient } from "../src/mcp/index.js";
import { NoopCodeExecution } from "../src/tools/code/code-execution.js";
import { createSaveNoteTool } from "../src/tools/note/index.js";
import { createRunCodeTool } from "../src/tools/code/index.js";
import { ResultCollector } from "../src/context/types.js";

function makeCtx(uid?: number) {
  return { uid, chatSessionId: "sess-1", scope: {}, collector: new ResultCollector() };
}

const content = (out: unknown) => (typeof out === "string" ? out : (out as { content: string }).content);

/** Fake MCP client capturing save_note calls (note persistence goes through app-note-mcp). */
function fakeNoteClient(captured: Array<{ args: Record<string, unknown>; uid?: number }>): McpToolsClient {
  return {
    name: "note",
    listTools: async () => ({ ok: true, tools: [] }),
    callTool: async (name, args, opts) => {
      captured.push({ args, uid: opts?.uid });
      return { ok: true, content: "已保存笔记《测试标题》（uuid=note-uuid-1）" };
    },
  };
}

describe("save_note tool（经 app-note-mcp）", () => {
  it("需要 uid", async () => {
    const tool = createSaveNoteTool(fakeNoteClient([]));
    const out = await tool.execute({ title: "t", content: "c" }, makeCtx(undefined));
    expect(content(out)).toContain("没有用户身份");
  });

  it("落库走 MCP：conversation 类型 + 会话 id + uid 透传，返回标题", async () => {
    const captured: Array<{ args: Record<string, unknown>; uid?: number }> = [];
    const tool = createSaveNoteTool(fakeNoteClient(captured));
    const out = await tool.execute({ title: "TypeScript 泛型", content: "# 泛型\n……" }, makeCtx(7));
    expect(content(out)).toContain("uuid=note-uuid-1"); // MCP 结果透传
    expect(content(out)).toContain("7 字符");
    expect(captured[0].uid).toBe(7);
    expect(captured[0].args).toMatchObject({
      title: "TypeScript 泛型",
      target_type: "conversation",
      target_id: "sess-1",
      content_md: "# 泛型\n……",
    });
  });

  it("MCP 失败收敛为错误文本", async () => {
    const client: McpToolsClient = {
      name: "note",
      listTools: async () => ({ ok: false, tools: [], error: "连接被拒" }),
      callTool: async () => ({ ok: false, content: "", error: "保存失败：笔记服务暂不可用，请稍后重试", errorKind: "transport" }),
    };
    const tool = createSaveNoteTool(client);
    const out = await tool.execute({ title: "t", content: "c" }, makeCtx(1));
    expect(content(out)).toContain("保存失败");
  });
});

describe("run_code tool", () => {
  it("沙箱未配置时如实说明", async () => {
    const tool = createRunCodeTool(new NoopCodeExecution());
    const out = await tool.execute({ language: "python", code: "print(1)" }, makeCtx(1));
    expect(content(out)).toContain("沙箱未配置");
    expect(content(out)).toContain("未经实际运行验证");
  });

  it("沙箱可用时回传执行输出", async () => {
    const tool = createRunCodeTool({
      async run() {
        return { ok: true, stdout: "hello\n", stderr: "", sandboxAvailable: true };
      },
    });
    const out = await tool.execute({ language: "python", code: "print('hello')" }, makeCtx(1));
    expect(content(out)).toContain("exit: ok");
    expect(content(out)).toContain("hello");
  });
});
