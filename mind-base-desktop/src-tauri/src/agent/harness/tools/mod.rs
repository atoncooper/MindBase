//! Concrete tool implementations registered into the [`ToolRegistry`].
//!
//! Moved here from the former single-file harness: the three ingestion-era
//! tools (vector_search / list_documents / search_chat_history) plus the
//! context trio (get_recent_context / get_full_history /
//! get_compressed_summary), the four note tools (wrapping notes.rs internals),
//! delegate_to_agent and the skills loader.
//!
//! The implementation is split by tool family into submodules; this facade
//! re-exports every item that was previously visible from `tools`, so existing
//! call sites keep their paths unchanged.

mod academic;
mod artifacts;
mod automation;
mod cli;
mod common;
mod context;
mod delegate;
mod factory;
mod files;
mod gh;
mod git;
mod interaction;
mod knowledge;
mod memory;
mod notes;
mod prompts;
mod sandbox;
mod session_store;
mod usage;
mod shell;
mod skills;
mod vision;
mod web;

pub(crate) use academic::{
    AcademicEvidenceTool, AcademicLiteratureTool, AcademicManuscriptTool, AcademicProjectTool,
};
pub(crate) use artifacts::{GenerateResumeTool, GenerateSlidesTool};
pub(crate) use automation::{
    AutomationDueTool, AutomationKillTool, AutomationListTool, AutomationLogReadTool,
    AutomationLogSearchTool, AutomationRetryTool, AutomationStatusTool, StartAutomationTool,
};
pub(crate) use context::{GetCompressedSummaryTool, GetFullHistoryTool, GetRecentContextTool};
pub(crate) use delegate::DelegateToAgentTool;
pub(crate) use gh::GhTool;
pub(crate) use git::GitTool;
pub(crate) use factory::{CreateAgentTool, ListAgentsTool};
pub(crate) use files::{ListDirTool, ReadFileTool, WriteFileTool};
pub(crate) use interaction::{AskUserTool, PlanTool};
#[allow(unused_imports)] // some items are only used inside their own submodule; re-exported for path stability
pub(crate) use knowledge::{
    format_document_list, format_history_matches, DocumentListRow, HistoryMatch,
    ListDocumentsTool, SearchChatHistoryTool, VectorSearchTool,
};
pub(crate) use memory::{
    deposit_session_finding, record_session_finding, GetSessionFindingsTool, MemorySearchTool,
    MemoryWriteTool,
};
pub(crate) use notes::{GetNoteTool, ListNotesTool, SaveNoteTool, UpdateNoteTool};
pub(crate) use prompts::LoadPromptTool;
pub(crate) use sandbox::RunSandboxedTool;
pub(crate) use session_store::{
    ListErrorsTool, ListHistoryTool, ReadErrorTool, ReadTurnTool, SearchContentTool,
};
pub(crate) use shell::RunCommandTool;
pub(crate) use usage::UsageStatsTool;
pub(crate) use skills::LoadSkillTool;
#[allow(unused_imports)] // re-exported for path stability (guards/parsers used by web tools themselves)
pub(crate) use web::{html_to_text, is_safe_url, sanitize_crawled, SearchDocsTool, WebCrawlTool};
