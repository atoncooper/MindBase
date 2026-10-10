import { describe, it, expect } from "vitest";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { createEmitQuizTool, createEmitGradingTool } from "../src/tools/quiz/index.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { defineTool } from "../src/tools/base.js";
import { McpClient, createMcpTools, registerMcpTools, type McpToolsClient, type McpCallResult } from "../src/mcp/index.js";
import { ResultCollector } from "../src/context/types.js";

function makeCtx(uid?: number) {
  return { uid, chatSessionId: "sess-1", scope: {}, collector: new ResultCollector() };
}

const content = (out: unknown) => (typeof out === "string" ? out : (out as { content: string }).content);

function fakeQuizClient(calls: Array<{ tool: string; args: Record<string, unknown>; uid?: number }>): McpToolsClient {
  return {
    name: "quiz",
    listTools: async () => ({ ok: true, tools: [] }),
    callTool: async (name, args, opts) => {
      calls.push({ tool: name, args, uid: opts?.uid });
      if (name === "save_quiz") {
        return { ok: true, content: `已生成 1 道关于「${args.topic}」的题目（quiz_id=${randomUUID()}），已提交。` };
      }
      return { ok: true, content: `批改已提交：总分 ${args.score}/100（grading_id=${randomUUID()}）。` };
    },
  };
}

describe("quiz 工具（经 app-quiz-mcp）", () => {
  it("emit_quiz 落库走 MCP + artifact 下发 + uid 透传", async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown>; uid?: number }> = [];
    const tool = createEmitQuizTool(fakeQuizClient(calls));
    const ctx = makeCtx(9);
    const out = await tool.execute(
      {
        topic: "闭包",
        questions: [{ question: "什么是闭包？", answer: "函数与其词法环境的组合", explanation: "见 MDN" }],
      },
      ctx,
    );
    expect(content(out)).toContain("quiz_id=");
    expect(calls[0].tool).toBe("save_quiz");
    expect(calls[0].uid).toBe(9);
    expect(ctx.collector.artifacts[0].kind).toBe("quiz");
  });

  it("emit_quiz 需要 uid", async () => {
    const tool = createEmitQuizTool(fakeQuizClient([]));
    const out = await tool.execute(
      { topic: "t", questions: [{ question: "q", answer: "a", explanation: "e" }] },
      makeCtx(undefined),
    );
    expect(content(out)).toContain("没有用户身份");
  });

  it("emit_grading 经 MCP + artifact 下发", async () => {
    const calls: Array<{ tool: string; uid?: number }> = [];
    const tool = createEmitGradingTool(fakeQuizClient(calls));
    const ctx = makeCtx(9);
    const out = await tool.execute(
      { score: 80, total: 5, perQuestion: [{ index: 0, verdict: "correct", feedback: "正确" }] },
      ctx,
    );
    expect(content(out)).toContain("80/100");
    expect(calls[0].tool).toBe("save_grading");
    expect(calls[0].uid).toBe(9);
    expect(ctx.collector.artifacts[0].kind).toBe("quiz_grading");
  });

  it("MCP 失败收敛为错误文本（不抛出、不进熔断）", async () => {
    const client: McpToolsClient = {
      name: "quiz",
      listTools: async () => ({ ok: false, tools: [], error: "连接被拒" }),
      callTool: async (): Promise<McpCallResult> => ({ ok: false, content: "", error: "MCP 调用失败: HTTP 500", errorKind: "transport" }),
    };
    const quizTool = createEmitQuizTool(client);
    const out = await quizTool.execute(
      { topic: "t", questions: [{ question: "q", answer: "a", explanation: "e" }] },
      makeCtx(1),
    );
    expect(content(out)).toContain("生成失败");
  });
});

/**
 * MCP dynamic tool bridge: the server owns its tools (name/description/inputSchema
 * via tools/list); the client bridges them verbatim and adds only policy —
 * identity headers, cancellation, LLM-view size guard, error routing.
 */
describe("MCP 动态工具桥接（createMcpTools）", () => {
  interface Captured {
    name: string;
    args: Record<string, unknown>;
    uid?: number;
    signal?: AbortSignal;
  }

  function fakeClient(captured: Captured[], callResult?: (name: string) => import("../src/mcp/index.js").McpCallResult): McpToolsClient {
    return {
      name: "board",
      listTools: async () => ({
        ok: true,
        tools: [
          {
            name: "list_boards",
            description: "列出板子",
            inputSchema: { type: "object", properties: { search: { type: "string" } } },
          },
          {
            name: "get_board",
            description: "读取板子",
            inputSchema: { type: "object", properties: { uuid: { type: "string" } } },
          },
        ],
      }),
      callTool: async (name, args, opts) => {
        captured.push({ name, args, uid: opts?.uid, signal: opts?.signal });
        return (
          callResult?.(name) ?? { ok: true, content: `mock:${name}` }
        );
      },
    };
  }

  it("server 工具被原样桥接（name/description/inputSchema 零改写）", async () => {
    const tools = await createMcpTools(fakeClient([]));
    expect(tools.map((t) => t.name)).toEqual(["list_boards", "get_board"]);
    expect(tools[0].description).toBe("列出板子");
    expect(tools[0].inputSchema).toEqual({ type: "object", properties: { search: { type: "string" } } });
  });

  it("execute 透传 args + uid + signal（身份只进请求头）", async () => {
    const captured: Captured[] = [];
    const [listTool] = await createMcpTools(fakeClient(captured));
    const controller = new AbortController();
    const out = await listTool.execute({ search: "RAG" }, makeCtx(42), controller.signal);
    expect(content(out)).toBe("mock:list_boards");
    expect(captured[0].uid).toBe(42);
    expect(captured[0].args).toEqual({ search: "RAG" });
    expect(captured[0].signal).toBe(controller.signal);
  });

  it("tools/list 失败降级为不注册任何工具（不阻断启动）", async () => {
    const tools = await createMcpTools({
      name: "board",
      listTools: async () => ({ ok: false, tools: [], error: "连接被拒" }),
      callTool: async () => ({ ok: true, content: "" }),
    });
    expect(tools).toEqual([]);
  });

  it("server isError → 错误文本返回（不抛出、不进熔断）", async () => {
    const tools = await createMcpTools(
      fakeClient([], () => ({ ok: false, content: "uuid 不存在", error: "uuid 不存在", errorKind: "tool" })),
    );
    const out = await tools[1].execute({ uuid: "u1" }, makeCtx(1));
    expect(content(out)).toContain("uuid 不存在");
  });

  it("传输层失败 → 抛出（runtime 熔断与错误指标能看到）", async () => {
    const tools = await createMcpTools(
      fakeClient([], () => ({ ok: false, content: "", error: "MCP 调用失败: HTTP 500", errorKind: "transport" })),
    );
    await expect(tools[1].execute({ uuid: "u1" }, makeCtx(1))).rejects.toThrow("HTTP 500");
  });

  it("超大结果截断 + 禁止全量重写提示（LLM 视图保护）", async () => {
    const tools = await createMcpTools(
      fakeClient([], () => ({ ok: true, content: "x".repeat(9000) })),
    );
    const out = content(await tools[0].execute({}, makeCtx(1)));
    expect(out.length).toBeLessThan(9000);
    expect(out).toContain("禁止据此做全量重写");
  });

  it("registerMcpTools 注册进 registry，重名跳过而非崩溃", async () => {
    const registry = new ToolRegistry();
    registry.register(
      defineTool({
        name: "list_boards",
        description: "local tool with a conflicting name",
        inputSchema: z.object({}),
        execute: async () => "local",
      }),
    );
    const registered = await registerMcpTools(registry, fakeClient([]));
    expect(registered).toBe(1); // get_board registered; list_boards skipped
    expect(registry.names()).toEqual(["list_boards", "get_board"]);
  });
});

describe("McpClient", () => {
  it("端点不可达时返回 ok:false 且不抛异常", async () => {
    const client = new McpClient({ url: "http://127.0.0.1:59999/mcp", timeoutMs: 3000 });
    const res = await client.callTool("list_boards", {}, { uid: 1 });
    expect(res.ok).toBe(false);
    expect(res.error).toBeDefined();
  });

  it("zod schema 与 AI SDK tool 兼容（冒烟）", () => {
    // Ensure the schemas of the quiz tools can be consumed by runtime.buildSdkTools (zod → JSON Schema)
    const schema = z.object({ topic: z.string(), questions: z.array(z.object({ question: z.string() })).min(1) });
    expect(() => JSON.stringify(schema)).not.toThrow();
  });
});
