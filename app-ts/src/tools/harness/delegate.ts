import { z } from "zod";
import { defineTool } from "../base.js";
import type { AgentLifecycleManager } from "../../agent/lifecycle.js";
import type { SearchScope } from "../../context/types.js";

/**
 * delegate_to_agent: delegates to sub-agents within the main agent session (mirrors Python tools/harness/delegate.py).
 * Goes through lifecycle.invokeReentrant (does not take the session lock, avoiding re-entrant deadlock); the result collapses into text back to the LLM,
 * and the sub-agent's sources are merged via ctx.collector into the main session's SSE sources frame.
 * The list of delegatable agents is declared in the description (mirrors Python's agent description injection).
 */
export function createDelegateTool(lifecycle: AgentLifecycleManager, delegates: { name: string; description: string }[]) {
  const roster = delegates.map((d) => `- ${d.name}: ${d.description}`).join("\n");
  return defineTool({
    name: "delegate_to_agent",
    description:
      "把任务委托给专职子 agent 处理，返回其最终回答。可用子 agent：\n" +
      roster +
      "\n仅当任务明确属于上述子 agent 的职责时调用。",
    inputSchema: z.object({
      agent: z.string().min(1).describe("目标子 agent 名"),
      message: z.string().min(1).describe("传给子 agent 的完整任务描述/问题"),
    }),
    async execute(args, ctx) {
      if (!lifecycle.has(args.agent)) {
        return `委托失败：子 agent "${args.agent}" 不存在。可用：${delegates.map((d) => d.name).join(", ")}`;
      }
      // short-circuit (mirrors Python delegate_failures): after 2 failures of the same
      // sub-agent within one turn, refuse further delegation to stop token burn loops
      let failures = delegateFailures.get(ctx.collector);
      if (!failures) {
        failures = new Map<string, number>();
        delegateFailures.set(ctx.collector, failures);
      }
      if ((failures.get(args.agent) ?? 0) >= 2) {
        return `子 agent "${args.agent}" 本轮已连续失败 2 次，已停止委托。请基于已有信息直接回答，或告知用户该功能暂不可用。`;
      }
      const result = await lifecycle.invokeReentrant(args.agent, ctx.chatSessionId ?? "anonymous", {
        query: args.message,
        uid: ctx.uid,
        chatSessionId: ctx.chatSessionId,
        scope: delegateScopeFor(ctx.scope),
        history: [],
      });
      if (result.failed) {
        failures.set(args.agent, (failures.get(args.agent) ?? 0) + 1);
      } else {
        failures.delete(args.agent);
      }
      // 子 agent 的 sources 汇入主会话（委托失败时打标，供上层短路计数扩展）
      if (result.sources.length > 0) {
        ctx.collector.pushSources(result.sources);
      }
      const prefix = result.failed ? "[委托失败] " : "";
      return `${prefix}${truncate(result.content)}`;
    },
  });
}

/** per-turn failure ledger; the ResultCollector identifies the turn */
const delegateFailures = new WeakMap<object, Map<string, number>>();

/**
 * Pollution control on the return path: a sub-agent's long artifact (full note text,
 * full code listing) must not flood the main agent's context — it flows back truncated;
 * durable output is persisted by the sub-agent itself (notes/quiz artifacts).
 */
const MAX_DELEGATE_RETURN = 6000;

function truncate(content: string): string {
  if (content.length <= MAX_DELEGATE_RETURN) return content;
  return `${content.slice(0, MAX_DELEGATE_RETURN)}\n…（结果过长已截断；完整产物已由子 agent 保存，可继续委托查询细节）`;
}

/** Sub-agents do not inherit the RAG retrieval scope (memory and other sub-agents are unrelated to the knowledge-base scope) */
function delegateScopeFor(scope: SearchScope): SearchScope {
  return {};
}
