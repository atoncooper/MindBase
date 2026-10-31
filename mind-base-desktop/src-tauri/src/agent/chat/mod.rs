//! Conversation sessions + grounded streaming chat turns.
//!
//! Mirrors the backend's chat stack in local terms: `chat_sessions` /
//! `chat_messages` SQLite tables replace MySQL+Mongo; the SSE frame protocol
//! becomes a Tauri `Channel<ChatEvent>` (`chunk` → `sources` → `done`, with
//! `error` on failure and a `title` side-event for auto-naming). Retrieval
//! reuses the ingestion embedding client and vector store; the answer is one
//! streamed completion over [system, last-6-messages history, grounded user
//! turn], with 【视频标题】-style citations mirroring the backend prompt.

mod context;
mod history;
mod images;
mod sessions;
mod live;
mod streaming;
mod summary;
mod types;

// Commands are re-exported with the `#[tauri::command]` wrapper macros they
// generate, so `generate_handler!` keeps resolving them via this path.
pub use self::history::chat_history;
pub use self::history::{__cmd__chat_history, __tauri_command_name_chat_history};
pub use self::sessions::{chat_session_create, chat_session_delete, chat_session_rename};
pub use self::sessions::{chat_sessions_list, stop_chat};
pub use self::sessions::{
    __cmd__chat_session_create, __cmd__chat_session_delete, __cmd__chat_session_rename,
    __cmd__chat_sessions_list, __cmd__stop_chat, __tauri_command_name_chat_session_create,
    __tauri_command_name_chat_session_delete, __tauri_command_name_chat_session_rename,
    __tauri_command_name_chat_sessions_list, __tauri_command_name_stop_chat,
};
pub use self::streaming::chat_ask;
pub use self::streaming::{__cmd__chat_ask, __tauri_command_name_chat_ask};
pub use self::summary::{chat_summarize, chat_summary_get};
pub use self::summary::{
    __cmd__chat_summarize, __cmd__chat_summary_get, __tauri_command_name_chat_summarize,
    __tauri_command_name_chat_summary_get,
};
pub(crate) use self::context::format_context_blocks;
pub(crate) use self::live::chat_live_state;
#[doc(hidden)]
pub(crate) use self::live::{__cmd__chat_live_state, __tauri_command_name_chat_live_state};
pub(crate) use self::sessions::epoch_to_date;
// Payload / helper items only used inside this package today; kept re-exported
// so their historical `crate::agent::chat::*` paths stay valid.
#[allow(unused_imports)]
pub use self::summary::SessionSummaryDoc;
#[allow(unused_imports)]
pub(crate) use self::context::{collect_sources, fallback_title, sanitize_title};
#[allow(unused_imports)]
pub(crate) use self::images::validate_user_images;
#[allow(unused_imports)]
pub(crate) use self::summary::summary_system_prompt;
#[allow(unused_imports)]
pub(crate) use self::types::{
    usage_from_json, usage_to_json, ChatEvent, ChatMessageRow, ChatSessionRow, ChatSource,
    ChatTurnResult,
};
