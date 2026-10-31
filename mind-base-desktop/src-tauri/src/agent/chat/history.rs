//! Message persistence helpers + the `chat_history` query command.

use rusqlite::{params, Connection};
use tauri::State;

use super::types::{now_secs, usage_from_json, usage_to_json, ChatMessageRow, ChatSource};
use crate::infra::db::Db;
use crate::llm::client::{ChatMessage, TokenUsage};

pub(super) fn insert_message_conn(
    conn: &Connection,
    msg_id: &str,
    session_id: &str,
    role: &str,
    content: &str,
    status: &str,
    model: &str,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO chat_messages(msg_id, chat_session_id, role, content, status, sources, model, created_at)
         VALUES(?1, ?2, ?3, ?4, ?5, '[]', ?6, ?7)",
        params![msg_id, session_id, role, content, status, model, now_secs()],
    )
    .map_err(|err| format!("failed to save message: {err}"))?;
    Ok(())
}

pub(super) fn fail_assistant_message_conn(conn: &Connection, msg_id: &str, error: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE chat_messages SET status = 'failed', error = ?2 WHERE msg_id = ?1",
        params![msg_id, error],
    )
    .map_err(|err| format!("failed to mark message failed: {err}"))?;
    Ok(())
}

/// Last `limit` completed messages of a session, oldest first.
pub(super) fn recent_history_conn(
    conn: &Connection,
    session_id: &str,
    limit: usize,
) -> Result<Vec<ChatMessage>, String> {
    let mut statement = conn
        .prepare(
            "SELECT role, content FROM (
                 SELECT role, content, created_at FROM chat_messages
                 WHERE chat_session_id = ?1 AND status = 'completed'
                 ORDER BY created_at DESC LIMIT ?2
             ) ORDER BY created_at ASC",
        )
        .map_err(|err| format!("failed to read history: {err}"))?;
    let rows = statement
        .query_map(params![session_id, limit as i64], |row| {
            Ok(ChatMessage::new(
                row.get::<_, String>(0)?.as_str(),
                row.get::<_, String>(1)?,
            ))
        })
        .map_err(|err| format!("failed to query history: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("failed to map history: {err}"))
}

#[tauri::command]
pub fn chat_history(db: State<'_, Db>, session_id: String) -> Result<Vec<ChatMessageRow>, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    let mut statement = conn
        .prepare(
            "SELECT msg_id, chat_session_id, role, content, status, sources, model, error, created_at, usage
             FROM chat_messages WHERE chat_session_id = ?1 ORDER BY created_at ASC",
        )
        .map_err(|err| format!("failed to load history: {err}"))?;
    let rows = statement
        .query_map(params![session_id], |row| {
            let sources_raw: String = row.get(5)?;
            let usage_raw: String = row.get(9)?;
            Ok(ChatMessageRow {
                msg_id: row.get(0)?,
                chat_session_id: row.get(1)?,
                role: row.get(2)?,
                content: row.get(3)?,
                status: row.get(4)?,
                sources: serde_json::from_str(&sources_raw).unwrap_or(serde_json::json!([])),
                model: row.get(6)?,
                error: row.get(7)?,
                created_at: row.get(8)?,
                usage: usage_from_json(&usage_raw),
            })
        })
        .map_err(|err| format!("failed to query history: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("failed to read history: {err}"))
}

/// Persist the completed assistant message (content + sources JSON + model
/// + aggregated token usage JSON).
pub(super) fn complete_assistant_message_tx(
    conn: &Connection,
    msg_id: &str,
    content: &str,
    sources: &[ChatSource],
    model: &str,
    usage: Option<TokenUsage>,
) -> Result<(), String> {
    let sources_json = serde_json::to_string(sources).unwrap_or_else(|_| "[]".to_string());
    let usage_json = usage_to_json(usage);
    conn.execute(
        "UPDATE chat_messages SET status = 'completed', content = ?2, sources = ?3, model = ?4,
             usage = ?5
         WHERE msg_id = ?1",
        params![msg_id, content, sources_json, model, usage_json],
    )
    .map_err(|err| format!("failed to complete message: {err}"))?;
    // Ledger: one row per completed turn, tagged with session/model (DSH-style stats).
    if let Some(usage) = usage {
        let session_id: String = conn
            .query_row(
                "SELECT chat_session_id FROM chat_messages WHERE msg_id = ?1",
                params![msg_id],
                |row| row.get(0),
            )
            .unwrap_or_default();
        let _ = crate::infra::usage::record(conn, &session_id, "chat", model, usage, None);
    }
    Ok(())
}
