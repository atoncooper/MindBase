//! IPC 命令：分块写入、向量检索、文档删除与存储统计。

use tauri::State;

use crate::infra::db::Db;

use super::search::search_conn;
use super::store::{delete_doc_conn, upsert_chunks_conn};
use super::types::{SearchHit, UpsertChunk, VectorStats};

/// Store or replace chunks of one document; returns the number written.
/// Wraps the insert in its own transaction so a mid-way failure never leaves
/// the document half-written (ingest, which composes this with the document
/// row, supplies its own outer transaction instead).
#[tauri::command]
pub fn upsert_doc_chunks(
    doc_id: String,
    chunks: Vec<UpsertChunk>,
    db: State<'_, Db>,
) -> Result<usize, String> {
    let doc_id = doc_id.trim().to_string();
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    let tx = conn
        .unchecked_transaction()
        .map_err(|err| format!("failed to begin transaction: {err}"))?;
    let written = upsert_chunks_conn(&tx, &doc_id, &chunks)?;
    tx.commit()
        .map_err(|err| format!("failed to commit chunks: {err}"))?;
    Ok(written)
}

/// Brute-force cosine search over every stored row of matching dimension.
#[tauri::command]
pub fn search_vectors(
    query_embedding: Vec<f32>,
    top_k: u32,
    doc_ids: Option<Vec<String>>,
    db: State<'_, Db>,
) -> Result<Vec<SearchHit>, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    search_conn(&conn, &query_embedding, top_k, doc_ids.as_deref())
}

/// Delete every chunk of one document; returns the number removed.
#[tauri::command]
pub fn delete_doc_vectors(doc_id: String, db: State<'_, Db>) -> Result<usize, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    delete_doc_conn(&conn, &doc_id)
}

/// Read-only store facts for the status card.
#[tauri::command]
pub fn get_vector_stats(db: State<'_, Db>) -> Result<VectorStats, String> {
    let count: i64 = {
        let conn = db
            .conn
            .lock()
            .map_err(|err| format!("failed to acquire database lock: {err}"))?;
        conn.query_row("SELECT COUNT(*) FROM vectors", [], |row| row.get(0))
            .map_err(|err| format!("failed to count vectors: {err}"))?
    };
    // Lock order: `data_dir` after `conn`, mirroring db.rs's documented order.
    let storage_path = {
        let dir = db
            .data_dir
            .lock()
            .map_err(|err| format!("failed to acquire database lock: {err}"))?;
        dir.join(crate::infra::db::DB_FILE_NAME).display().to_string()
    };
    Ok(VectorStats {
        count,
        storage_path,
    })
}
