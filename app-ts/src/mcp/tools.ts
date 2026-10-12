import { defineTool, type ToolDefinition } from "../tools/base.js";
import type { ToolRegistry } from "../tools/registry.js";
import { createLogger } from "../logger.js";
import type { McpCallResult, McpClient, McpToolInfo, McpToolListCallResult } from "./client.js";

/**
 * Dynamic MCP tool bridge: the **server owns its tools** — name, description
 * and input schema come from `tools/list` and are bridged verbatim into the
 * agent tool layer as ToolDefinitions. The client never re-declares a server
 * tool; when the server adds one, it appears here after a restart (no live
 * `tools/list_changed` refresh in v1).
 *
 * What the bridge adds on top of a verbatim passthrough (all client-side
 * policy, none of it tool knowledge):
 *   - identity/cancellation: uid from ToolRunContext → X-Uid header; the
 *     runtime's budget signal aborts the in-flight request;
 *   - LLM-view size guard: oversized text results are excerpted with an
 *     explicit no-full-rewrite hint (mirrors the Python _llm_view red line);
 *   - error routing: transport failures throw (runtime breaker + metrics see
 *     them), server-side isError results stay text for the model to reason about.
 */

const log = createLogger("MCP");

const DEFAULT_MAX_CONTENT_CHARS = 8000;

/** The narrow client surface the bridge consumes (structurally: McpClient). */
export interface McpToolsClient {
  readonly name: string;
  listTools(opts?: { uid?: string; cursor?: string }): Promise<McpToolListCallResult>;
  callTool(name: string, args: Record<string, unknown>, opts?: { uid?: string; signal?: AbortSignal }): Promise<McpCallResult>;
}

export interface McpToolsOptions {
  maxContentChars?: number;
  /**
   * 服务模式网关要求每个请求带正整数 X-Uid（MCP server serve.go 校验，
   * uid<=0 拒绝）；boot 时 tools/list 无用户会话，用该占位 uid 过闸
   * （发现只返回工具元数据，不触达上游、不涉及用户数据）。
   * 真实工具调用仍按 ToolRunContext.uid 注入。
   */
  discoveryUid?: string;
}

/** tools/list → ToolDefinition[] (empty when discovery fails — degrade, don't crash boot). */
export async function createMcpTools(client: McpToolsClient, opts: McpToolsOptions = {}): Promise<ToolDefinition<Record<string, unknown>>[]> {
  const max = opts.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS;
  const listing = await client.listTools(opts.discoveryUid !== undefined ? { uid: opts.discoveryUid } : undefined);
  if (!listing.ok) {
    log.warn(`[MCP] ${client.name} tools/list failed: ${listing.error ?? "unknown"} — no MCP tools registered`);
    return [];
  }
  return listing.tools.map((t) => bridgeMcpTool(client, t, max));
}

/** createMcpTools + registration (duplicates are skipped with a warning, not fatal). */
export async function registerMcpTools(registry: ToolRegistry, client: McpToolsClient, opts: McpToolsOptions = {}): Promise<number> {
  const tools = await createMcpTools(client, opts);
  let registered = 0;
  for (const def of tools) {
    try {
      registry.register(def);
      registered += 1;
    } catch (err) {
      log.warn(`[MCP] ${client.name} skip tool=${def.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return registered;
}

function bridgeMcpTool(client: McpToolsClient, tool: McpToolInfo, maxContentChars: number): ToolDefinition<Record<string, unknown>> {
  return defineTool<Record<string, unknown>>({
    name: tool.name,
    description: tool.description ?? tool.title ?? `MCP tool ${tool.name}`,
    // server-owned JSON Schema, bridged verbatim (validated server-side; the
    // runtime injects the shared timeoutMs budget field at build time)
    inputSchema: (tool.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
    async execute(args, ctx, signal) {
      const res = await client.callTool(tool.name, args ?? {}, { uid: ctx.uid, signal });
      if (res.ok) {
        return truncateForLlm(res.content, maxContentChars);
      }
      if (res.errorKind === "tool") {
        // server-side business error (e.g. unknown uuid) — text the model can
        // reason about; deliberately NOT thrown, so it never trips the breaker
        return res.content || `MCP 工具返回错误：${res.error ?? "未知错误"}`;
      }
      // transport failure / timeout / cancel — throw so the runtime's breaker
      // and error metrics observe repeated infra failures
      throw new Error(res.error ?? "MCP 调用失败");
    },
  });
}

function truncateForLlm(content: string, max: number): string {
  if (!content) return "(无返回内容)";
  if (content.length <= max) return content;
  return (
    content.slice(0, max) +
    `\n…[内容过长已截断：共 ${content.length} 字符，仅展示前 ${max} 字。禁止据此做全量重写；如需其余部分请缩小范围或分段处理]`
  );
}
