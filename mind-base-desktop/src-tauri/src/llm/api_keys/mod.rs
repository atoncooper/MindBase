//! Per-provider API configuration (key / base URL / model) in local SQLite.
//!
//! Threat model: this is a fully-local desktop app, so keys live in the same
//! database as everything else — OS-level at-rest protection (keychain etc.)
//! is deliberately out of scope. What this module *does* enforce:
//!
//! - Raw keys never cross back to the UI: every read returns a masked
//!   preview (`sk-…wxyz`) only, so a shoulder-surf or screenshot of the
//!   settings page never leaks a usable credential.
//! - Keys are never logged; error paths carry no secret material.
//! - Writes are validated at the boundary: provider allowlist, trimmed
//!   values, bounded lengths, no control characters in keys.
//!
//! Base URL and model are optional; an empty value always means "use the
//! provider default". Providers mirror the conversational-LLM split used
//! across MindBase: DashScope (first-party) and OpenRouter (fallback).
//!
//! Module layout:
//! - [`validation`] — boundary validation (provider allowlist / key / model /
//!   Base URL) and key masking.
//! - [`status`] — non-secret status rows, config persistence and the
//!   settings-page commands.
//! - [`catalog`] — provider catalog, default endpoints and model-list probes
//!   for the settings UI.
//! - [`proxy`] — process-wide egress proxy setting, direct-connect bypass list
//!   and ureq agent construction.
//! - [`probe`] — connectivity probes (model list + proxy reachability).
//! - [`e2e`] — end-to-end ASR / embedding checks behind
//!   `test_provider_config`.

mod catalog;
mod e2e;
mod probe;
mod proxy;
mod status;
mod validation;

// Tauri IPC commands are re-exported together with the two generated macros
// that drive `tauri::generate_handler!` path resolution.
pub use self::catalog::{
    __cmd__list_provider_models, __cmd__provider_catalog, __tauri_command_name_list_provider_models,
    __tauri_command_name_provider_catalog, list_provider_models, provider_catalog,
};
pub use self::e2e::{
    __cmd__test_provider_config, __tauri_command_name_test_provider_config, test_provider_config,
};
pub use self::probe::{__cmd__test_proxy, __tauri_command_name_test_proxy, test_proxy};
#[allow(unused_imports)] // previously visible here; kept on the facade for path stability
pub use self::probe::{ProviderTestResult, ProxyTestResult};
pub use self::status::{
    __cmd__clear_provider_key, __cmd__list_api_keys, __cmd__save_provider_config,
    __cmd__set_default_provider, __tauri_command_name_clear_provider_key,
    __tauri_command_name_list_api_keys, __tauri_command_name_save_provider_config,
    __tauri_command_name_set_default_provider, clear_provider_key, list_api_keys,
    save_provider_config, set_default_provider,
};
#[allow(unused_imports)] // previously visible here; kept on the facade for path stability
pub use self::status::ProviderStatus;

pub(crate) use self::catalog::default_endpoint;
pub(crate) use self::proxy::{
    child_proxy_env, egress_agents, normalize_proxy_addr, proxy_for_url, proxy_setting,
    refresh_proxy_setting,
};
pub(crate) use self::status::{read_model, read_raw_config};

// Package-internal items that were reachable at this path before the split.
#[allow(unused_imports)]
pub(crate) use self::proxy::{set_proxy_setting, ProxySetting};
