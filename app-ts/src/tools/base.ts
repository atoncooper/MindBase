import type { z } from "zod";
import type { ToolRunContext } from "../context/types.js";

/**
 * Tool protocol (mirrors Python BaseTool): a 4-member interface, framework-agnostic.
 * inputSchema is defined with zod and converted into an AI SDK tool by the Registry.
 */
export interface ToolOutput {
  /** Text result shown to the LLM */
  content: string;
  /** extras: sent down with SSE step frames and summarized into the sources frame at the stream tail */
  sources?: import("../context/types.js").Source[];
  artifacts?: import("../context/types.js").Artifact[];
}

export interface ToolDefinition<TInput = unknown> {
  name: string;
  description: string;
  /**
   * Two schema flavors:
   *  - zod schema: local tools in `src/tools/` (converted to JSON Schema by buildSdkTools)
   *  - raw JSON Schema object: MCP-provided tools (`src/mcp/tools.ts` bridges the
   *    server-owned schema verbatim — the client never re-declares server tools)
   * Both get the model-controlled `timeoutMs` budget field injected at build time.
   */
  inputSchema: z.ZodType<TInput> | Record<string, unknown>;
  /**
   * signal: per-call cancellation from the TimeoutManager — signal-aware tools
   * (fetch/MCP/sandbox) should forward it; optional extra param, existing 2-arg
   * implementations stay assignable.
   */
  execute(args: TInput, ctx: ToolRunContext, signal?: AbortSignal): Promise<ToolOutput | string>;
}

export function defineTool<TInput>(def: ToolDefinition<TInput>): ToolDefinition<TInput> {
  return def;
}

/** Convenience wrapper for tool implementations that return a string */
export async function asOutput(result: ToolOutput | string): Promise<ToolOutput> {
  return typeof result === "string" ? { content: result } : result;
}
