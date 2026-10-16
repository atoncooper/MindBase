import { createReactAgent } from "../react.js";
import { agentEntry } from "../manifest.js";
import type { AgentRuntime } from "../../tools/runtime.js";
import type { PromptRegistry } from "../prompts/loader.js";
import { buildMemorySection } from "../../context/memory.js";
import { buildSessionDocSection } from "../../context/session-docs.js";
import { buildConversationSection } from "../../context/conversation.js";
import type { MemoryRepository } from "../../repository/memory-store.js";
import type { SessionDocumentRepository } from "../../repository/session-docs.js";
import type { ConversationSummary } from "../../repository/persistence.js";
import type { SearchScope } from "../../context/types.js";
import type { AgentInvokeInput } from "../types.js";
import { today } from "../../utils/datetime.js";

/** Scope description for the prompt's "current state" section. */
function buildScopeLine(scope: SearchScope): string {
  const parts: string[] = [];
  if (scope.bvids && scope.bvids.length > 0) {
    parts.push(`限定视频范围：${scope.bvids.length} 个（已自动应用，无需重复检索）`);
  }
  if (scope.uploadUuids && scope.uploadUuids.length > 0) {
    parts.push(`限定云盘文档范围：${scope.uploadUuids.length} 个`);
  }
  if (scope.mediaIds && scope.mediaIds.length > 0) {
    parts.push(`限定视频分P范围：${scope.mediaIds.length} 个`);
  }
  return parts.length > 0 ? parts.join("；") : "检索范围：全部知识库";
}

/**
 * Main agent: knowledge-base Q&A (the only orchestrator route target).
 * The loop is handled by the generic ReactAgent factory; tools = RAG retrieval + video browsing + save_memory.
 * System prompt lives in prompts/main.md (loaded into memory at startup);
 * memory recall and session-document recall are context-layer injection, not agents.
 */
export function createMainAgent(
  runtime: AgentRuntime,
  hasKnowledgeData: () => Promise<boolean>,
  memoryStore: MemoryRepository | undefined,
  prompts: PromptRegistry,
  sessionDocs?: SessionDocumentRepository,
  getSummary?: (sessionId: string) => Promise<ConversationSummary | undefined>,
  includeKgTool = false,
  /** skills facade (index/forced injection); absent = no SKILLS_SECTION */
  skills?: { indexSection: (uid: string) => Promise<string>; forcedSection: (uid: string, ids: string[]) => Promise<string> },
) {
  return createReactAgent({
    name: "main",
    description: agentEntry("main").description,
    runtime,
    toolNames: [
      "vector_search",
      "list_videos",
      "get_video_summaries",
      "save_memory",
      "delegate_to_agent",
      "ask_user",
      "fetch_webpage",
      "web_search",
      ...(includeKgTool ? ["kg_search"] : []),
    ],
    purpose: "chat",
    async buildSystemPrompt(input: AgentInvokeInput) {
      const hasData = await hasKnowledgeData().catch(() => false);
      const memorySection = memoryStore
        ? await buildMemorySection(memoryStore, input.uid, input.query)
        : "";
      const sessionDocsSection = sessionDocs
        ? await buildSessionDocSection(sessionDocs, input.chatSessionId, input.query)
        : "";
      const conversationSection = getSummary
        ? await buildConversationSection(getSummary, input.chatSessionId)
        : "";
      let skillsSection = "";
      if (skills && input.uid !== undefined) {
        skillsSection = input.skillIds?.length
          ? await skills.forcedSection(input.uid, input.skillIds)
          : await skills.indexSection(input.uid);
      }
      const base = prompts.render("agents/main", {
        TODAY: today(), // local date in the configured timezone (UTC would be wrong 00:00–08:00 CST)
        KNOWLEDGE_STATUS: hasData ? "可用" : "暂无数据（如用户问知识库内容，请如实说明）",
        SCOPE_LINE: buildScopeLine(input.scope),
        CONVERSATION_SECTION: conversationSection,
        SESSION_DOCS_SECTION: sessionDocsSection,
        MEMORY_SECTION: memorySection,
        KG_SEARCH_SECTION: includeKgTool ? KG_SEARCH_SECTION : "",
        SKILLS_SECTION: skillsSection,
      });
      // client-supplied system directives (OpenAI-compat endpoint) ride below our own prompt
      return input.extraSystem ? `${base}\n\n# 用户附加指令\n${input.extraSystem}` : base;
    },
  });
}

/** Prompt section teaching the kg_search tool usage — injected only when the
 * KG capability is wired (mirrors the Python prompt's conditional branch). */
export const KG_SEARCH_SECTION =
  '- **kg_search**：涉及实体关系、知识点关联的问题（"A 和 B 有什么关系/对比""X 这个概念在哪些视频里被讲到过"）优先调用；返回实体卡片（描述/关系/原文出处），可与 vector_search 互补使用。';
