//! Note CRUD SQL scoped to a [`rusqlite::Connection`], shared by the tauri
//! commands and the note agent tools.

use rusqlite::{params, Connection, OptionalExtension};

use crate::infra::db;

use super::anchors::fetch_anchors_conn;
use super::types::{NoteDetail, NoteListRow};
use super::now_secs;

/// List-row snippet length.
const SNIPPET_CHARS: usize = 80;
/// Hard cap on the list query.
const LIST_LIMIT: i64 = 500;

pub(crate) fn get_detail_conn(conn: &Connection, id: &str) -> Result<Option<NoteDetail>, String> {
    let note = conn
        .query_row(
            "SELECT id, title, content, pinned, created_at, updated_at
             FROM notes WHERE id = ?1",
            params![id],
            |row| {
                Ok(NoteDetail {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    content: row.get(2)?,
                    pinned: row.get::<_, i64>(3)? != 0,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                    anchors: Vec::new(),
                })
            },
        )
        .optional()
        .map_err(|err| format!("failed to read note: {err}"))?;
    match note {
        Some(mut detail) => {
            detail.anchors = fetch_anchors_conn(conn, id)?;
            Ok(Some(detail))
        }
        None => Ok(None),
    }
}

pub(super) fn insert_note_conn(conn: &Connection, id: &str, title: &str) -> Result<(), String> {
    let now = now_secs();
    conn.execute(
        "INSERT INTO notes(id, title, content, pinned, created_at, updated_at)
         VALUES(?1, ?2, '', 0, ?3, ?3)",
        params![id, title, now],
    )
    .map_err(|err| format!("failed to create note: {err}"))?;
    Ok(())
}

pub(super) fn delete_note_conn(conn: &Connection, id: &str) -> Result<(), String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|err| format!("failed to begin transaction: {err}"))?;
    tx.execute("DELETE FROM note_anchors WHERE note_id = ?1", params![id])
        .map_err(|err| format!("failed to delete anchors: {err}"))?;
    tx.execute("DELETE FROM note_revisions WHERE note_id = ?1", params![id])
        .map_err(|err| format!("failed to delete revisions: {err}"))?;
    tx.execute("DELETE FROM notes WHERE id = ?1", params![id])
        .map_err(|err| format!("failed to delete note: {err}"))?;
    tx.commit()
        .map_err(|err| format!("failed to commit delete: {err}"))
}

/// List rows with optional LIKE filtering — shared by the command and the
/// note agent's list_notes tool.
pub(crate) fn notes_list_internal(
    conn: &Connection,
    query: Option<String>,
) -> Result<Vec<NoteListRow>, String> {
    let filter = query
        .map(|q| q.trim().to_string())
        .filter(|q| !q.is_empty());

    let sql = match filter.is_some() {
        true => (
            "SELECT id, title, pinned, updated_at, length(content), content
             FROM notes
             WHERE title LIKE ?1 OR content LIKE ?1
             ORDER BY pinned DESC, updated_at DESC LIMIT ?2",
            2,
        ),
        false => (
            "SELECT id, title, pinned, updated_at, length(content), content
             FROM notes ORDER BY pinned DESC, updated_at DESC LIMIT ?1",
            1,
        ),
    };

    let mut statement = conn
        .prepare(sql.0)
        .map_err(|err| format!("failed to list notes: {err}"))?;

    let map_row = |row: &rusqlite::Row<'_>| -> rusqlite::Result<NoteListRow> {
        let content: String = row.get(5)?;
        let snippet: String = content
            .chars()
            .take(SNIPPET_CHARS)
            .flat_map(|c| {
                if c == '\n' || c == '\r' {
                    vec![' ']
                } else {
                    vec![c]
                }
            })
            .collect();
        Ok(NoteListRow {
            id: row.get(0)?,
            title: row.get(1)?,
            pinned: row.get::<_, i64>(2)? != 0,
            updated_at: row.get(3)?,
            char_count: row.get(4)?,
            snippet: snippet.trim().to_string(),
        })
    };

    let rows = if let Some(term) = &filter {
        let pattern = format!("%{}%", term.replace(['%', '_'], ""));
        statement
            .query_map(rusqlite::params![pattern, LIST_LIMIT], map_row)
            .map_err(|err| format!("failed to query notes: {err}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| format!("failed to read notes: {err}"))?
    } else {
        statement
            .query_map(rusqlite::params![LIST_LIMIT], map_row)
            .map_err(|err| format!("failed to query notes: {err}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| format!("failed to read notes: {err}"))?
    };
    Ok(rows)
}

/// Create an empty note; returns its local id.
pub(crate) fn note_create_internal(conn: &Connection, title: &str) -> Result<String, String> {
    let id = db::local_id();
    insert_note_conn(conn, &id, title)?;
    Ok(id)
}

/// Current `updated_at` of one note — the concurrency baseline for saves.
pub(crate) fn note_updated_at(conn: &Connection, id: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT updated_at FROM notes WHERE id = ?1",
        params![id],
        |row| row.get(0),
    )
    .optional()
    .map_err(|err| format!("failed to read note: {err}"))?
    .ok_or_else(|| "笔记不存在".to_string())
}

/// Rename without touching content (used by the note agent's update tool).
pub(crate) fn rename_note_internal(
    conn: &Connection,
    id: &str,
    title: &str,
    now: i64,
) -> Result<(), String> {
    conn.execute(
        "UPDATE notes SET title = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, title, now],
    )
    .map_err(|err| format!("failed to rename note: {err}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::notes::anchors::anchor_url;

    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory db");
        conn.execute_batch(crate::infra::db::SCHEMA_SQL).expect("schema");
        conn
    }

    #[test]
    fn anchors_roundtrip_through_the_store() {
        let conn = memory_db();
        insert_note_conn(&conn, "n1", "带锚点的笔记").unwrap();
        conn.execute(
            "INSERT INTO note_anchors(id, note_id, bvid, page_index, seconds, label, created_at)
             VALUES('a1', 'n1', 'BV1AbCdEfGhI', 2, 95, '标题', 1)",
            [],
        )
        .unwrap();

        let detail = get_detail_conn(&conn, "n1").unwrap().unwrap();
        assert_eq!(detail.anchors.len(), 1);
        assert_eq!(detail.anchors[0].url, anchor_url("BV1AbCdEfGhI", 2, 95));

        // Deleting the note cascades.
        delete_note_conn(&conn, "n1").unwrap();
        let anchors: i64 = conn
            .query_row("SELECT COUNT(*) FROM note_anchors", [], |r| r.get(0))
            .unwrap();
        assert_eq!(anchors, 0);
    }

    #[test]
    fn local_ids_are_unique_across_calls() {
        let first = db::local_id();
        let second = db::local_id();
        assert_ne!(first, second);
        assert_eq!(first.len(), 32);
    }
}
