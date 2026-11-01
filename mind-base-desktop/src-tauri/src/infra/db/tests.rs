//! Cross-submodule integration tests for the SQLite layer.

use rusqlite::Connection;

use super::migrations::chat_messages_has_usage_column;
use super::schema::ensure_schema;

#[test]
fn fresh_schema_has_chat_message_usage_column() {
    let conn = Connection::open_in_memory().expect("in-memory db");
    ensure_schema(&conn).expect("schema bootstrap");
    assert!(
        chat_messages_has_usage_column(&conn),
        "fresh databases get the usage column from SCHEMA_SQL"
    );
    // The column defaults to the empty usage object for every row.
    conn.execute(
        "INSERT INTO chat_messages(msg_id, chat_session_id, role, content, created_at)
             VALUES('m1', 's1', 'assistant', 'hi', 1)",
        [],
    )
    .expect("insert");
    let usage: String = conn
        .query_row(
            "SELECT usage FROM chat_messages WHERE msg_id = 'm1'",
            [],
            |row| row.get(0),
        )
        .expect("usage default");
    assert_eq!(usage, "{}");
}

#[test]
fn ensure_schema_heals_legacy_chat_messages_table() {
    let conn = Connection::open_in_memory().expect("in-memory db");
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
             );",
    )
    .expect("legacy schema");
    ensure_schema(&conn).expect("startup self-heals the old database");
    assert!(chat_messages_has_usage_column(&conn));
}

#[test]
fn ensure_schema_heals_legacy_manuscript_sections_without_document_id() {
    let conn = Connection::open_in_memory().expect("in-memory db");
    // Pre-document schema: sections table exists but has no document_id column.
    conn.execute_batch(
        "CREATE TABLE manuscript_sections(
                 id          TEXT PRIMARY KEY,
                 project_id  TEXT NOT NULL,
                 section     TEXT NOT NULL,
                 ord         INTEGER NOT NULL DEFAULT 0,
                 path        TEXT NOT NULL DEFAULT '',
                 words       INTEGER NOT NULL DEFAULT 0,
                 status      TEXT NOT NULL DEFAULT 'draft',
                 updated_at  INTEGER NOT NULL
             );
         INSERT INTO manuscript_sections(id, project_id, section, ord, updated_at)
             VALUES('s1', 'p1', '摘要', 0, 1);",
    )
    .expect("legacy schema");

    // Regression: the document index lives in a post-column-migration pass; if it
    // ever moves back into SCHEMA_SQL this call fails with "no such column".
    ensure_schema(&conn).expect("startup self-heals the old manuscript table");

    let has_column: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('manuscript_sections') WHERE name = 'document_id'",
            [],
            |row| row.get(0),
        )
        .expect("pragma table_info");
    assert_eq!(has_column, 1, "document_id column must be added");

    let index_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' \
             AND name = 'idx_manuscript_sections_document'",
            [],
            |row| row.get(0),
        )
        .expect("index lookup");
    assert_eq!(index_count, 1, "document index must exist after migration");

    // The legacy row is attached to a generated default document.
    let document_id: String = conn
        .query_row(
            "SELECT document_id FROM manuscript_sections WHERE id = 's1'",
            [],
            |row| row.get(0),
        )
        .expect("document id backfill");
    assert!(!document_id.is_empty(), "legacy section must get a document");
}
