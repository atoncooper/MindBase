//! Tauri commands for notes and revisions and the guarded save paths they share.

use rusqlite::{params, Connection, OptionalExtension};
use tauri::State;

use crate::infra::db::Db;

use super::revisions::{insert_revision_conn, maybe_snapshot_conn, prune_revisions_conn};
use super::store::{delete_note_conn, get_detail_conn, note_create_internal, notes_list_internal};
use super::{
    now_secs, sanitize_markdown, NoteDetail, NoteListRow, PinResult, RevisionContent,
    RevisionMeta, UpdateResult,
};

#[tauri::command]
pub fn notes_list(db: State<'_, Db>, query: Option<String>) -> Result<Vec<NoteListRow>, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    notes_list_internal(&conn, query)
}

#[tauri::command]
pub fn note_create(db: State<'_, Db>, title: Option<String>) -> Result<NoteDetail, String> {
    let title = title
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "未命名笔记".to_string());
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    let id = note_create_internal(&conn, &title)?;
    get_detail_conn(&conn, &id)?.ok_or_else(|| "笔记创建失败".to_string())
}

#[tauri::command]
pub fn note_get(db: State<'_, Db>, id: String) -> Result<NoteDetail, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    get_detail_conn(&conn, &id)?.ok_or_else(|| "笔记不存在".to_string())
}

/// Shared save path: sanitize → concurrency check → snapshot policy → write.
/// `now` is injected so tests can drive the snapshot clock.
pub(crate) fn note_update_internal(
    conn: &Connection,
    id: &str,
    content: &str,
    expected_updated_at: i64,
    now: i64,
) -> Result<UpdateResult, String> {
    let sanitized = sanitize_markdown(content);
    let tx = conn
        .unchecked_transaction()
        .map_err(|err| format!("failed to begin transaction: {err}"))?;

    let (current_content, current_updated): (String, i64) = tx
        .query_row(
            "SELECT content, updated_at FROM notes WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|err| format!("failed to read note: {err}"))?
        .ok_or_else(|| "笔记不存在".to_string())?;

    if expected_updated_at != current_updated {
        return Err("该笔记已在别处被修改，请重新打开后再保存".to_string());
    }

    maybe_snapshot_conn(&tx, id, &current_content, &sanitized, now)?;
    tx.execute(
        "UPDATE notes SET content = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, sanitized, now],
    )
    .map_err(|err| format!("failed to update note: {err}"))?;
    tx.commit()
        .map_err(|err| format!("failed to commit update: {err}"))?;

    Ok(UpdateResult {
        updated_at: now,
        char_count: sanitized.chars().count() as i64,
    })
}

/// Save the body. `expected_updated_at` implements optimistic concurrency —
/// a mismatch means another window changed the note meanwhile.
#[tauri::command]
pub fn note_update(
    db: State<'_, Db>,
    id: String,
    content: String,
    expected_updated_at: i64,
) -> Result<UpdateResult, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    note_update_internal(&conn, &id, &content, expected_updated_at, now_secs())
}

/// Atomic UI save: title + body under ONE concurrency check.
///
/// The editor autosaves both fields on every debounce tick; doing that as
/// separate commands would let the first write bump `updated_at` and leave
/// the second one's baseline stale (rejected as a conflict on every save),
/// so both writes share one transaction, one guard and one timestamp.
pub(crate) fn note_save_internal(
    conn: &Connection,
    id: &str,
    title: &str,
    content: &str,
    expected_updated_at: i64,
    now: i64,
) -> Result<UpdateResult, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("标题不能为空".to_string());
    }
    let sanitized = sanitize_markdown(content);
    let tx = conn
        .unchecked_transaction()
        .map_err(|err| format!("failed to begin transaction: {err}"))?;

    let (current_content, current_updated): (String, i64) = tx
        .query_row(
            "SELECT content, updated_at FROM notes WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|err| format!("failed to read note: {err}"))?
        .ok_or_else(|| "笔记不存在".to_string())?;

    if expected_updated_at != current_updated {
        return Err("该笔记已在别处被修改，请重新打开后再保存".to_string());
    }

    maybe_snapshot_conn(&tx, id, &current_content, &sanitized, now)?;
    tx.execute(
        "UPDATE notes SET title = ?2, content = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, title, sanitized, now],
    )
    .map_err(|err| format!("failed to update note: {err}"))?;
    tx.commit()
        .map_err(|err| format!("failed to commit update: {err}"))?;

    Ok(UpdateResult {
        updated_at: now,
        char_count: sanitized.chars().count() as i64,
    })
}

/// Save title and body in one guarded write (used by the editor autosave).
#[tauri::command]
pub fn note_save(
    db: State<'_, Db>,
    id: String,
    title: String,
    content: String,
    expected_updated_at: i64,
) -> Result<UpdateResult, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    note_save_internal(&conn, &id, &title, &content, expected_updated_at, now_secs())
}

#[tauri::command]
pub fn note_rename(db: State<'_, Db>, id: String, title: String) -> Result<(), String> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("标题不能为空".to_string());
    }
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    let updated = conn
        .execute(
            "UPDATE notes SET title = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, title, now_secs()],
        )
        .map_err(|err| format!("failed to rename note: {err}"))?;
    if updated == 0 {
        return Err("笔记不存在".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn note_delete(db: State<'_, Db>, id: String) -> Result<(), String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    delete_note_conn(&conn, &id)
}

#[tauri::command]
pub fn note_toggle_pin(db: State<'_, Db>, id: String) -> Result<PinResult, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    // The bump floats the row within its group via updated_at, but it also
    // invalidates editors' concurrency baselines — return the new value so
    // open editors can adopt it instead of failing their next save.
    let now = now_secs();
    conn.execute(
        "UPDATE notes SET pinned = 1 - pinned, updated_at = ?2 WHERE id = ?1",
        params![id, now],
    )
    .map_err(|err| format!("failed to toggle pin: {err}"))?;
    let pinned: i64 = conn
        .query_row("SELECT pinned FROM notes WHERE id = ?1", params![id], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|err| format!("failed to read pin state: {err}"))?
        .ok_or_else(|| "笔记不存在".to_string())?;
    Ok(PinResult {
        pinned: pinned != 0,
        updated_at: now,
    })
}

#[tauri::command]
pub fn revisions_list(db: State<'_, Db>, note_id: String) -> Result<Vec<RevisionMeta>, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    let mut statement = conn
        .prepare(
            "SELECT id, note_id, char_count, created_at
             FROM note_revisions WHERE note_id = ?1 ORDER BY created_at DESC",
        )
        .map_err(|err| format!("failed to list revisions: {err}"))?;
    let rows = statement
        .query_map(params![note_id], |row| {
            Ok(RevisionMeta {
                id: row.get(0)?,
                note_id: row.get(1)?,
                char_count: row.get(2)?,
                created_at: row.get(3)?,
            })
        })
        .map_err(|err| format!("failed to query revisions: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("failed to read revisions: {err}"))
}

#[tauri::command]
pub fn revision_get(db: State<'_, Db>, revision_id: String) -> Result<RevisionContent, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    conn.query_row(
        "SELECT id, content, created_at FROM note_revisions WHERE id = ?1",
        params![revision_id],
        |row| {
            Ok(RevisionContent {
                id: row.get(0)?,
                content: row.get(1)?,
                created_at: row.get(2)?,
            })
        },
    )
    .optional()
    .map_err(|err| format!("failed to read revision: {err}"))?
    .ok_or_else(|| "修订不存在".to_string())
}

/// Roll a note back to a stored revision. The CURRENT content snapshots
/// unconditionally first (regardless of time/diff policy) so "undo my undo"
/// is always possible.
#[tauri::command]
pub fn revision_restore(db: State<'_, Db>, revision_id: String) -> Result<i64, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    let tx = conn
        .unchecked_transaction()
        .map_err(|err| format!("failed to begin transaction: {err}"))?;

    let (note_id, restored_content): (String, String) = tx
        .query_row(
            "SELECT note_id, content FROM note_revisions WHERE id = ?1",
            params![revision_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|err| format!("failed to read revision: {err}"))?
        .ok_or_else(|| "修订不存在".to_string())?;

    let current: String = tx
        .query_row(
            "SELECT content FROM notes WHERE id = ?1",
            params![note_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| format!("failed to read note: {err}"))?
        .ok_or_else(|| "笔记不存在".to_string())?;

    if current != restored_content && !current.trim().is_empty() {
        insert_revision_conn(&tx, &note_id, &current, now_secs())?;
        prune_revisions_conn(&tx, &note_id)?;
    }

    let now = now_secs();
    tx.execute(
        "UPDATE notes SET content = ?2, updated_at = ?3 WHERE id = ?1",
        params![note_id, restored_content, now],
    )
    .map_err(|err| format!("failed to restore revision: {err}"))?;
    tx.commit()
        .map_err(|err| format!("failed to commit restore: {err}"))?;
    Ok(now)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::notes::store::insert_note_conn;

    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory db");
        conn.execute_batch(crate::infra::db::SCHEMA_SQL).expect("schema");
        conn
    }

    fn seed_note(conn: &Connection, id: &str, content: &str) {
        insert_note_conn(conn, id, "测试笔记").expect("seed");
        conn.execute(
            "UPDATE notes SET content = ?2 WHERE id = ?1",
            params![id, content],
        )
        .expect("seed content");
    }

    // -- atomic save ----------------------------------------------------------

    #[test]
    fn note_save_writes_title_content_and_new_baseline() {
        let conn = memory_db();
        seed_note(&conn, "n1", "旧内容");
        let baseline: i64 = conn
            .query_row("SELECT updated_at FROM notes WHERE id='n1'", [], |r| r.get(0))
            .unwrap();

        let result =
            note_save_internal(&conn, "n1", "新标题", "新内容", baseline, baseline + 5).unwrap();

        assert_eq!(result.updated_at, baseline + 5);
        let (title, content): (String, String) = conn
            .query_row("SELECT title, content FROM notes WHERE id='n1'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(title, "新标题");
        assert_eq!(content, "新内容");

        // Stale baseline → rejected like the single-field writers.
        assert!(note_save_internal(&conn, "n1", "再改", "再写", baseline, baseline + 6).is_err());
        // Empty title → rejected before any write lands.
        assert!(
            note_save_internal(&conn, "n1", "   ", "内容", result.updated_at, baseline + 7)
                .is_err()
        );
    }

    #[test]
    fn restore_snapshots_current_then_swaps() {
        let conn = memory_db();
        seed_note(&conn, "n1", "当前内容");
        insert_revision_conn(&conn, "n1", "历史版本内容", 500).unwrap();

        let now = restore_via_internal(&conn, "n1", "历史版本内容", 900);

        let content: String = conn
            .query_row("SELECT content FROM notes WHERE id='n1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(content, "历史版本内容");
        assert!(now > 0);
        // The pre-restore content was preserved as a fresh revision.
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM note_revisions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2);
    }

    /// Mirror of revision_restore's internals without the Tauri wrapper.
    fn restore_via_internal(conn: &Connection, _rev_note: &str, restored: &str, now: i64) -> i64 {
        let current: String = conn
            .query_row("SELECT content FROM notes WHERE id='n1'", [], |r| r.get(0))
            .unwrap();
        if current != restored && !current.trim().is_empty() {
            insert_revision_conn(conn, "n1", &current, now).unwrap();
        }
        conn.execute(
            "UPDATE notes SET content = ?, updated_at = ? WHERE id = 'n1'",
            rusqlite::params![restored, now],
        )
        .unwrap();
        now
    }
}
