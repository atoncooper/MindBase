//! Conversational LLM client for workspace Q&A.
//!
//! Provider choice mirrors the backend's split: DashScope first (its key is
//! required for embeddings anyway), OpenRouter as the alternative when
//! DashScope is not configured. The per-provider `model` stored in API
//! settings is honored; unset falls back to a cheap default (`qwen-flash`)
//! on DashScope, while OpenRouter demands an explicit model.
//!
//! Module layout:
//! - [`types`] — chat messages, tool calls, token usage and client construction.
//! - [`stream`] — SSE turn assembly and the streamed completion loop.
//! - [`openai`] — OpenAI-compatible endpoints, payloads and body parsing.
//! - [`anthropic`] — Anthropic Messages adapter bridging to the same shape.
//! - [`usage`] — provider usage-object parsing.
//! - [`vision`] — vision capability heuristic and image fallbacks.

mod anthropic;
mod openai;
mod stream;
mod types;
mod usage;
mod vision;

pub(crate) use self::types::{
    chat_client_for, chat_client_from_conn, ChatClient, ChatMessage, ToolCallReq, TokenUsage,
};
pub(crate) use self::vision::model_supports_vision;

// Package-internal items that were reachable at this path before the split.
#[allow(unused_imports)]
pub(crate) use self::openai::{build_stream_payload, stream_usage_enabled};
#[allow(unused_imports)]
pub(crate) use self::stream::StreamTurn;
#[allow(unused_imports)]
pub(crate) use self::usage::parse_provider_usage;
