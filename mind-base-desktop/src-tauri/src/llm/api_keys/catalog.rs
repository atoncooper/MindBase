//! Provider catalog, default endpoints and model-list probes for the settings UI.

use tauri::State;

use crate::infra::db::Db;

use super::probe::{request_models, PROBE_TIMEOUT};
use super::proxy::egress_agents;
use super::status::read_raw_config;
use super::validation::validate_provider;

/// Path appended to an endpoint to reach its cheap auth-check resource;
/// listing models verifies the key without consuming tokens.
const PROBE_PATH: &str = "/models";

/// Official endpoint for a provider; empty string when unknown.
pub(crate) fn default_endpoint(provider: &str) -> &'static str {
    crate::llm::ai_providers::default_base(provider)
}

/// Join an endpoint (custom or default) with the probe path.
///
/// Trailing slashes on custom Base URLs must not produce `//models`.
///
/// The `asr` slot is special: its Base URL is a *transcription* endpoint (e.g.
/// `…/v1/audio/transcriptions` for OpenRouter, or the DashScope async endpoint)
/// which has no `/models` route. The probe rewrites it to a reachable
/// OpenAI-compatible model-list URL so "测试连接" validates the key/endpoint
/// without 404ing:
/// - DashScope async base → the compatible-mode models list.
/// - Any other base → strip a trailing `/audio/transcriptions`, ensure a `/v1`
///   (or at least an origin) prefix, then probe `…/models`.
pub(super) fn build_models_url(custom_base: &str, provider: &str) -> Option<String> {
    let base = if custom_base.trim().is_empty() {
        default_endpoint(provider).to_string()
    } else {
        custom_base.trim().trim_end_matches('/').to_string()
    };
    // custom 提供方没有默认端点：未填 Base URL 时无 probes 可打。
    if base.trim().is_empty() {
        return None;
    }

    if provider != "asr" {
        // Anthropic 协议的模型列表在 /v1/models 下（Base 自带 /v1 时不重复）。
        if crate::llm::ai_providers::protocol_of(provider)
            == crate::llm::ai_providers::ApiProtocol::AnthropicMessages
        {
            let probed = if base.ends_with("/v1") {
                base
            } else {
                format!("{base}/v1")
            };
            return Some(format!("{probed}{PROBE_PATH}"));
        }
        return Some(format!("{base}{PROBE_PATH}"));
    }

    // A WebSocket ASR endpoint speaks the duplex protocol, not an HTTP
    // `/models` route — there is no model list to probe. Its verdict comes
    // from the live real-time transcription probe instead.
    if base.starts_with("ws://") || base.starts_with("wss://") {
        return None;
    }

    // DashScope async ASR endpoint → use the compatible-mode model list.
    if base.contains("dashscope.aliyuncs.com/api/v1") {
        return Some("https://dashscope.aliyuncs.com/compatible-mode/v1/models".to_string());
    }

    // OpenAI-compatible ASR base: drop the transcription resource if present.
    let stripped = base
        .strip_suffix("/audio/transcriptions")
        .map(|s| s.to_string())
        .unwrap_or(base);
    let probed = if stripped.is_empty() || stripped == "/" {
        "https://api.openai.com/v1".to_string()
    } else if stripped.ends_with("/v1") {
        stripped
    } else {
        format!("{stripped}/v1")
    };
    Some(format!("{probed}{PROBE_PATH}"))
}

/// 模型配置目录：设置页的数据源（含分组、协议、默认端点与推荐模型）。
#[tauri::command]
pub fn provider_catalog() -> Vec<crate::llm::ai_providers::ProviderDef> {
    crate::llm::ai_providers::PROVIDERS.to_vec()
}

/// 从提供方端点拉取可用模型列表（GET /models，按协议鉴权），供设置页选择。
#[tauri::command]
pub fn list_provider_models(provider: String, db: State<'_, Db>) -> Result<Vec<String>, String> {
    let provider = validate_provider(&provider)?;
    let (key, base_url) = {
        let conn = db
            .conn
            .lock()
            .map_err(|err| format!("failed to acquire database lock: {err}"))?;
        match read_raw_config(&conn, &provider)? {
            Some((key, base_url)) => (key, base_url),
            None => return Err("请先保存 API Key 再获取模型列表".to_string()),
        }
    };
    let Some(url) = build_models_url(&base_url, &provider) else {
        return Err("该端点不提供模型列表".to_string());
    };
    let protocol = crate::llm::ai_providers::protocol_of(&provider);
    let (primary, fallback) = egress_agents(PROBE_TIMEOUT, &url)?;
    let outcome = request_models(&primary, &url, &key, protocol).or_else(|first_err| {
        let fallback = fallback.ok_or_else(|| first_err.clone())?;
        request_models(&fallback, &url, &key, protocol)
            .map_err(|retry_err| format!("{first_err}; fallback: {retry_err}"))
    })?;
    let (status, ids) = outcome;
    if status != 200 {
        return Err(format!("获取模型列表失败（HTTP {status}）"));
    }
    let mut ids = ids.unwrap_or_default();
    ids.sort();
    ids.dedup();
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anthropic_probe_urls_use_v1_models() {
        assert_eq!(
            build_models_url("", "anthropic"),
            Some("https://api.anthropic.com/v1/models".to_string())
        );
        assert_eq!(
            build_models_url("https://api.minimax.io/anthropic", "minimax"),
            Some("https://api.minimax.io/anthropic/v1/models".to_string())
        );
        assert_eq!(
            build_models_url("", "kimi-coding"),
            Some("https://api.kimi.com/coding/v1/models".to_string())
        );
    }

    #[test]
    fn models_url_uses_default_when_custom_empty() {
        assert_eq!(
            build_models_url("", "dashscope"),
            Some("https://dashscope.aliyuncs.com/compatible-mode/v1/models".to_string())
        );
    }

    #[test]
    fn models_url_trims_trailing_slash_and_joins() {
        assert_eq!(
            build_models_url("https://proxy.local/v1/", "openrouter"),
            Some("https://proxy.local/v1/models".to_string())
        );
    }

    #[test]
    fn asr_probe_url_rewrites_transcription_endpoint() {
        // OpenRouter transcription base → strip the resource, probe the models list.
        assert_eq!(
            build_models_url("https://openrouter.ai/api/v1/audio/transcriptions", "asr",),
            Some("https://openrouter.ai/api/v1/models".to_string())
        );
        // DashScope async base → compatible-mode models list.
        assert_eq!(
            build_models_url("https://dashscope.aliyuncs.com/api/v1", "asr"),
            Some("https://dashscope.aliyuncs.com/compatible-mode/v1/models".to_string())
        );
        // An already /v1 OpenAI-compatible ASR base is only joined with /models.
        assert_eq!(
            build_models_url("https://proxy.local/v1", "asr"),
            Some("https://proxy.local/v1/models".to_string())
        );
        // A WebSocket ASR endpoint has no HTTP model list → None.
        assert_eq!(
            build_models_url("wss://dashscope.aliyuncs.com/api-ws/v1/inference/", "asr"),
            None
        );
    }
}
