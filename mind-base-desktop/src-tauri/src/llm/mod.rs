//! Outbound model access (the only package that talks to provider APIs).
//!
//! - [`ai_providers`] — static provider catalog (endpoints, model lists).
//! - [`api_keys`] — credential storage/masking, provider probes, egress proxy.
//! - [`client`] — streaming chat client (OpenAI-compatible + Anthropic).
//! - [`embeddings`] — embedding calls for the local vector store.
//! - [`rerank`] — rerank calls used by hybrid retrieval.
//! - [`deepseek_search`] — DeepSeek 官方 Search/Fetch API（联网搜索/抓正文首选）。

pub(crate) mod ai_providers;
pub(crate) mod api_keys;
pub(crate) mod client;
pub(crate) mod deepseek_search;
pub(crate) mod embeddings;
pub(crate) mod rerank;
