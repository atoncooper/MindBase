//! Additive column and data migrations for databases created by older builds.

use rusqlite::Connection;

/// Additive column migrations for databases created by older builds.
///
/// `ALTER TABLE … ADD COLUMN` fails once the column exists, so each statement
/// runs on its own and "duplicate column" failures are silently accepted —
/// that error *is* the success state for an already-migrated database.
/// Anything else is logged but never fatal (startup must self-heal).
const COLUMN_MIGRATIONS: [&str; 6] = [
    "ALTER TABLE api_keys ADD COLUMN base_url TEXT NOT NULL DEFAULT '';",
    "ALTER TABLE api_keys ADD COLUMN model TEXT NOT NULL DEFAULT '';",
    "ALTER TABLE documents ADD COLUMN source_type TEXT NOT NULL DEFAULT 'video';",
    "ALTER TABLE documents ADD COLUMN file_path TEXT NOT NULL DEFAULT '';",
    "ALTER TABLE documents ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';",
    "ALTER TABLE mind_maps ADD COLUMN kind TEXT NOT NULL DEFAULT 'mindmap';",
];

/// Apply [`COLUMN_MIGRATIONS`], tolerating already-applied ones.
pub(super) fn run_column_migrations(conn: &Connection) {
    for statement in COLUMN_MIGRATIONS {
        if let Err(err) = conn.execute_batch(statement) {
            let text = err.to_string();
            if text.contains("duplicate column") {
                continue;
            }
            eprintln!("[db] column migration failed ({statement}): {text}");
        }
    }
}

/// True when the `chat_messages` table already carries the `usage` column.
pub(super) fn chat_messages_has_usage_column(conn: &Connection) -> bool {
    let mut statement = match conn.prepare("PRAGMA table_info(chat_messages)") {
        Ok(statement) => statement,
        Err(_) => return false,
    };
    let names = statement.query_map([], |row| row.get::<_, String>(1));
    match names {
        Ok(names) => names.filter_map(Result::ok).any(|name| name == "usage"),
        Err(_) => false,
    }
}

/// Idempotent migration for `chat_messages.usage` (token accounting JSON).
///
/// SCHEMA_SQL covers fresh databases; existing data directories predate
/// the column, so a PRAGMA-guarded `ADD COLUMN` runs on every launch and
/// self-heals old installs exactly once. Failures are logged, never fatal
/// (startup must not break because of a migration hiccup).
pub(super) fn ensure_chat_message_usage_column(conn: &Connection) {
    if chat_messages_has_usage_column(conn) {
        return;
    }
    if let Err(err) = conn.execute_batch(
        "ALTER TABLE chat_messages ADD COLUMN usage TEXT NOT NULL DEFAULT '{}';",
    ) {
        eprintln!("[db] chat_messages.usage migration failed: {err}");
    }
}

/// One-time data migration: graded sessions previously stored only in
/// `quiz_records` become read-only rows in `quiz_sets`, so the quiz history
/// keeps one source of truth. Question bodies were never persisted for those,
/// so they render from their stored results only. Deterministic ids
/// (`rec-<old id>`) + INSERT OR IGNORE keep this idempotent.
pub(super) fn migrate_quiz_records_to_sets(conn: &Connection) {
    // An interim dev build created a single-row quiz_draft table; the
    // superseding quiz_sets design dropped it. The table never shipped.
    let _ = conn.execute_batch("DROP TABLE IF EXISTS quiz_draft;");
    let mut rows = match conn.prepare(
        "SELECT id, created_at, difficulty, question_count, total_score, total_max, details
         FROM quiz_records",
    ) {
        Ok(statement) => statement,
        Err(err) => {
            eprintln!("[db] quiz record migration failed to prepare: {err}");
            return;
        }
    };
    let records = match rows.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, f64>(4)?,
            row.get::<_, f64>(5)?,
            row.get::<_, String>(6)?,
        ))
    }) {
        Ok(rows) => rows.filter_map(Result::ok).collect::<Vec<_>>(),
        Err(err) => {
            eprintln!("[db] quiz record migration failed to read: {err}");
            return;
        }
    };
    for (id, created_at, difficulty, question_count, total_score, total_max, details) in records {
        let config = format!(
            "{{\"count\":{question_count},\"types\":[],\"difficulty\":{difficulty:?},\"topic\":null}}"
        );
        if let Err(err) = conn.execute(
            "INSERT OR IGNORE INTO quiz_sets(
                 id, created_at, difficulty, question_count, config,
                 questions, answers, results, graded, total_score, total_max)
             VALUES(?1, ?2, ?3, ?4, ?5, '[]', '{}', ?6, 1, ?7, ?8)",
            rusqlite::params![
                format!("rec-{id}"),
                created_at,
                difficulty,
                question_count,
                config,
                details,
                total_score,
                total_max
            ],
        ) {
            eprintln!("[db] quiz record migration failed to insert ({id}): {err}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_chat_messages_gain_usage_column_idempotently() {
        let conn = Connection::open_in_memory().expect("in-memory db");
        // Pre-usage schema: rows written by older builds must survive.
        conn.execute_batch(
            "CREATE TABLE chat_messages(
                 msg_id          TEXT PRIMARY KEY,
                 chat_session_id TEXT NOT NULL,
                 role            TEXT NOT NULL,
                 content         TEXT NOT NULL,
                 status          TEXT NOT NULL DEFAULT 'completed',
                 sources         TEXT NOT NULL DEFAULT '[]',
                 model           TEXT NOT NULL DEFAULT '',
                 error           TEXT NOT NULL DEFAULT '',
                 created_at      INTEGER NOT NULL
             );
             INSERT INTO chat_messages(msg_id, chat_session_id, role, content, created_at)
             VALUES('old', 's1', 'assistant', 'legacy answer', 1);",
        )
        .expect("legacy schema");
        assert!(!chat_messages_has_usage_column(&conn));

        ensure_chat_message_usage_column(&conn);
        // Second run is a no-op (no duplicate-column error, no data loss).
        ensure_chat_message_usage_column(&conn);

        assert!(chat_messages_has_usage_column(&conn));
        let (content, usage): (String, String) = conn
            .query_row(
                "SELECT content, usage FROM chat_messages WHERE msg_id = 'old'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("legacy row readable");
        assert_eq!(content, "legacy answer");
        assert_eq!(usage, "{}");
    }
}
