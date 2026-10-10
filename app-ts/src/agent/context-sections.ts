import type { AgentContextSummary } from "../repository/agent-context.js";
import type { ConversationSummary } from "../repository/persistence.js";

/**
 * Standard context sections appended by the ReactAgent shell (sub-agents):
 * - own per-agent rolling summary (this agent's earlier runs)
 * - shared session-level summary (read-only background; pollution control:
 *   sub-agents never receive other agents' raw transcripts)
 * Pure function for testability.
 */
export function buildAgentContextSections(
  own?: AgentContextSummary,
  shared?: ConversationSummary,
): string {
  let out = "";
  if (own?.summary) {
    out += `\n\n## 本任务上下文（本 agent 更早轮次的摘要）\n${own.summary}\n（最近的自身历史以原始消息另行提供）`;
  }
  if (shared?.summary) {
    out += `\n\n## 共享上下文（会话级摘要，仅供参考的背景信息）\n${shared.summary}`;
  }
  return out;
}
