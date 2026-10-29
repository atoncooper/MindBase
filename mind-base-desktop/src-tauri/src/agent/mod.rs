//! Local agent stack: the AgentHarness, agent kinds, chat sessions and tools.
//!
//! - [`harness`] — orchestrator + lifecycle + registry/runtime + ReAct loop.
//! - [`agents`] — agent descriptors (chat / memory / note / code / search …).
//! - [`chat`] — conversation sessions, streaming turns and summaries.
//! - [`prompts`] — editable prompt defaults seeded under the data directory.
//! - [`skills`] — skill packs (install/list/enable).
//! - [`web_search`] — web-search tool implementation.

pub(crate) mod agents;
pub(crate) mod chat;
pub(crate) mod harness;
pub(crate) mod prompts;
pub(crate) mod skills;
pub(crate) mod web_search;
