//! Agent descriptors and prompts — desktop port of
//! app/agent/{chat,memory,note,code,search}.
//!
//! All five share one ReAct engine (harness::react_loop); each contributes a
//! system prompt, a tool subset and its own step budget. task_quiz is
//! intentionally absent (server scheduler); code runs in generate-only mode
//! (no cloud sandbox on a fully-local desktop).

/// One retrieval-window entry of the memory agent (backend shape).
/// Serialized into `memory_windows` (Phase 1: the window survives restarts).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub(crate) struct SearchWindowEntry {
    pub query: String,
    /// First 300 chars of the result text (backend preview cap).
    pub result_preview: String,
    pub tools_used: Vec<String>,
    /// HH:MM stamp rendered into prompt windows.
    pub timestamp: String,
}

const PREVIEW_CAP: usize = 300;

/// Which registered agent a ReAct run executes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AgentKind {
    Chat,
    Memory,
    Note,
    /// 代码助手：只生成代码与讲解，不执行（桌面端无沙箱）。
    Code,
    /// 文档搜索：Context7 优先、网页抓取兜底（可选联网增强）。
    Search,
    /// 学术研究：论文的写作 / 审查 / 修改 / 精读理解。
    Academic,
}

impl AgentKind {
    pub(crate) fn name(&self) -> &'static str {
        match self {
            AgentKind::Chat => "chat",
            AgentKind::Memory => "memory",
            AgentKind::Note => "note",
            AgentKind::Code => "code",
            AgentKind::Search => "search",
            AgentKind::Academic => "academic",
        }
    }

    pub(crate) fn max_steps(&self) -> usize {
        match self {
            // Backend allows 10; desktop stops at 8 to bound cost while
            // still leaving room for multi-angle re-search rounds.
            AgentKind::Chat | AgentKind::Memory => 8,
            AgentKind::Note => 5,
            // Search may need resolve + fetch + fallback crawl rounds.
            AgentKind::Search => 6,
            // Code is a single-shot writing task in generate-only mode.
            AgentKind::Code => 4,
            // 论文写作/修改分节交付，需要多轮 write_file。
            AgentKind::Academic => 12,
        }
    }

    /// Registry tool names bound by this agent (backend list_tool_defs subset).
    pub(crate) fn tools(&self) -> &'static [&'static str] {
        match self {
            AgentKind::Chat => &[
                "vector_search",
                "list_documents",
                "search_chat_history",
                "get_recent_context",
                "get_full_history",
                "get_compressed_summary",
                "get_session_findings",
                "plan",
                "delegate_to_agent",
                "load_skill",
                "load_prompt",
                "list_history",
                "read_turn",
                "list_errors",
                "read_error",
                "search_content",
                "memory_write",
                "memory_search",
                "generate_resume",
                "generate_slides",
                "read_file",
                "write_file",
                "list_dir",
            ],
            // Memory binds everything (backend behavior) minus delegation.
            AgentKind::Memory => &[
                "vector_search",
                "list_documents",
                "search_chat_history",
                "get_recent_context",
                "get_full_history",
                "get_compressed_summary",
                "get_session_findings",
                "list_history",
                "read_turn",
                "search_content",
                "memory_write",
                "memory_search",
            ],
            AgentKind::Note => &[
                "save_note",
                "list_notes",
                "get_note",
                "update_note",
                "vector_search",
                "get_session_findings",
                "memory_search",
                "plan",
            ],
            AgentKind::Code => &[
                "vector_search",
                "search_chat_history",
                "get_session_findings",
                "list_errors",
                "read_error",
                "memory_search",
                "plan",
                "write_file",
                "list_dir",
            ],
            AgentKind::Search => &["search_docs", "web_crawl"],
            AgentKind::Academic => &[
                "vector_search",
                "search_chat_history",
                "read_file",
                "write_file",
                "list_dir",
                "load_prompt",
                "memory_search",
                "memory_write",
                "get_session_findings",
                "plan",
            ],
        }
    }

    /// Orchestrator descriptions — chat's is verbatim from the backend;
    /// the rest mirror theirs (sub-agents, not routable today).
    pub(crate) fn description(&self) -> String {
        match self {
            AgentKind::Chat => "收藏夹知识库助手。使用ReAct模式回答用户关于B站视频内容和云盘文档的问题。支持向量检索、视频列表、视频总结等工具。适用于绝大多数用户问答场景。".to_string(),
            AgentKind::Memory => "记忆检索助手。检索历史对话、压缩摘要与完整上下文，回答关于过往对话的问题。".to_string(),
            AgentKind::Note => "笔记助手。创建、查询、分析用户的本地笔记，可先做向量检索再落笔。".to_string(),
            AgentKind::Code => "代码助手。编写完整可运行的代码并附讲解（桌面端不执行代码）。".to_string(),
            AgentKind::Search => "文档搜索助手。检索技术库/框架的官方文档并整理返回。".to_string(),
            AgentKind::Academic => "学术研究助手。论文的写作、审查、修改与精读理解，遵循学术规范与引用纪律。".to_string(),
        }
    }
}

/// Render the memory agent's search window newest-first (backend format).
pub(crate) fn format_search_window(entries: &[SearchWindowEntry]) -> String {
    if entries.is_empty() {
        return "（暂无检索历史）".to_string();
    }
    let mut lines = Vec::new();
    for (index, entry) in entries.iter().enumerate().rev() {
        lines.push(format!(
            "{}. [{}] {} → {}（工具：{}）",
            index + 1,
            entry.timestamp,
            entry.query,
            truncate(&entry.result_preview, 200),
            entry.tools_used.join(",")
        ));
    }
    lines.join("\n")
}

fn truncate(text: &str, cap: usize) -> String {
    if text.chars().count() <= cap {
        text.to_string()
    } else {
        let cut: String = text.chars().take(cap).collect();
        format!("{cut}…")
    }
}

pub(crate) fn make_window_entry(
    query: &str,
    result_text: &str,
    tools_used: Vec<String>,
) -> SearchWindowEntry {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let total_minutes = now.as_secs() / 60;
    let hh = (total_minutes / 60) % 24;
    let mm = total_minutes % 60;
    // UTC wall clock suffices for prompt stamps (backend uses local HH:MM).
    SearchWindowEntry {
        query: query.to_string(),
        result_preview: truncate(result_text, PREVIEW_CAP),
        tools_used,
        timestamp: format!("{hh:02}:{mm:02}"),
    }
}

/// chat 系统提示词组装。`base_md` 是**必载核心**（来自
/// `<data>/prompts/chat/base.md`，含角色/工作方式/检索策略/回答规范/澄清协议/
/// 约束/引用规则，用户可编辑）；本函数只追加**依赖本轮状态的程序化区块**：
/// 工具指南按 `tool_names`（`AgentKind::tools()`）绑定情况按需生成，
/// `skills_text` 为空时不附加技能节，`prompts_index` 为空时不附加
/// 可加载提示词节（模型经 load_prompt 工具自主加载）。
pub(crate) fn chat_system_prompt(
    base_md: &str,
    skills_text: &str,
    prompts_index: &str,
    tool_names: &[&str],
) -> String {
    let has = |name: &str| tool_names.contains(&name);
    let mut prompt = String::from(base_md.trim());
    prompt.push_str("\n\n## 工具使用指南\n");
    if has("vector_search") {
        prompt.push_str(
            "- vector_search：需要具体内容支撑的深度问题（某个观点/细节讲过什么）；\
             生成简历/PPT 前也用它检索素材，让内容有据可依\n",
        );
    }
    if has("list_documents") {
        prompt.push_str("- list_documents：用户询问库里有哪些视频、入库情况等概览类问题\n");
    }
    if has("get_recent_context") || has("get_full_history") || has("get_compressed_summary") {
        prompt.push_str(
            "- get_recent_context / get_full_history / get_compressed_summary：用户引用对话上下文时优先自查\n",
        );
    }
    if has("delegate_to_agent") {
        prompt.push_str(
            "- delegate_to_agent：把独立子任务交给专职代理。target=memory 检索过往对话细节；\
             target=note 创建或修改笔记；target=code 编写代码（仅生成不执行）；\
             target=search 查技术库/框架官方文档；target=academic 论文的写作/审查/修改/理解。委托时用一句清晰的自包含 query 描述任务。\
             何时联网委托见「可加载提示词」清单。\
             委托返回以【转澄清】开头时：子代理信息不足——\
             按澄清协议向用户转述该问题，用户回答后把原任务与其回答合并重新委托\n",
        );
    }
    if has("load_prompt") {
        prompt.push_str(
            "- load_prompt：按需载入一份本 agent 的专用指令全文（可用的清单见「可加载提示词」一节）\n",
        );
    }
    if has("generate_resume") {
        prompt.push_str(
            "- generate_resume：用户想生成简历/求职材料时调用。把全部历史对话提炼成 Markdown 简历并保存为文件。\n",
        );
    }
    if has("generate_slides") {
        prompt.push_str(
            "- generate_slides：用户想做 PPT/演示文稿/汇报材料时调用。按主题生成 .pptx 文件\
             （含每页要点与讲者备注，默认结合知识库素材）。\n",
        );
    }
    prompt.push('\n');
    if !skills_text.is_empty() {
        prompt.push_str("## 可用技能（Skills）\n");
        prompt.push_str(skills_text);
        prompt.push_str(
            "\n\n## 技能使用规则（重要）\n\
             任务与某条技能的描述相关时，**必须先用 load_skill 加载该技能**并遵循其指令，\
             不要凭通用做法草草完成；多个技能相关时全部加载后再动手。\n\n",
        );
    }
    if !prompts_index.is_empty() {
        prompt.push_str("## 可加载提示词\n");
        prompt.push_str(prompts_index);
        prompt.push('\n');
    }
    prompt
}

/// memory 系统提示词：`base_md`（`<data>/prompts/memory/base.md`，人设与
/// 可用存储）+ 动态检索窗口 + 调用方 footer（这两块每轮变化，保持程序化）。
pub(crate) fn memory_system_prompt(
    base_md: &str,
    search_window_text: &str,
    target_agent: &str,
    query: &str,
) -> String {
    format!(
        "{base}\n\n\
         ## 检索历史窗口（本会话内你自己之前的检索记录，最新在前）\n\
         {search_window_text}\n\n\
         若窗口中已有足够信息，直接引用作答，不必重复调用工具。\n\n\
         调用方 agent：{target_agent}。原始请求：{query}",
        base = base_md.trim()
    )
}

/// note 系统提示词：base（工作铁律）+ 当前请求 footer。
pub(crate) fn note_system_prompt(base_md: &str, query: &str) -> String {
    format!("{base}\n\n## 当前请求\n{query}", base = base_md.trim())
}

/// code 系统提示词：base（generate-only 人设与诚实约束）+ 当前请求 footer。
pub(crate) fn code_system_prompt(base_md: &str, query: &str) -> String {
    format!("{base}\n\n## 当前请求\n{query}", base = base_md.trim())
}

/// academic 系统提示词：base（学者人设与诚信红线）+ 当前请求 footer。
/// 四种工作模式（写/审/改/读）经 load_prompt 加载对应模式提示词。
pub(crate) fn academic_system_prompt(base_md: &str, question: &str) -> String {
    format!(
        "{base}

## 当前请求
{question}",
        base = base_md.trim()
    )
}

/// search 系统提示词：base（Context7 优先 + 防注入铁律）+ 当前请求 footer。
pub(crate) fn search_system_prompt(base_md: &str, query: &str) -> String {
    format!("{base}\n\n## 当前请求\n{query}", base = base_md.trim())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_window_formats_newest_first_with_caps() {
        let entries = vec![
            make_window_entry("第一问", "第一份结果", vec!["vector_search".into()]),
            make_window_entry("第二问", &"长".repeat(400), vec!["get_full_history".into()]),
        ];
        let text = format_search_window(&entries);
        assert!(text.starts_with("2. "), "newest entry renders first");
        assert!(text.contains("第一问"));
        assert!(text.contains("…"), "long previews clamp");
        assert_eq!(format_search_window(&[]), "（暂无检索历史）");
    }

    #[test]
    fn agent_kinds_carry_distinct_budgets_and_tools() {
        assert_eq!(AgentKind::Chat.max_steps(), 8);
        assert_eq!(AgentKind::Note.max_steps(), 5);
        assert!(AgentKind::Chat.tools().contains(&"delegate_to_agent"));
        assert!(AgentKind::Chat.tools().contains(&"load_prompt"));
        assert!(!AgentKind::Memory.tools().contains(&"delegate_to_agent"));
        assert!(!AgentKind::Memory.tools().contains(&"load_prompt"));
        assert!(AgentKind::Note.tools().contains(&"save_note"));
        // code：仅生成——不绑任何执行类工具；search 绑联网双工具。
        assert!(AgentKind::Code.tools().contains(&"vector_search"));
        assert!(!AgentKind::Code.tools().contains(&"run_code"));
        assert!(AgentKind::Search.tools().contains(&"search_docs"));
        assert!(AgentKind::Search.tools().contains(&"web_crawl"));
        // academic：论文交付走文件，绑 write_file 与模式加载
        assert_eq!(AgentKind::Academic.max_steps(), 12);
        assert!(AgentKind::Academic.tools().contains(&"write_file"));
        assert!(AgentKind::Academic.tools().contains(&"load_prompt"));
        assert!(AgentKind::Academic.tools().contains(&"plan"));
        assert!(!AgentKind::Academic.tools().contains(&"delegate_to_agent"));
    }

    #[test]
    fn code_prompt_forbids_claiming_execution_and_search_prompt_prioritizes_context7() {
        let code = code_system_prompt("你是代码助手。严禁编造执行结果。", "写个快排");
        assert!(code.contains("写个快排"));
        assert!(code.contains("严禁编造执行结果"));
        assert!(
            !code.contains("run_code"),
            "generate-only variant drops sandbox tool"
        );

        let search = search_system_prompt(
            "文档搜索助手。search_docs web_crawl prompt injection",
            "react hooks",
        );
        assert!(search.contains("search_docs"));
        assert!(search.contains("web_crawl"));
        assert!(search.contains("prompt injection"));
        assert!(search.contains("react hooks"));
    }

    #[test]
    fn chat_description_matches_backend_verbatim_prefix() {
        assert!(AgentKind::Chat
            .description()
            .starts_with("收藏夹知识库助手。使用ReAct模式"));
    }

    #[test]
    fn prompts_embed_placeholders_and_rules() {
        const TEST_BASE: &str = "你是收藏夹助手。\n## 引用规则\n标注【视频标题】。";
        let window = format_search_window(&[make_window_entry("q", "r", vec![])]);
        let memory = memory_system_prompt("记忆检索助手。", &window, "chat", "原始问题");
        assert!(memory.contains("q"));
        assert!(!memory.contains("target_agent"));
        assert!(memory.contains("chat"));

        let note = note_system_prompt("笔记助手。save_note", "帮我记一下");
        assert!(note.contains("save_note"));
        assert!(note.contains("帮我记一下"));

        // 组装顺序：base（必载）在前，工具指南只为绑定的工具出现。
        let chat = chat_system_prompt(TEST_BASE, "", "", AgentKind::Chat.tools());
        assert!(
            chat.starts_with("你是收藏夹助手。"),
            "base leads the prompt"
        );
        assert!(chat.contains("delegate_to_agent"));
        assert!(chat.contains("【视频标题】"), "base carried through");
        assert!(chat.contains("工具使用指南"));
        assert!(chat.contains("generate_resume"), "bound tool guide present");
        assert!(chat.contains("load_prompt"), "bound tool guide present");
        assert!(
            !chat.contains("可用技能"),
            "no skills section when digest is empty"
        );
        assert!(
            !chat.contains("## 可加载提示词"),
            "no index section when empty"
        );

        // prompts index only appended when non-empty.
        let with_index = chat_system_prompt(
            TEST_BASE,
            "",
            "- `联网委托`：何时联网委托",
            AgentKind::Chat.tools(),
        );
        assert!(with_index.contains("## 可加载提示词"));
        assert!(with_index.contains("`联网委托`"));

        // 未绑定生成工具时，其工具指南不注入（按需组装的核心断言）。
        let without_generation =
            chat_system_prompt(TEST_BASE, "", "", &["vector_search", "delegate_to_agent"]);
        assert!(
            !without_generation.contains("generate_resume"),
            "unbound tool guide must be omitted"
        );
        assert!(without_generation.contains("vector_search"));

        let with_skills = chat_system_prompt(
            TEST_BASE,
            "- `pdf-report`：生成 PDF 报告",
            "",
            AgentKind::Chat.tools(),
        );
        assert!(with_skills.contains("## 可用技能（Skills）"));
        assert!(with_skills.contains("pdf-report"));
        assert!(
            with_skills.contains("load_skill"),
            "skills present ⇒ usage rule present"
        );
    }
}
