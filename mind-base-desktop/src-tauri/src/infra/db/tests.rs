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
