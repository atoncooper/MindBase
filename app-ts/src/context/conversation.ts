import type { ConversationSummary } from "../repository/persistence.js";

/**
 * Conversation-context recall belongs to the context layer (same philosophy as memory
 * and session docs): the rolling compressed summary of older turns is injected into the
 * system prompt, while the recent window is provided as raw history messages.
 */
export async function buildConversationSection(
  getSummary: (sessionId: string) => Promise<ConversationSummary | undefined>,
  sessionId: string | undefined,
): Promise<string> {
  if (!sessionId) return "";
  const s = await getSummary(sessionId).catch(() => undefined);
  if (!s?.summary) return "";
  return [
    ``,
    `## 对话上下文（更早轮次的摘要）`,
    s.summary,
    `（最近几轮对话以原始消息另行提供）`,
  ].join("\n");
}
