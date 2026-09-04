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

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::db::Db;

/// Providers that may hold a stored configuration. `asr` / `embedding` are
/// purpose slots: they override the conversational DashScope key for their
/// specific pipeline and fall back to it when unset.
const KNOWN_PROVIDERS: [&str; 6] = [
    "dashscope",
    "openrouter",
    "deepseek",
    "asr",
    "embedding",
    "ocr",
];

/// Upper bound for any accepted key; real provider keys stay far below this.
const MAX_KEY_LEN: usize = 256;

/// Upper bound for a custom base URL.
const MAX_BASE_URL_LEN: usize = 512;

/// Upper bound for a model identifier.
const MAX_MODEL_LEN: usize = 128;

/// Leading characters kept visible in a masked preview.
const MASK_HEAD: usize = 3;

/// Trailing characters kept visible in a masked preview.
const MASK_TAIL: usize = 4;

/// Minimum length for head+tail masking; shorter keys collapse to stars only.
const MASK_MIN_LEN: usize = MASK_HEAD + MASK_TAIL + 4;

/// Official OpenAI-compatible endpoints used when no custom Base URL is set.
const DEFAULT_ENDPOINTS: [(&str, &str); 6] = [
    (
        "dashscope",
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
    ),
    ("openrouter", "https://openrouter.ai/api/v1"),
    ("deepseek", "https://api.deepseek.com/v1"),
    ("asr", "https://dashscope.aliyuncs.com/api/v1"),
    (
        "embedding",
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
    ),
    // OCR 走 DashScope 兼容模式的多模态端点（qwen-vl-ocr 系列模型），
    // /models 探针与其他兼容模式提供方一致。
    ("ocr", "https://dashscope.aliyuncs.com/compatible-mode/v1"),
];

/// Path appended to an endpoint to reach its cheap auth-check resource;
/// listing models verifies the key without consuming tokens.
const PROBE_PATH: &str = "/models";

/// Wall-clock cap for one connectivity probe.
const PROBE_TIMEOUT: Duration = Duration::from_secs(8);

/// Non-secret view of one provider's stored configuration, safe for the UI.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub provider: String,
    pub has_key: bool,
    /// Masked preview such as `sk-…wxyz`; `None` when nothing is stored.
    pub masked_key: Option<String>,
    /// Custom base URL; empty string = use the provider default.
    pub base_url: String,
    /// Model identifier; empty string = unset.
    pub model: String,
    /// Unix seconds of the last write; `None` when no row exists yet.
    pub updated_at: Option<i64>,
    /// True when this is the user-chosen default chat provider.
    #[serde(default)]
    pub is_default: bool,
}

/// Collapse a raw key into a preview that cannot be reversed.
///
/// Long enough keys keep their first [`MASK_HEAD`] and last [`MASK_TAIL`]
/// characters (the tail is what users recognize); anything shorter becomes
/// stars only, never revealing length beyond a coarse hint.
fn mask_key(key: &str) -> String {
    let chars: Vec<char> = key.chars().collect();
    if chars.len() >= MASK_MIN_LEN {
        let head: String = chars[..MASK_HEAD].iter().collect();
        let tail: String = chars[chars.len() - MASK_TAIL..].iter().collect();
        return format!("{head}…{tail}");
    }
    "*".repeat(chars.len())
}

/// Validate and normalize a provider identifier against the allowlist.
fn validate_provider(provider: &str) -> Result<String, String> {
    let normalized = provider.trim().to_ascii_lowercase();
    if !KNOWN_PROVIDERS.contains(&normalized.as_str()) {
        return Err(format!(
            "不支持的提供方：{provider:?}（可选：{}）",
            KNOWN_PROVIDERS.join(" / ")
        ));
    }
    Ok(normalized)
}

/// Validate a user-supplied key before it touches the database.
///
/// Returns the trimmed value; rejects empties, oversized input and anything
/// containing control characters (a pasted key should never have those).
fn validate_secret(key: &str) -> Result<String, String> {
    let trimmed = key.trim();
    if trimmed.chars().count() > MAX_KEY_LEN {
        return Err(format!("API Key 过长（上限 {MAX_KEY_LEN} 字符）"));
    }
    if trimmed.chars().any(char::is_control) {
        return Err("API Key 含有非法控制字符，请重新复制粘贴".to_string());
    }
    Ok(trimmed.to_string())
}

/// True when `c` may appear inside a model identifier
/// (`qwen-max`, `openai/gpt-4o`, `deepseek-v3.1`, …).
fn is_model_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/' | ':' | '@' | '+')
}

/// Validate a model identifier. Empty = unset (use the provider default).
fn validate_model(model: &str) -> Result<String, String> {
    let trimmed = model.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    if trimmed.chars().count() > MAX_MODEL_LEN {
        return Err(format!("模型名称过长（上限 {MAX_MODEL_LEN} 字符）"));
    }
    if !trimmed.chars().all(is_model_char) {
        return Err("模型名称含非法字符（仅允许字母、数字与 . _ - / : @ +）".to_string());
    }
    Ok(trimmed.to_string())
}

/// Validate a custom base URL. Empty = use the provider default endpoint.
fn validate_base_url(url: &str) -> Result<String, String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    if trimmed.chars().count() > MAX_BASE_URL_LEN {
        return Err(format!("Base URL 过长（上限 {MAX_BASE_URL_LEN} 字符）"));
    }
    if trimmed.contains(char::is_whitespace) {
        return Err("Base URL 不能包含空白字符".to_string());
    }
    if !(trimmed.starts_with("http://")
        || trimmed.starts_with("https://")
        || trimmed.starts_with("ws://")
        || trimmed.starts_with("wss://"))
    {
        return Err("Base URL 必须以 http://、https://、ws:// 或 wss:// 开头".to_string());
    }
    Ok(trimmed.to_string())
}

/// Unix seconds right now; clock-skewed systems just get an odd ordering.
fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|delta| delta.as_secs() as i64)
        .unwrap_or_default()
}

/// Read one provider's non-secret status row.
///
/// Rows written before the base_url/model columns existed still read fine:
/// the migration backfills both as empty strings.
fn read_status(conn: &Connection, provider: &str) -> Result<ProviderStatus, String> {
    let result = conn.query_row(
        "SELECT api_key, COALESCE(base_url, ''), COALESCE(model, ''), updated_at
         FROM api_keys WHERE provider = ?1",
        params![provider],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        },
    );
    match result {
        Ok((key, base_url, model, updated_at)) => {
            let has_key = !key.is_empty();
            Ok(ProviderStatus {
                provider: provider.to_string(),
                has_key,
                is_default: false,
                masked_key: if has_key { Some(mask_key(&key)) } else { None },
                base_url,
                model,
                updated_at: Some(updated_at),
            })
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(ProviderStatus {
            provider: provider.to_string(),
            has_key: false,
            masked_key: None,
            base_url: String::new(),
            model: String::new(),
            updated_at: None,
            is_default: false,
        }),
        Err(err) => Err(format!("failed to read provider status: {err}")),
    }
}

/// Snapshot every known provider, in allowlist order.
fn list_statuses(conn: &Connection) -> Result<Vec<ProviderStatus>, String> {
    let default_provider = crate::config::load(conn)?.default_chat_provider;
    KNOWN_PROVIDERS
        .iter()
        .map(|provider| {
            let mut status = read_status(conn, provider)?;
            status.is_default = default_provider.as_deref() == Some(*provider);
            Ok(status)
        })
        .collect()
}

/// Read one provider's raw credential + base URL for internal use.
///
/// The raw key must never cross to the frontend; in-crate consumers (the
/// embeddings/ASR/chat clients) use this to build authenticated requests.
/// `None` = nothing stored for the provider.
pub(crate) fn read_raw_config(
    conn: &Connection,
    provider: &str,
) -> Result<Option<(String, String)>, String> {
    let result = conn.query_row(
        "SELECT api_key, COALESCE(base_url, '') FROM api_keys WHERE provider = ?1",
        params![provider],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    );
    match result {
        Ok((key, base_url)) if !key.is_empty() => Ok(Some((key, base_url))),
        Ok(_) => Ok(None),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(err) => Err(format!("failed to read provider config: {err}")),
    }
}

/// Read one provider's stored model identifier (empty string = unset).
pub(crate) fn read_model(conn: &Connection, provider: &str) -> Result<String, String> {
    match conn.query_row(
        "SELECT COALESCE(model, '') FROM api_keys WHERE provider = ?1",
        params![provider],
        |row| row.get::<_, String>(0),
    ) {
        Ok(model) => Ok(model),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(String::new()),
        Err(err) => Err(format!("failed to read provider model: {err}")),
    }
}

/// Official endpoint for a provider; empty string when unknown.
pub(crate) fn default_endpoint(provider: &str) -> &'static str {
    DEFAULT_ENDPOINTS
        .iter()
        .find(|(name, _)| *name == provider)
        .map(|(_, url)| *url)
        .unwrap_or_default()
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
fn build_models_url(custom_base: &str, provider: &str) -> Option<String> {
    let base = if custom_base.trim().is_empty() {
        default_endpoint(provider).to_string()
    } else {
        custom_base.trim().trim_end_matches('/').to_string()
    };

    if provider != "asr" {
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

/// Outcome of one connectivity probe, safe to hand to the UI.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTestResult {
    pub provider: String,
    pub ok: bool,
    /// Round-trip latency in milliseconds.
    pub latency_ms: u64,
    /// The exact URL that was probed (no secret material).
    pub endpoint: String,
    /// HTTP status when the server answered; `None` on transport failure.
    pub http_status: Option<u16>,
    /// Number of models the endpoint advertised, when it answered 200.
    pub model_count: Option<usize>,
    /// Human-readable conclusion in Chinese for the settings UI.
    pub detail: String,
    /// Whether the configured ASR model was found in the advertised list.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asr_model_ok: Option<bool>,
    /// End-to-end transcription probe note (ASR only, consumes quota).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asr_note: Option<String>,
    /// End-to-end embedding probe note (embedding only, one tiny call).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embedding_note: Option<String>,
}

/// Map one HTTP status to (verdict, human detail).
fn describe_status(status: u16, model_count: Option<usize>) -> (bool, String) {
    match status {
        200 => (
            true,
            match model_count {
                Some(count) => format!("密钥有效，端点返回 {count} 个可用模型"),
                None => "密钥有效".to_string(),
            },
        ),
        401 | 403 => (false, "鉴权失败：API Key 无效或已过期".to_string()),
        404 => (false, "端点不存在：请检查 Base URL 是否正确".to_string()),
        429 => (false, "请求过于频繁或额度受限（HTTP 429）".to_string()),
        code if (500..600).contains(&code) => (
            false,
            format!("提供方服务端错误（HTTP {code}），请稍后重试"),
        ),
        code => (false, format!("意外的 HTTP 状态码 {code}")),
    }
}

/// Normalize a raw proxy env value into a URL ureq accepts (mirrors updater).
fn normalize_proxy_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.contains("://") {
        Some(trimmed.to_string())
    } else {
        Some(format!("http://{trimmed}"))
    }
}

/// First usable proxy URL from the environment (HTTPS before HTTP).
fn proxy_from_env() -> Option<String> {
    for key in ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] {
        if let Ok(value) = std::env::var(key) {
            if let Some(url) = normalize_proxy_url(&value) {
                return Some(url);
            }
        }
    }
    None
}

/// Build a ureq agent with the given timeout, attaching a proxy if given.
fn http_agent(timeout: Duration, proxy_url: Option<&str>) -> Result<ureq::Agent, String> {
    let builder = ureq::AgentBuilder::new().timeout(timeout);
    let builder = match proxy_url {
        Some(url) => builder
            .proxy(ureq::Proxy::new(url).map_err(|err| format!("invalid proxy url {url}: {err}"))?),
        None => builder,
    };
    Ok(builder.build())
}

/// Build a ureq agent with the probe timeout, attaching a proxy if given.
fn build_probe_agent(proxy_url: Option<&str>) -> Result<ureq::Agent, String> {
    http_agent(PROBE_TIMEOUT, proxy_url)
}

/// Direct (no-proxy) agent for provider API traffic — embeddings / ASR /
/// chat. Callers mirror the probe convention: attempt direct first, then
/// retry once through [`proxied_agent`] when the env proxy exists.
pub(crate) fn direct_agent(timeout: Duration) -> Result<ureq::Agent, String> {
    http_agent(timeout, None)
}

/// Agent routed through the env proxy; `None` when no proxy is configured.
pub(crate) fn proxied_agent(timeout: Duration) -> Result<Option<ureq::Agent>, String> {
    match proxy_from_env() {
        Some(url) => http_agent(timeout, Some(&url)).map(Some),
        None => Ok(None),
    }
}

/// One GET `<endpoint>/models` with Bearer auth.
///
/// Returns the HTTP status plus the advertised model count when the body was
/// parseable JSON. Transport failures (DNS / connect / timeout) become `Err`;
/// the key never appears in any error text.
fn request_models(
    agent: &ureq::Agent,
    url: &str,
    key: &str,
) -> Result<(u16, Option<usize>), String> {
    let response = agent
        .get(url)
        .set("Authorization", &format!("Bearer {key}"))
        .set("Accept", "application/json")
        .call();
    match response {
        Ok(resp) => {
            let status = resp.status();
            let count = resp
                .into_string()
                .ok()
                .and_then(|body| serde_json::from_str::<serde_json::Value>(&body).ok())
                .and_then(|value| {
                    value
                        .get("data")
                        .and_then(|data| data.as_array())
                        .map(|items| items.len())
                });
            Ok((status, count))
        }
        Err(ureq::Error::Status(code, _)) => Ok((code, None)),
        Err(ureq::Error::Transport(transport)) => Err(transport.to_string()),
    }
}

/// Probe direct first; retry once through the env proxy on transport errors
/// (same resilience rule as the update check, for users behind proxies).
fn run_probe(provider: String, url: String, key: String) -> Result<ProviderTestResult, String> {
    let started = Instant::now();
    let outcome = build_probe_agent(None)
        .and_then(|agent| request_models(&agent, &url, &key))
        .or_else(|direct_err| {
            let proxy_url = proxy_from_env().ok_or_else(|| direct_err.clone())?;
            build_probe_agent(Some(&proxy_url))
                .and_then(|agent| request_models(&agent, &url, &key))
                .map_err(|retry_err| format!("direct: {direct_err}; via proxy: {retry_err}"))
        });

    let latency_ms = started.elapsed().as_millis() as u64;
    match outcome {
        Ok((status, model_count)) => {
            let (ok, detail) = describe_status(status, model_count);
            Ok(ProviderTestResult {
                provider,
                ok,
                latency_ms,
                endpoint: url,
                http_status: Some(status),
                model_count,
                detail,
                asr_model_ok: None,
                asr_note: None,
                embedding_note: None,
            })
        }
        Err(transport_err) => Ok(ProviderTestResult {
            provider,
            ok: false,
            latency_ms,
            endpoint: url,
            http_status: None,
            model_count: None,
            detail: format!("网络错误，无法连接端点：{transport_err}"),
            asr_model_ok: None,
            asr_note: None,
            embedding_note: None,
        }),
    }
}

/// Probe one provider's stored configuration and report whether it works.
///
/// Uses `GET <endpoint>/models` — authenticates the key and validates the
/// Base URL without consuming any tokens. Blocking IO stays on a worker
/// thread; only owned data crosses the boundary.
///
/// For the `asr` provider the check goes one step further to satisfy "key +
/// endpoint + model all work": after the model-list probe it verifies the
/// configured ASR model appears in the advertised list, then makes one real
/// transcription call with a tiny generated WAV (this consumes ASR quota).
#[tauri::command]
pub async fn test_provider_config(
    provider: String,
    db: State<'_, Db>,
    app: AppHandle,
) -> Result<ProviderTestResult, String> {
    let provider = validate_provider(&provider)?;

    // The `asr` slot doubles as the local-whisper switch: when local ASR is
    // enabled the "测试连接" button must exercise the local server instead of
    // the (possibly unconfigured) cloud credential. The stored local config +
    // data dir are read before the worker; the actual server start (which can
    // provision pip deps + download the model on first use) runs in it.
    let local_asr_test: Option<(crate::config::LocalAsrConfig, PathBuf)> = {
        let conn = db
            .conn
            .lock()
            .map_err(|err| format!("failed to acquire database lock: {err}"))?;
        let cfg = crate::config::load(&conn)?;
        if provider == "asr" && cfg.local_asr.enabled {
            let data_dir = db
                .data_dir
                .lock()
                .map(|dir| dir.clone())
                .map_err(|_| "failed to read data dir".to_string())?;
            Some((cfg.local_asr, data_dir))
        } else {
            None
        }
    };

    // Read the stored credential before entering the worker thread. The
    // `embedding` slot falls back to DashScope when left empty (mirroring the
    // ingest client), so "测试连接" reflects what ingestion actually uses.
    let (key, base_url, model, ffmpeg_path) = if local_asr_test.is_some() {
        (String::new(), String::new(), String::new(), None)
    } else {
        read_provider_credential(&provider, &db, &app)?
    };

    let models_url = build_models_url(&base_url, &provider);
    let result = tauri::async_runtime::spawn_blocking(move || {
        if let Some((cfg, data_dir)) = local_asr_test {
            return run_local_asr_test(&cfg, &data_dir);
        }
        // WebSocket ASR has no HTTP `/models` route — skip the generic probe
        // and start neutral; the real-time transcription probe is the verdict.
        let mut outcome = match &models_url {
            Some(url) => run_probe(provider.clone(), url.clone(), key.clone())?,
            None => ProviderTestResult {
                provider: provider.clone(),
                ok: false,
                latency_ms: 0,
                endpoint: base_url.clone(),
                http_status: None,
                model_count: None,
                detail: "WebSocket 端点：以实时转写探测为准".to_string(),
                asr_model_ok: None,
                asr_note: None,
                embedding_note: None,
            },
        };
        if provider == "asr" {
            outcome = run_asr_e2e(outcome, key, base_url, model, ffmpeg_path)?;
        } else if provider == "embedding" {
            outcome = run_embedding_e2e(outcome, key, base_url, model)?;
        }
        Ok::<_, String>(outcome)
    })
    .await
    .map_err(|err| format!("probe task failed: {err}"))??;

    Ok(result)
}

/// Read one provider's stored credential + config for the connectivity probe.
fn read_provider_credential(
    provider: &str,
    db: &State<'_, Db>,
    app: &AppHandle,
) -> Result<(String, String, String, Option<PathBuf>), String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    let (key, base_url) = if provider == "embedding" {
        read_raw_config(&conn, "embedding")?
            .or(read_raw_config(&conn, "dashscope")?)
            .ok_or_else(|| {
                "未配置向量化（Embedding）密钥：请在向量化卡片填写，或先配置 DashScope 密钥"
                    .to_string()
            })?
    } else {
        read_raw_config(&conn, provider)?
            .ok_or_else(|| format!("尚未保存 {provider} 的 API Key，请先保存再测试"))?
    };
    let model = read_model(&conn, provider)?;
    // Only the real-time WebSocket ASR path uses ffmpeg (audio→PCM). A
    // missing binary is non-fatal here: the tiny probe WAV needs no ffmpeg.
    let cfg = crate::config::load(&conn)?;
    let ffmpeg_path =
        crate::ffmpeg::resolve_ffmpeg_path(app, cfg.ffmpeg_path_override.as_deref()).ok();
    Ok((key, base_url, model, ffmpeg_path))
}

/// Test the local whisper server: start it when needed (the first run
/// provisions the embedded-Python deps and downloads the model), report
/// `/health`, and — once the model is ready — run one real tiny transcription
/// through the live endpoint. Blocking; runs inside the probe worker.
fn run_local_asr_test(
    cfg: &crate::config::LocalAsrConfig,
    data_dir: &Path,
) -> Result<ProviderTestResult, String> {
    let started = Instant::now();
    let base = crate::whisper_server::ensure_running(cfg, data_dir)?;
    let health = crate::whisper_server::health_snapshot(cfg.port)?;
    let model = health
        .get("model")
        .and_then(|m| m.as_str())
        .unwrap_or(&cfg.model)
        .to_string();
    let model_ready = health
        .get("modelReady")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let load_error = health
        .get("error")
        .and_then(|v| v.as_str())
        .filter(|e| !e.trim().is_empty())
        .map(str::to_string);

    let mut result = ProviderTestResult {
        provider: "asr".to_string(),
        ok: false,
        latency_ms: started.elapsed().as_millis() as u64,
        endpoint: base.clone(),
        http_status: Some(200),
        model_count: None,
        detail: String::new(),
        asr_model_ok: None,
        asr_note: None,
        embedding_note: None,
    };

    if let Some(err) = load_error {
        result.detail = format!("本地 ASR 服务已启动，但模型加载失败：{err}");
        return Ok(result);
    }
    if !model_ready {
        result.ok = true;
        result.detail = format!(
            "本地 ASR 服务已启动（模型 {model} 仍在后台下载/加载，首次需数分钟；完成后即可入库）"
        );
        return Ok(result);
    }
    // Model ready → one real tiny transcription through the live endpoint.
    let client = crate::asr::AsrClient::with_base_and_ffmpeg(
        "local-whisper".to_string(),
        model.clone(),
        Some(base),
        None,
        None,
    )?;
    match client.probe_transcribe() {
        Ok(note) => {
            result.ok = true;
            result.asr_note = Some(note.clone());
            result.detail = format!("本地 Whisper 运行正常 · 模型 {model} · 真实转写：{note}");
        }
        Err(err) => {
            result.detail = format!("本地 ASR 服务运行中，但转写调用失败：{err}");
        }
    }
    Ok(result)
}

/// Extend the generic models-list probe into a full ASR check: verify the
/// key + endpoint, then make one **real** transcription call with a tiny
/// generated WAV through the configured endpoint + model. Runs inside the
/// worker thread.
fn run_asr_e2e(
    base: ProviderTestResult,
    key: String,
    base_url: String,
    model: String,
    ffmpeg_path: Option<PathBuf>,
) -> Result<ProviderTestResult, String> {
    use crate::asr::{detect_mode, AsrClient, AsrMode};
    let mut result = base;

    let mode = detect_mode(&if base_url.trim().is_empty() {
        crate::asr::resolve_default_base()
    } else {
        base_url.clone()
    });

    // Model-existence check against the advertised `/models` list. This is
    // only meaningful for OpenAI-compatible endpoints: DashScope ASR models
    // (paraformer-*) are served by the audio API and are NOT advertised by
    // the compatible-mode `/models` list, so checking there would yield a
    // misleading false "not found". WebSocket endpoints have no HTTP model
    // list at all. For both we skip the check (asr_model_ok = None).
    let model_ok = if mode == AsrMode::OpenAICompatible {
        match fetch_model_ids(&result.endpoint, &key) {
            Ok(ids) => {
                let exists = model.trim().is_empty() || ids.iter().any(|id| id == &model);
                result.asr_model_ok = Some(exists);
                exists
            }
            Err(_) => {
                // Endpoint may not expose a list; fall through to the live call.
                result.asr_model_ok = None;
                true
            }
        }
    } else {
        result.asr_model_ok = None;
        true
    };

    // Real transcription for every mode: OpenAI-compatible posts a tiny WAV,
    // DashScope routes the tiny WAV through the live real-time Recognition
    // call, and a WebSocket endpoint streams it. A pure tone yields no speech,
    // so "success" means the endpoint accepted a genuine call — not that it
    // recognized words. This consumes ASR quota/billing.
    match AsrClient::with_base_and_ffmpeg(key, model.clone(), Some(base_url), ffmpeg_path, None) {
        Ok(client) => match client.probe_transcribe() {
            Ok(note) => {
                let model_list_part = match mode {
                    AsrMode::DashScope => "DashScope 实时识别 · ".to_string(),
                    AsrMode::WebSocket => "WebSocket 端点（无 HTTP 模型列表）· ".to_string(),
                    AsrMode::OpenAICompatible => match result.model_count {
                        Some(n) => format!("端点返回 {n} 个模型 · "),
                        None => String::new(),
                    },
                };
                // Only OpenAI-compatible reports the model-list check;
                // DashScope/WebSocket have no relevant list to verify against.
                let model_check = if mode == AsrMode::OpenAICompatible {
                    format!(
                        "模型 {} 校验{} · ",
                        if model.trim().is_empty() {
                            "(默认)"
                        } else {
                            &model
                        },
                        if model_ok {
                            "通过"
                        } else {
                            "未找到（仍尝试）"
                        },
                    )
                } else {
                    String::new()
                };
                result.detail =
                    format!("连接成功 · {model_list_part}{model_check}真实转写：{note}");
                result.asr_note = Some(note);
                // A successful real transcription probe confirms the endpoint
                // + key + model all work end-to-end.
                result.ok = true;
            }
            Err(err) => {
                result.ok = false;
                result.asr_note = Some(err.clone());
                result.detail = format!(
                    "端点和密钥可达，但真实转写失败：{err}（模型 {} 可能不可用或不支持音频转写）",
                    model
                );
            }
        },
        Err(err) => {
            result.ok = false;
            result.asr_note = Some(err.clone());
            result.detail = format!("ASR 客户端初始化失败：{err}");
        }
    }

    Ok(result)
}

/// Fetch the raw model id list from an OpenAI-compatible `/models` endpoint.
fn fetch_model_ids(models_url: &str, key: &str) -> Result<Vec<String>, String> {
    let agent = build_probe_agent(None)?;
    let response = agent
        .get(models_url)
        .set("Authorization", &format!("Bearer {key}"))
        .set("Accept", "application/json")
        .call()
        .map_err(|err| format!("查询模型列表失败：{err}"))?;
    let body = response
        .into_string()
        .map_err(|err| format!("读取模型列表失败：{err}"))?;
    let value: serde_json::Value =
        serde_json::from_str(&body).map_err(|err| format!("解析模型列表失败：{err}"))?;
    let ids = value
        .get("data")
        .and_then(|d| d.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("id").and_then(|v| v.as_str()))
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default();
    Ok(ids)
}

/// Extend the generic models-list probe into a full embedding check: make
/// one real embedding call with a tiny text through the configured endpoint
/// + model. This catches the "test passed but ingest 404" case — endpoints
/// where `GET /models` works but `POST {base}/embeddings` is missing or the
/// configured model is not usable for embedding. Consumes a trivial amount
/// of embedding quota (one short string).
fn run_embedding_e2e(
    base: ProviderTestResult,
    key: String,
    base_url: String,
    model: String,
) -> Result<ProviderTestResult, String> {
    let mut result = base;
    let effective_base = if base_url.trim().is_empty() {
        default_endpoint("embedding").to_string()
    } else {
        base_url.clone()
    };
    match crate::embeddings::probe_embedding(&effective_base, &key, &model) {
        Ok(note) => {
            result.ok = true;
            result.embedding_note = Some(note.clone());
            result.detail = format!("连接成功 · 端点可达 · {note}");
        }
        Err(err) => {
            result.ok = false;
            result.embedding_note = Some(err.clone());
            result.detail = format!(
                "端点和密钥可达（/models 正常），但真实向量化调用失败：{err}。请检查向量化 Base URL 是否指向 OpenAI 兼容的 Embedding 端点、模型是否为该端点支持的 Embedding 模型"
            );
        }
    }
    Ok(result)
}

/// Insert or update one provider's full configuration (parameterized SQL).
///
/// `key` semantics: `Some(validated)` stores it, `None` keeps whatever is
/// already stored (config-only edits must not erase the credential).
fn upsert_config(
    conn: &Connection,
    provider: &str,
    key: Option<&str>,
    base_url: &str,
    model: &str,
) -> Result<(), String> {
    let affected = conn
        .execute(
            "INSERT INTO api_keys(provider, api_key, base_url, model, updated_at)
             VALUES(?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(provider) DO UPDATE SET
                 base_url = excluded.base_url,
                 model = excluded.model,
                 updated_at = excluded.updated_at,
                 api_key = CASE
                     WHEN excluded.api_key = '' THEN api_keys.api_key
                     ELSE excluded.api_key
                 END",
            params![provider, key.unwrap_or(""), base_url, model, unix_now()],
        )
        .map_err(|err| format!("failed to store provider config: {err}"))?;
    if affected == 0 {
        return Err("provider config persistence affected no rows".to_string());
    }
    Ok(())
}

/// Return every provider's non-secret configuration status.
#[tauri::command]
pub fn list_api_keys(db: State<'_, Db>) -> Result<Vec<ProviderStatus>, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    list_statuses(&conn)
}

/// Store one provider's full configuration; returns refreshed statuses.
///
/// `key` empty = keep the stored credential (config-only edit);
/// `base_url` / `model` empty = fall back to provider defaults.
#[tauri::command]
pub fn set_default_provider(
    provider: Option<String>,
    db: State<'_, Db>,
) -> Result<Vec<ProviderStatus>, String> {
    // 仅对话类提供方可设为默认；None = 清除默认（回到自动优先级链）。
    const CHAT_PROVIDERS: [&str; 3] = ["dashscope", "deepseek", "openrouter"];
    let normalized = match provider.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(value) => {
            let lowered = value.to_ascii_lowercase();
            if !CHAT_PROVIDERS.contains(&lowered.as_str()) {
                return Err(format!(
                    "只能将对话类提供方设为默认（可选：{}）",
                    CHAT_PROVIDERS.join(" / ")
                ));
            }
            Some(lowered)
        }
    };
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    let mut config = crate::config::load(&conn)?;
    config.default_chat_provider = normalized;
    crate::config::save(&conn, &config)?;
    list_statuses(&conn)
}

///
/// `key` empty = keep the stored credential (config-only edit);
/// `base_url` / `model` empty = fall back to provider defaults.
#[tauri::command]
pub fn save_provider_config(
    provider: String,
    key: String,
    base_url: String,
    model: String,
    db: State<'_, Db>,
) -> Result<Vec<ProviderStatus>, String> {
    let provider = validate_provider(&provider)?;
    let base_url = validate_base_url(&base_url)?;
    let model = validate_model(&model)?;

    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;

    // Validate the key only when one was supplied; an empty key means the
    // stored one (if any) is kept, so it must never be overwritten with ''.
    let key = if key.trim().is_empty() {
        None
    } else {
        Some(validate_secret(&key)?)
    };

    upsert_config(&conn, &provider, key.as_deref(), &base_url, &model)?;
    list_statuses(&conn)
}

/// Clear one provider's stored key, keeping base URL / model; idempotent.
#[tauri::command]
pub fn clear_provider_key(
    provider: String,
    db: State<'_, Db>,
) -> Result<Vec<ProviderStatus>, String> {
    let provider = validate_provider(&provider)?;

    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    conn.execute(
        "UPDATE api_keys SET api_key = '', updated_at = ?2 WHERE provider = ?1",
        params![provider, unix_now()],
    )
    .map_err(|err| format!("failed to clear api key: {err}"))?;
    list_statuses(&conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mask_keeps_head_and_tail_for_long_keys() {
        assert_eq!(mask_key("sk-abcdef1234567890wxyz"), "sk-…wxyz");
    }

    #[test]
    fn mask_hides_short_keys_entirely() {
        assert_eq!(mask_key("short"), "*****");
        assert_eq!(mask_key("12345678"), "********");
    }

    #[test]
    fn provider_allowlist_normalizes_case_and_space() {
        assert_eq!(
            validate_provider(" DashScope "),
            Ok("dashscope".to_string())
        );
        assert_eq!(
            validate_provider("OPENROUTER"),
            Ok("openrouter".to_string())
        );
    }

    #[test]
    fn provider_allowlist_rejects_unknown() {
        assert!(validate_provider("anthropic").is_err());
        assert!(validate_provider("").is_err());
        assert!(validate_provider("dashscope; DROP TABLE api_keys").is_err());
    }

    #[test]
    fn secret_validation_trims_and_accepts_typical_keys() {
        assert_eq!(
            validate_secret("  sk-test-1234567890  "),
            Ok("sk-test-1234567890".to_string())
        );
    }

    #[test]
    fn secret_validation_rejects_oversized_and_control_chars() {
        let oversized = "k".repeat(MAX_KEY_LEN + 1);
        assert!(validate_secret(&oversized).is_err());
        assert!(validate_secret("bad\nkey").is_err());
    }

    #[test]
    fn base_url_accepts_https_and_empty() {
        assert_eq!(
            validate_base_url(" https://dashscope.example/v1 "),
            Ok("https://dashscope.example/v1".to_string())
        );
        assert_eq!(validate_base_url("   "), Ok(String::new()));
    }

    #[test]
    fn base_url_rejects_non_http_and_whitespace() {
        assert!(validate_base_url("ftp://x").is_err());
        assert!(validate_base_url("dashscope.example.com").is_err());
        assert!(validate_base_url("https://a b").is_err());
    }

    #[test]
    fn model_accepts_common_identifiers_and_empty() {
        assert_eq!(validate_model(" qwen-max "), Ok("qwen-max".to_string()));
        assert_eq!(
            validate_model("openai/gpt-4o"),
            Ok("openai/gpt-4o".to_string())
        );
        assert_eq!(validate_model(""), Ok(String::new()));
    }

    #[test]
    fn model_rejects_bad_chars_and_oversize() {
        assert!(validate_model("bad model!").is_err());
        let oversized = "m".repeat(MAX_MODEL_LEN + 1);
        assert!(validate_model(&oversized).is_err());
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

    #[test]
    fn status_classification_covers_common_cases() {
        let (ok, _) = describe_status(200, Some(42));
        assert!(ok);
        assert!(!describe_status(401, None).0);
        assert!(!describe_status(403, None).0);
        assert!(!describe_status(404, None).0);
        assert!(!describe_status(503, None).0);
    }

    #[test]
    fn config_roundtrip_keeps_key_on_config_only_save() {
        let conn = Connection::open_in_memory().expect("in-memory db");
        conn.execute_batch(crate::db::SCHEMA_SQL).expect("schema");

        upsert_config(
            &conn,
            "dashscope",
            Some("sk-abcdef1234567890"),
            "",
            "qwen-max",
        )
        .expect("initial save");
        // Config-only edit: key=None must keep the stored credential.
        upsert_config(
            &conn,
            "dashscope",
            None,
            "https://proxy.local/v1",
            "qwen-plus",
        )
        .expect("config-only save");

        let status = read_status(&conn, "dashscope").expect("read back");
        assert!(status.has_key, "key must survive a config-only save");
        assert_eq!(status.masked_key.as_deref(), Some("sk-…7890"));
        assert_eq!(status.base_url, "https://proxy.local/v1");
        assert_eq!(status.model, "qwen-plus");
    }

    #[test]
    fn config_roundtrip_missing_row_reads_as_defaults() {
        let conn = Connection::open_in_memory().expect("in-memory db");
        conn.execute_batch(crate::db::SCHEMA_SQL).expect("schema");
        let status = read_status(&conn, "openrouter").expect("read back");
        assert!(!status.has_key);
        assert_eq!(status.masked_key, None);
        assert_eq!(status.base_url, "");
        assert_eq!(status.model, "");
        assert_eq!(status.updated_at, None);
    }
}
