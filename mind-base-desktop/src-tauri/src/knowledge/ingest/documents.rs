//! documents 表的读写：文档行状态流转、文档列表与删除命令。

use rusqlite::params;
use serde::Serialize;
use tauri::State;

use crate::infra::db::Db;
use crate::knowledge::vectors;

use super::pages::PageIdentity;

// ---------------------------------------------------------------------------
// Document rows
// ---------------------------------------------------------------------------

/// One ingested 分P, as shown in the workspace document list.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentRow {
    pub doc_id: String,
    pub bvid: String,
    pub page_index: i64,
    pub video_title: String,
    pub page_title: String,
    /// asr | basic_info | file extension
    pub source: String,
    /// done | failed | processing | pending
    pub status: String,
    pub error: String,
    pub chunk_count: i64,
    pub char_count: i64,
    pub embed_model: String,
    pub embed_dim: i64,
    pub updated_at: i64,
    pub url: String,
    /// video | file — file documents carry an absolute local path instead of
    /// a B站 identity.
    pub source_type: String,
    pub file_path: String,
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|delta| delta.as_secs() as i64)
        .unwrap_or_default()
}

/// Canonical doc id for one 分P.
pub(super) fn doc_id_of(bvid: &str, page_index: i64) -> String {
    format!("{bvid}:p{page_index}")
}

/// Canonical B站 watch URL for one 分P.
pub(super) fn page_url(bvid: &str, page_index: i64) -> String {
    format!("https://www.bilibili.com/video/{bvid}?p={page_index}")
}

/// Insert-or-update a documents row while a page is in flight.
pub(super) fn upsert_document_status(
    conn: &rusqlite::Connection,
    page: &PageIdentity<'_>,
    status: &str,
    error: &str,
) -> Result<(), String> {
    let now = now_secs();
    conn.execute(
        "INSERT INTO documents(doc_id, bvid, cid, page_index, video_title, page_title,
                               upper_name, source, status, error, created_at, updated_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, '', ?8, ?9, ?10, ?10)
         ON CONFLICT(doc_id) DO UPDATE SET
             cid = excluded.cid,
             video_title = excluded.video_title,
             page_title = excluded.page_title,
             upper_name = excluded.upper_name,
             status = excluded.status,
             error = excluded.error,
             updated_at = excluded.updated_at",
        params![
            page.doc_id,
            page.bvid,
            page.cid,
            page.page_index,
            page.video_title,
            page.page_title,
            page.upper_name,
            status,
            error,
            now
        ],
    )
    .map_err(|err| format!("failed to update document status: {err}"))?;
    Ok(())
}

/// Finalize a documents row with its produced-content facts.
pub(super) fn mark_document_done(
    conn: &rusqlite::Connection,
    doc_id: &str,
    source: &str,
    chunk_count: usize,
    char_count: usize,
    embed_model: &str,
    embed_dim: i64,
) -> Result<(), String> {
    conn.execute(
        "UPDATE documents
         SET status = 'done', error = '', source = ?2, chunk_count = ?3,
             char_count = ?4, embed_model = ?5, embed_dim = ?6, updated_at = ?7
         WHERE doc_id = ?1",
        params![
            doc_id,
            source,
            chunk_count as i64,
            char_count as i64,
            embed_model,
            embed_dim,
            now_secs()
        ],
    )
    .map_err(|err| format!("failed to finalize document: {err}"))?;
    Ok(())
}

pub(super) fn mark_document_failed(
    conn: &rusqlite::Connection,
    doc_id: &str,
    error: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE documents SET status = 'failed', error = ?2, updated_at = ?3 WHERE doc_id = ?1",
        params![doc_id, error, now_secs()],
    )
    .map_err(|err| format!("failed to mark document failed: {err}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Document management + search + QA commands
// ---------------------------------------------------------------------------

/// Delete one ingested document (vectors + metadata row together).
#[tauri::command]
pub fn delete_document(doc_id: String, db: State<'_, Db>) -> Result<usize, String> {
    let doc_id = doc_id.trim().to_string();
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    let tx = conn
        .unchecked_transaction()
        .map_err(|err| format!("failed to begin transaction: {err}"))?;
    let removed = vectors::delete_doc_conn(&tx, &doc_id)?;
    tx.execute("DELETE FROM documents WHERE doc_id = ?1", params![doc_id])
        .map_err(|err| format!("failed to delete document row: {err}"))?;
    tx.commit()
        .map_err(|err| format!("failed to commit delete: {err}"))?;
    Ok(removed)
}

/// List every ingested document, newest first.
#[tauri::command]
pub fn list_documents(db: State<'_, Db>) -> Result<Vec<DocumentRow>, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    let mut statement = conn
        .prepare(
            "SELECT doc_id, bvid, page_index, video_title, page_title, source, status, error,
                    chunk_count, char_count, embed_model, embed_dim, updated_at,
                    source_type, file_path
             FROM documents ORDER BY updated_at DESC",
        )
        .map_err(|err| format!("failed to list documents: {err}"))?;
    let rows = statement
        .query_map([], |row| {
            // Column order above differs from row_to_document's expectation;
            // map explicitly here.
            let doc_id: String = row.get(0)?;
            let bvid: String = row.get(1)?;
            let page_index: i64 = row.get(2)?;
            // File documents (source_type = 'file') have no B站 identity —
            // their bvid column is empty and a watch URL would be bogus.
            let source_type: String = row.get(13)?;
            let file_path: String = row.get(14)?;
            let url = if bvid.is_empty() {
                String::new()
            } else {
                page_url(&bvid, page_index)
            };
            Ok(DocumentRow {
                url,
                doc_id,
                bvid,
                page_index,
                video_title: row.get(3)?,
                page_title: row.get(4)?,
                source: row.get(5)?,
                status: row.get(6)?,
                error: row.get(7)?,
                chunk_count: row.get(8)?,
                char_count: row.get(9)?,
                embed_model: row.get(10)?,
                embed_dim: row.get(11)?,
                updated_at: row.get(12)?,
                source_type,
                file_path,
            })
        })
        .map_err(|err| format!("failed to query documents: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("failed to read documents: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doc_id_and_url_shapes_are_stable() {
        assert_eq!(doc_id_of("BV1AbCdEfGhI", 2), "BV1AbCdEfGhI:p2");
        assert_eq!(
            page_url("BV1AbCdEfGhI", 3),
            "https://www.bilibili.com/video/BV1AbCdEfGhI?p=3"
        );
    }
}
