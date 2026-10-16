/**
 * Agent roster — the SINGLE SOURCE OF TRUTH for agent names + descriptions.
 *
 * The delegate_to_agent tool list (bootstrap/container.ts) and each agent
 * factory's self-description (agent/<name>/agent.ts) describe the same agents;
 * both now read from here so the two views cannot drift apart. The
 * descriptions travel into the main agent's LLM context (tool list / routing),
 * i.e. they are prompt-adjacent data — never scatter copies in wiring code.
 */
export interface AgentManifestEntry {
  name: string;
  /** description seen by the orchestrator / main agent's delegate tool list */
  description: string;
  /** true = sub-agent (reached via delegate_to_agent, not a routing target) */
  subAgent: boolean;
}

export const MAIN_AGENT: AgentManifestEntry = {
  name: "main",
  description: "默认知识库问答 agent：向量检索 + 工具调用来回答用户关于收藏视频/云盘文档的问题。",
  subAgent: false,
};

export const SUB_AGENTS: AgentManifestEntry[] = [
  { name: "note", description: "笔记整理 agent：把对话/给定内容整理成结构化 markdown 笔记并保存到用户笔记库。", subAgent: true },
  { name: "code", description: "编程 agent：编写代码解决任务，沙箱可用时运行验证；也做代码解释与调试。", subAgent: true },
  { name: "quiz", description: "出题与批改 agent：可自主规划并调用工具——联网搜索考试大纲/规范、检索用户知识库收集素材，然后按主题/大纲出题（含答案解析与来源），或批改作答评分。", subAgent: true },
  { name: "board", description: "板子操作 agent：创建/查询/更新用户的思维导图与白板（经 MCP 操作 app-board）。", subAgent: true },
];

export const AGENT_MANIFEST: AgentManifestEntry[] = [MAIN_AGENT, ...SUB_AGENTS];

/** Description lookup for agent factories; throws on unknown names (fail fast on drift). */
export function agentEntry(name: string): AgentManifestEntry {
  const entry = AGENT_MANIFEST.find((a) => a.name === name);
  if (!entry) {
    throw new Error(`[MANIFEST] unknown agent "${name}" (have: ${AGENT_MANIFEST.map((a) => a.name).join(", ")})`);
  }
  return entry;
}
