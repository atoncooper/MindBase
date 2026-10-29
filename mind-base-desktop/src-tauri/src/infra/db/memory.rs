//! Per-session memory window persistence and cascade deletion.

use rusqlite::{params, Connection, OptionalExtension};

/// Delete one chat session and every memory layer bound to it (plan/
/// 1.0.10-AgentMemory §8.5): transcript, summaries, summary documents and
/// blackboard findings must not outlive their session as orphans.
pub(crate) fn delete_session_cascade(conn: &Connection, session_id: &str) -> Result<(), String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|err| format!("failed to begin transaction: {err}"))?;
    for (table, column) in [
        ("chat_messages", "chat_session_id"),
        ("session_summaries", "session_id"),
        ("session_summary_docs", "session_id"),
        ("session_findings", "session_id"),
        ("memory_windows", "session_id"),
    ] {
        tx.execute(
            &format!("DELETE FROM {table} WHERE {column} = ?1"),
            rusqlite::params![session_id],
        )
        .map_err(|err| format!("failed to delete from {table}: {err}"))?;
    }
    tx.execute(
        "DELETE FROM chat_sessions WHERE chat_session_id = ?1",
        rusqlite::params![session_id],
    )
    .map_err(|err| format!("failed to delete chat session: {err}"))?;
    tx.commit()
        .map_err(|err| format!("failed to commit delete: {err}"))
}

/// Max entries in the memory agent's per-session retrieval window.
pub(crate) const MEMORY_WINDOW_MAX: usize = 30;

/// Load the memory agent's retrieval window for a session (empty when
/// absent — the window now lives in SQLite and survives restarts).
pub(crate) fn load_memory_window(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<crate::agent::agents::SearchWindowEntry>, String> {
    let stored: Option<String> = conn
        .query_row(
            "SELECT entries FROM memory_windows WHERE session_id = ?1",
            params![session_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| format!("failed to read memory window: {err}"))?;
    match stored {
        Some(payload) => {
            serde_json::from_str(&payload).map_err(|err| format!("memory window is corrupt: {err}"))
        }
        None => Ok(Vec::new()),
    }
}

/// Append one entry to the window (LRU-capped) and persist it.
pub(crate) fn append_memory_window(
    conn: &Connection,
    session_id: &str,
    entry: crate::agent::agents::SearchWindowEntry,
) -> Result<(), String> {
    let mut entries = load_memory_window(conn, session_id)?;
    entries.push(entry);
    if entries.len() > MEMORY_WINDOW_MAX {
        let overflow = entries.len() - MEMORY_WINDOW_MAX;
        entries.drain(0..overflow);
    }
    let payload = serde_json::to_string(&entries)
        .map_err(|err| format!("failed to serialize memory window: {err}"))?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    conn.execute(
        "INSERT INTO memory_windows(session_id, entries, updated_at) VALUES(?1, ?2, ?3)
         ON CONFLICT(session_id) DO UPDATE SET entries = excluded.entries,
         updated_at = excluded.updated_at",
        params![session_id, payload, now],
    )
    .map_err(|err| format!("failed to persist memory window: {err}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::infra::db::SCHEMA_SQL;

    #[test]
    fn session_delete_cascades_every_memory_layer() {
        let conn = Connection::open_in_memory().expect("in-memory db");
        conn.execute_batch(SCHEMA_SQL).expect("schema");
        let now: i64 = 1_700_000_000;
        conn.execute(
            "INSERT INTO chat_sessions(chat_session_id, title, status, created_at, updated_at)
             VALUES('s1', 't', 'active', ?1, ?1)",
            rusqlite::params![now],
        )
        .expect("session");
        for table in [
            "chat_messages",
            "session_summaries",
            "session_summary_docs",
            "session_findings",
        ] {
            let sql = match table {
                "chat_messages" => format!(
                    "INSERT INTO {table}(msg_id, chat_session_id, role, content, status, created_at)
                     VALUES('m1', 's1', 'user', 'hi', 'completed', {now})"
                ),
                "session_findings" => format!(
                    "INSERT INTO {table}(session_id, agent, topic, finding, created_at)
                     VALUES('s1', 'code', 'topic', 'finding', {now})"
                ),
                "session_summaries" => format!(
                    "INSERT INTO {table}(session_id, summary, kept_count, compressed_count, updated_at)
                     VALUES('s1', 's', 0, 0, {now})"
                ),
                _ => format!(
                    "INSERT INTO {table}(session_id, content, message_count, created_at)
                     VALUES('s1', 'doc', 1, {now})"
                ),
            };
            conn.execute(&sql, [])
                .unwrap_or_else(|err| panic!("{table}: {err}"));
        }

        delete_session_cascade(&conn, "s1").expect("cascade");

        for table in [
            "chat_sessions",
            "chat_messages",
            "session_summaries",
            "session_summary_docs",
            "session_findings",
        ] {
            let count: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .expect("count");
            assert_eq!(count, 0, "{table} must be emptied by cascade delete");
        }
    }
}
