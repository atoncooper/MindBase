//! Shared helpers for tool implementations: spec construction, DB-lock errors, optional args, timestamps.

use serde_json::Value;

use super::super::registry::ToolSpec;

pub(super) fn spec(name: &'static str, description: &str, parameters: Value) -> ToolSpec {
    ToolSpec {
        name,
        description: description.to_string(),
        parameters,
    }
}

pub(super) fn lock_err(
    err: std::sync::PoisonError<std::sync::MutexGuard<'_, rusqlite::Connection>>,
) -> String {
    format!("failed to acquire database lock: {err}")
}

/// Read an optional integer argument without failing when absent.
pub(super) fn optional_int(arguments: &str, name: &str) -> Option<i64> {
    let value: Value = serde_json::from_str(arguments).ok()?;
    value.get(name).and_then(|v| v.as_i64())
}

/// Read an optional string argument without failing when absent.
pub(super) fn optional_str(arguments: &str, name: &str) -> Option<String> {
    let value: Value = serde_json::from_str(arguments).ok()?;
    value
        .get(name)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

pub(super) fn now_secs_helper() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|delta| delta.as_secs() as i64)
        .unwrap_or_default()
}
