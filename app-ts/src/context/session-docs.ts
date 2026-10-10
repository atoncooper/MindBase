import type { SessionDocumentRepository } from "../repository/session-docs.js";

/**
 * Session-document recall belongs to the context layer (same philosophy as memory):
 * each turn injects the doc list + query-relevant excerpts into the system prompt.
 * No agent tool is involved — retrieval is deterministic context assembly.
 */
export async function buildSessionDocSection(
  port: SessionDocumentRepository,
  sessionId: string | undefined,
  query: string,
): Promise<string> {
  if (!sessionId) return "";
  const docs = await port.list(sessionId).catch(() => []);
  if (docs.length === 0) return "";

  const docLines = docs.map((d) => `- ${d.filename}（${d.chunkCount} 片段）`).join("\n");
  const hits = await port.search(sessionId, query, 4).catch(() => []);
  let excerptLines = "";
  if (hits.length > 0) {
    const excerpts = hits
      .map((h) => `【${h.filename}】${h.text.slice(0, 600)}`)
      .join("\n---\n");
    excerptLines = `\n\n### 与当前问题相关的片段\n${excerpts}`;
  }

  return [
    ``,
    `## 会话文档`,
    `用户在本会话中上传了以下文档，回答相关问题时必须以下述内容为依据（仅对本会话可见）：`,
    docLines,
    excerptLines,
  ].join("\n");
}
