//! ASR configuration: key/model/base-URL resolution and protocol detection.

use rusqlite::Connection;

use crate::llm::api_keys;

use super::types::AsrMode;

/// Default DashScope async ASR endpoint (mirrors backend `ASR_BASE`).
pub(crate) const DEFAULT_ASR_BASE: &str = "https://dashscope.aliyuncs.com/api/v1";

/// The default ASR base URL (used when the user leaves the field blank).
pub(crate) fn resolve_default_base() -> String {
    DEFAULT_ASR_BASE.to_string()
}
/// Default model when the user leaves the `asr` slot's model blank. Mirrors
/// the backend's `asr.model` (`paraformer-realtime-v2`, the real-time
/// Recognition model). Also the value `realtime_model()` falls back to when a
/// user has set the async batch default instead of a streaming model.
pub(crate) const ASR_MODEL: &str = "paraformer-realtime-v2";

/// Async Transcription model for long audio. Mirrors the backend's
/// `asr.transcription_model` (`paraformer-v2`): the real-time Recognition
/// model (`paraformer-realtime-v2`) does NOT support async batch
/// Transcription, so async tasks must always use this dedicated batch model —
/// never the user's configured real-time model.
pub(crate) const TRANSCRIPTION_MODEL: &str = "paraformer-v2";

/// ASR key from local settings; ingest fails fast without one. The dedicated
/// `asr` slot wins when set; otherwise fall back to the shared DashScope
/// credential.
pub(crate) fn resolve_api_key(conn: &Connection) -> Result<String, String> {
    if let Some((key, _)) = api_keys::read_raw_config(conn, "asr")? {
        return Ok(key);
    }
    match api_keys::read_raw_config(conn, "dashscope")? {
        Some((key, _)) => Ok(key),
        None => Err(
            "未配置 ASR/DashScope API Key：请在「API 设置」中填写密钥，或切换到「本地部署」用本地模型转写"
                .to_string(),
        ),
    }
}

/// ASR model: the dedicated `asr` slot's model when set, else the default.
pub(crate) fn resolve_model(conn: &Connection) -> Result<String, String> {
    let stored = api_keys::read_model(conn, "asr")?;
    Ok(if stored.trim().is_empty() {
        ASR_MODEL.to_string()
    } else {
        stored
    })
}

/// ASR Base URL: the dedicated `asr` slot's value when set, else the default
/// DashScope endpoint. `None` when nothing is stored.
pub(crate) fn resolve_base_url(conn: &Connection) -> Result<Option<String>, String> {
    match api_keys::read_raw_config(conn, "asr")? {
        Some((_, base_url)) if !base_url.trim().is_empty() => Ok(Some(base_url.trim().to_string())),
        _ => Ok(None),
    }
}

/// Detect the protocol family from a Base URL.
///
/// Any host containing `dashscope.aliyuncs.com` uses the async DashScope
/// protocol; every other host (OpenRouter, a local server, …) is treated as
/// OpenAI-compatible `POST /audio/transcriptions`.
pub(crate) fn detect_mode(base_url: &str) -> AsrMode {
    if base_url.starts_with("ws://") || base_url.starts_with("wss://") {
        AsrMode::WebSocket
    } else if base_url.contains("dashscope.aliyuncs.com") {
        AsrMode::DashScope
    } else {
        AsrMode::OpenAICompatible
    }
}
