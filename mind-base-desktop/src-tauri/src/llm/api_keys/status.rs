//! Non-secret provider status rows, config persistence and the settings-page commands.

use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::State;

use crate::infra::db::Db;

use super::validation::{mask_key, validate_base_url, validate_model, validate_provider, validate_secret};

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
    let default_provider = crate::infra::config::load(conn)?.default_chat_provider;
    crate::llm::ai_providers::PROVIDERS
        .iter()
        .map(|entry| {
            let mut status = read_status(conn, entry.id)?;
            status.is_default = default_provider.as_deref() == Some(entry.id);
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
    let chat_ids: Vec<&str> = crate::llm::ai_providers::chat_ids().collect();
    let normalized = match provider.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(value) => {
            let lowered = value.to_ascii_lowercase();
            if !chat_ids.contains(&lowered.as_str()) {
                return Err(format!(
                    "只能将对话类提供方设为默认（可选：{}）",
                    chat_ids.join(" / ")
                ));
            }
            Some(lowered)
        }
    };
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    let mut config = crate::infra::config::load(&conn)?;
    config.default_chat_provider = normalized;
    crate::infra::config::save(&conn, &config)?;
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
    fn config_roundtrip_keeps_key_on_config_only_save() {
        let conn = Connection::open_in_memory().expect("in-memory db");
        conn.execute_batch(crate::infra::db::SCHEMA_SQL).expect("schema");

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
        conn.execute_batch(crate::infra::db::SCHEMA_SQL).expect("schema");
        let status = read_status(&conn, "openrouter").expect("read back");
        assert!(!status.has_key);
        assert_eq!(status.masked_key, None);
        assert_eq!(status.base_url, "");
        assert_eq!(status.model, "");
        assert_eq!(status.updated_at, None);
    }
}
