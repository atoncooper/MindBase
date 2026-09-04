//! Application configuration persisted in SQLite.
//!
//! The whole config is stored as a single JSON document in the `app_config`
//! table under key `'app'`. Every field carries its own serde default so that
//! rows written by older builds (or missing fields) still deserialize into a
//! fully populated struct — forward compatible when new fields are added.
//!
//! # Corruption self-healing
//!
//! This is a distributed desktop app running on end-user machines where there
//! is no operator to repair a broken data file, so startup must self-heal:
//! when the stored JSON cannot be deserialized, [`load`] logs a warning and
//! returns [`AppConfig::default`] instead of failing every command. The bad
//! row is deliberately NOT overwritten at read time — the next `set_config`
//! persists a fresh document and repairs the store naturally.

use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::Db;

/// Row key that holds the serialized config document.
const CONFIG_KEY: &str = "app";

fn default_theme() -> String {
    "system".to_string()
}

fn default_language() -> String {
    "zh-CN".to_string()
}

fn default_auto_check_updates() -> bool {
    true
}

fn default_update_repo() -> String {
    "atoncooper/MindBase".to_string()
}

/// Whether `c` may appear inside a GitHub repository slug segment
/// (`owner` or `name`).
fn is_repo_slug_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-')
}

/// Validate the GitHub repository slug (`owner/name`) used for update checks.
///
/// Implements `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$` (exactly one separator,
/// both segments non-empty, restricted character set) without pulling in a
/// regex engine — the release profile is size-optimized, so a hand-rolled
/// check is preferred over a new dependency. This is the single source of
/// truth for the rule: enforced here on every write and reused by
/// `updater.rs` before any network request is built from the value.
///
/// Returns the trimmed slug on success.
pub fn validate_update_repo(repo: &str) -> Result<String, String> {
    let trimmed = repo.trim();
    let valid = match trimmed.split_once('/') {
        // `split_once` already guarantees at most one '/' in `name`.
        Some((owner, name)) => {
            !owner.is_empty()
                && !name.is_empty()
                && owner.chars().all(is_repo_slug_char)
                && name.chars().all(is_repo_slug_char)
        }
        None => false,
    };
    if !valid {
        return Err(format!(
            "更新仓库地址无效：{repo:?}。正确格式为 owner/name（仅含字母、数字、下划线、点、连字符），例如 atoncooper/MindBase"
        ));
    }
    Ok(trimmed.to_string())
}

/// Local ASR settings: the desktop app auto-spawns and manages a local
/// OpenAI-compatible whisper server (`scripts/whisper_server.py` under the
/// embedded Python) instead of calling a remote provider. `enabled=false`
/// (default) keeps the cloud path. The server port and model are the only
/// knobs users normally touch; the whisper weights auto-download into
/// `<data_dir>/whisper-models` on first use.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LocalAsrConfig {
    /// When true, ingestion routes ASR to the local whisper server (and the
    /// server is warmed up at app startup).
    pub enabled: bool,
    /// The command (path or name) used to launch the server.
    ///
    /// Legacy field kept for backward compatibility of stored configs; the
    /// server now always runs under the app's embedded Python, so this value
    /// is no longer consumed.
    pub command: String,
    /// Port the server listens on. A server already serving on this port is
    /// reused; otherwise the app spawns one and shuts it down on exit.
    pub port: u16,
    /// Whisper model id passed via `--model` (e.g. `small`, `medium`).
    pub model: String,
    /// Extra arguments appended to the launch command (joined with spaces,
    /// split on whitespace). Empty = only the standard flags are passed.
    pub extra_args: String,
    /// Hard wall-clock cap for waiting on server readiness (seconds).
    pub ready_timeout_secs: u64,
}

impl Default for LocalAsrConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            command: String::new(),
            port: 8765,
            model: "small".to_string(),
            extra_args: String::new(),
            ready_timeout_secs: 300,
        }
    }
}

/// Local OCR settings. Mirrors the local-ASR block: when enabled, text
/// recognition (images / screenshots / PDF pages) routes to a locally
/// provisioned RapidOCR (PP-OCRv4 ONNX) pipeline instead of a cloud
/// provider. The model bundle is downloaded via the `local_ocr_model_*`
/// commands into `<data_dir>/ocr-models/<bundle>`; the inference wiring is
/// delivered separately, the block exists so stored configs already carry it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LocalOcrConfig {
    /// When true, OCR workloads prefer the local model over the cloud slot.
    pub enabled: bool,
    /// Model bundle id (see `ocr_server::KNOWN_MODELS`, default `pp-ocrv4-mobile`).
    pub model: String,
    /// Extra arguments reserved for the future OCR pipeline launch.
    pub extra_args: String,
    /// Compute device for the future OCR runtime: `auto` (prefer GPU when
    /// detected, fall back CPU), `cpu`, or `cuda` (NVIDIA, requires
    /// onnxruntime-gpu + CUDA/cuDNN; runtime falls back when unavailable).
    pub device: String,
    /// Wall-clock cap for waiting on pipeline readiness (seconds).
    pub ready_timeout_secs: u64,
}

impl Default for LocalOcrConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            model: "pp-ocrv4-mobile".to_string(),
            extra_args: String::new(),
            device: "auto".to_string(),
            ready_timeout_secs: 300,
        }
    }
}

/// Typed application configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default = "default_language")]
    pub language: String,
    #[serde(default = "default_auto_check_updates")]
    pub auto_check_updates: bool,
    #[serde(default = "default_update_repo")]
    pub update_repo: String,
    #[serde(default)]
    pub ffmpeg_path_override: Option<String>,
    /// 对话默认提供方（"dashscope" | "deepseek" | "openrouter"）；
    /// None = 按内置优先级链自动选择。缺省反序列化为 None，因此
    /// 取消默认（写回 None）后字段省略也能正确读回。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_chat_provider: Option<String>,
    /// 本地 faster-whisper-server 设置（方案 A）。缺省反序列化为默认值。
    #[serde(default)]
    pub local_asr: LocalAsrConfig,
    /// 本地 OCR（RapidOCR / PP-OCRv4）设置。缺省反序列化为默认值。
    #[serde(default)]
    pub local_ocr: LocalOcrConfig,
    /// 媒体缓存（下载的音频/视频 + 抽出的 WAV）LRU 配额上限，单位 MB。
    /// 0 = 禁用清理。每次入库结束后按文件 mtime 从旧到新删除直到总量达标。
    #[serde(default = "default_media_cache_max_mb")]
    pub media_cache_max_mb: u32,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            theme: default_theme(),
            language: default_language(),
            auto_check_updates: default_auto_check_updates(),
            update_repo: default_update_repo(),
            ffmpeg_path_override: None,
            default_chat_provider: None,
            local_asr: LocalAsrConfig::default(),
            local_ocr: LocalOcrConfig::default(),
            media_cache_max_mb: default_media_cache_max_mb(),
        }
    }
}

/// Default media-cache quota: 2 GiB, enough to inspect several recent runs.
fn default_media_cache_max_mb() -> u32 {
    2048
}

/// Read the raw JSON payload stored under [`CONFIG_KEY`], if any.
fn read_stored_payload(conn: &rusqlite::Connection) -> Result<Option<String>, String> {
    let result = conn.query_row(
        "SELECT value FROM app_config WHERE key = ?1",
        params![CONFIG_KEY],
        |row| row.get::<_, String>(0),
    );
    match result {
        Ok(payload) => Ok(Some(payload)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(err) => Err(format!("failed to read config row: {err}")),
    }
}

/// Load the config, falling back to defaults per field when the row is absent.
///
/// A malformed stored document degrades to defaults with a logged warning
/// rather than failing the caller (see the module docs on self-healing).
/// Real database errors still propagate as `Err`.
pub fn load(conn: &rusqlite::Connection) -> Result<AppConfig, String> {
    match read_stored_payload(conn)? {
        Some(payload) => Ok(
            serde_json::from_str::<AppConfig>(&payload).unwrap_or_else(|err| {
                eprintln!(
                    "[config] stored config is invalid ({err}); using defaults until next save"
                );
                AppConfig::default()
            }),
        ),
        None => Ok(AppConfig::default()),
    }
}

/// Persist the config as one JSON document (insert or overwrite).
pub fn save(conn: &rusqlite::Connection, config: &AppConfig) -> Result<(), String> {
    let payload = serde_json::to_string(config)
        .map_err(|err| format!("failed to serialize config: {err}"))?;
    let affected = conn
        .execute(
            "INSERT INTO app_config(key, value) VALUES(?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![CONFIG_KEY, payload],
        )
        .map_err(|err| format!("failed to persist config: {err}"))?;
    if affected == 0 {
        return Err("config persistence affected no rows".to_string());
    }
    Ok(())
}

/// Normalize the local ASR block: a model set to the legacy cloud-style
/// default (`large-v3`, unusably slow on CPU) moves to `small`, an unset
/// model/port fall back to their defaults, and the legacy `command` field is
/// dropped (the server runs under the embedded Python).
fn normalize_local_asr(mut local_asr: LocalAsrConfig) -> LocalAsrConfig {
    local_asr.command = String::new();
    if local_asr.model.trim().is_empty() || local_asr.model.trim() == "large-v3" {
        local_asr.model = LocalAsrConfig::default().model;
    }
    if local_asr.port == 0 {
        local_asr.port = LocalAsrConfig::default().port;
    }
    if local_asr.ready_timeout_secs == 0 {
        local_asr.ready_timeout_secs = LocalAsrConfig::default().ready_timeout_secs;
    }
    local_asr
}

/// Normalize the local OCR block: an unknown/empty bundle id falls back to
/// the default, an unknown/empty device to `auto`, and a zero readiness
/// timeout to 300s.
fn normalize_local_ocr(mut local_ocr: LocalOcrConfig) -> LocalOcrConfig {
    let known = crate::ocr_server::KNOWN_MODELS
        .iter()
        .any(|(id, _, _, _)| *id == local_ocr.model);
    if local_ocr.model.trim().is_empty() || !known {
        local_ocr.model = LocalOcrConfig::default().model;
    }
    let device = local_ocr.device.trim().to_ascii_lowercase();
    if !matches!(device.as_str(), "auto" | "cpu" | "cuda") {
        local_ocr.device = LocalOcrConfig::default().device;
    } else {
        local_ocr.device = device;
    }
    if local_ocr.ready_timeout_secs == 0 {
        local_ocr.ready_timeout_secs = LocalOcrConfig::default().ready_timeout_secs;
    }
    local_ocr
}

/// Return the current application configuration.
#[tauri::command]
pub fn get_config(db: State<'_, Db>) -> Result<AppConfig, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    load(&conn)
}

/// Persist the provided config and return the stored value.
#[tauri::command]
pub fn set_config(config: AppConfig, db: State<'_, Db>) -> Result<AppConfig, String> {
    // Reject invalid repository slugs before anything touches the database;
    // the validated (trimmed) value is what gets stored.
    let update_repo = validate_update_repo(&config.update_repo)?;
    let config = AppConfig {
        update_repo,
        local_asr: normalize_local_asr(config.local_asr),
        local_ocr: normalize_local_ocr(config.local_ocr),
        ..config
    };
    crate::logging::info(
        "config",
        &format!(
            "[diag] set_config received local_asr.enabled={} port={} model={}",
            config.local_asr.enabled, config.local_asr.port, config.local_asr.model
        ),
    );

    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    save(&conn, &config)?;
    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_asr_defaults_are_cpu_friendly() {
        let cfg = LocalAsrConfig::default();
        assert!(!cfg.enabled);
        assert_eq!(cfg.port, 8765);
        assert_eq!(cfg.model, "small");
        // The legacy launcher command is empty: the server runs under the
        // embedded Python, not a user-installed binary.
        assert!(cfg.command.is_empty());
    }

    #[test]
    fn normalize_resets_legacy_command_and_bad_values() {
        // Legacy config (old default command + large-v3 + port 8000).
        let legacy = LocalAsrConfig {
            enabled: true,
            command: "faster-whisper-server".to_string(),
            port: 8000,
            model: "large-v3".to_string(),
            extra_args: String::new(),
            ready_timeout_secs: 0,
        };
        let normalized = normalize_local_asr(legacy);
        assert!(normalized.command.is_empty());
        // Port 8000 is legal (kept); only zero falls back.
        assert_eq!(normalized.port, 8000);
        // The CPU-unfriendly large-v3 default moves to small.
        assert_eq!(normalized.model, "small");
        assert_eq!(normalized.ready_timeout_secs, 300);

        let unset = LocalAsrConfig {
            enabled: false,
            command: String::new(),
            port: 0,
            model: "  ".to_string(),
            extra_args: String::new(),
            ready_timeout_secs: 0,
        };
        let normalized = normalize_local_asr(unset);
        assert_eq!(normalized.port, 8765);
        assert_eq!(normalized.model, "small");
        assert_eq!(normalized.ready_timeout_secs, 300);
    }

    #[test]
    fn normalize_keeps_explicit_choices() {
        let explicit = LocalAsrConfig {
            enabled: true,
            command: "ignored".to_string(),
            port: 9100,
            model: "medium".to_string(),
            extra_args: "--device cpu".to_string(),
            ready_timeout_secs: 120,
        };
        let normalized = normalize_local_asr(explicit);
        assert_eq!(normalized.port, 9100);
        assert_eq!(normalized.model, "medium");
        assert_eq!(normalized.ready_timeout_secs, 120);
        assert_eq!(normalized.extra_args, "--device cpu");
    }

    #[test]
    fn local_ocr_defaults_and_normalization() {
        let cfg = LocalOcrConfig::default();
        assert!(!cfg.enabled);
        assert_eq!(cfg.model, "pp-ocrv4-mobile");
        assert_eq!(cfg.ready_timeout_secs, 300);

        // Unknown bundle ids fall back to the default (guards against stale
        // stored configs pointing at a removed model).
        let unknown = normalize_local_ocr(LocalOcrConfig {
            enabled: true,
            model: "pp-ocrv9".to_string(),
            extra_args: String::new(),
            device: "auto".to_string(),
            ready_timeout_secs: 0,
        });
        assert_eq!(unknown.model, "pp-ocrv4-mobile");
        assert_eq!(unknown.ready_timeout_secs, 300);

        // A known bundle id is kept as-is.
        let known = normalize_local_ocr(LocalOcrConfig {
            model: "pp-ocrv4-server".to_string(),
            ..LocalOcrConfig::default()
        });
        assert_eq!(known.model, "pp-ocrv4-server");

        // Device normalizes: empty/unknown → auto, known values kept (trimmed,
        // lowercased).
        for (raw, expected) in [("", "auto"), ("CUDA", "cuda"), ("  cpu  ", "cpu"), ("tpu", "auto")] {
            let got = normalize_local_ocr(LocalOcrConfig {
                device: raw.to_string(),
                ..LocalOcrConfig::default()
            });
            assert_eq!(got.device, expected, "device {raw:?}");
        }
    }
}
