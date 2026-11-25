import { defineTool, type ToolDefinition } from "../base.js";
import type { UserMcpBridge } from "../../mcp/user-connections.js";
import { config } from "../../config/index.js";

const MAX_CONTENT = config.userMcp.maxContentChars;

/**
 * Generic per-user MCP call. The user's server/tool catalog is injected into
 * the main-agent prompt; this tool executes a call against that user's own
 * encrypted connection only. uid comes from ToolRunContext, never from args.
 */
export function createUserMcpCallTool(service: UserMcpBridge): ToolDefinition<Record<string, unknown>> {
  return defineTool<Record<string, unknown>>({
    name: "mcp_user_call",
    description:
      "调用当前用户自己配置的第三方 MCP server 工具。参数必须使用用户 MCP 目录中的 server 和 tool 名称。",
    inputSchema: {
      type: "object",
      properties: {
        server: { type: "string", description: "用户配置的 MCP server 名称" },
        tool: { type: "string", description: "MCP server 提供的工具名" },
        arguments: { type: "object", description: "传给 MCP 工具的参数对象" },
      },
      required: ["server", "tool"],
      additionalProperties: false,
    },
    async execute(args, ctx, signal) {
      const server = typeof args.server === "string" ? args.server.trim() : "";
      const tool = typeof args.tool === "string" ? args.tool.trim() : "";
      if (!server || !tool) throw new Error("mcp_user_call 需要 server 和 tool");
      const toolArgs = args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments)
        ? (args.arguments as Record<string, unknown>)
        : {};
      const res = await service.call(String(ctx.uid), server, tool, toolArgs, signal);
      if (res.ok) {
        const text = res.content || "(无返回内容)";
        return text.length <= MAX_CONTENT ? text : text.slice(0, MAX_CONTENT) + "\n…[MCP 返回过长，已截断]";
      }
      if (res.errorKind === "tool") return res.content || "MCP 工具返回错误：" + (res.error ?? "未知错误");
      throw new Error(res.error ?? "MCP 调用失败");
    },
  });
}
