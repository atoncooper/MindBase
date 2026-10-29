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

mod artifacts;
mod common;
mod context;
mod delegate;
mod files;
mod interaction;
mod knowledge;
mod memory;
mod notes;
mod prompts;
mod session_store;
mod skills;
mod vision;
mod web;

pub(crate) use artifacts::{GenerateResumeTool, GenerateSlidesTool};
pub(crate) use context::{GetCompressedSummaryTool, GetFullHistoryTool, GetRecentContextTool};
pub(crate) use delegate::DelegateToAgentTool;
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
pub(crate) use session_store::{
    ListErrorsTool, ListHistoryTool, ReadErrorTool, ReadTurnTool, SearchContentTool,
};
pub(crate) use skills::LoadSkillTool;
#[allow(unused_imports)] // re-exported for path stability (guards/parsers used by web tools themselves)
pub(crate) use web::{html_to_text, is_safe_url, sanitize_crawled, SearchDocsTool, WebCrawlTool};
