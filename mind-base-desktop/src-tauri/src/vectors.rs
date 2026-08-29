//! Built-in vector store, backed by the same SQLite database as everything
//! else.
//!
//! Zero configuration by design: the store lives wherever the active data
//! directory points (see `db.rs`), needs no external service, and moves
//! together with 数据存储 relocation. Search is brute-force cosine similarity,
//! which is the right trade-off for a personal knowledge base — thousands of
//! chunks answer in single-digit milliseconds, with no index to maintain.
//!
//! Embeddings are stored as little-endian f32 blobs next to their dimension;
//! rows whose dimension differs from the query vector are skipped rather
//! than mixed into results (they belong to a different embedding model).

use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::Db;

/// Hard ceiling on embedding dimensions accepted for storage.
const MAX_DIM: usize = 4096;

/// Upper bound for `top_k`; keeps result payloads predictable.
const MAX_TOP_K: u32 = 50;

/// One chunk to store: its position inside the source document, the text
/// itself and the pre-computed embedding.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertChunk {
    pub index: i64,
    pub content: String,
    pub embedding: Vec<f32>,
}

/// A retrieval hit: matched chunk plus its cosine similarity in [-1, 1].
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub doc_id: String,
    pub chunk_index: i64,
    pub content: String,
    pub score: f32,
}

/// Read-only facts about the store, shown on the status card.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VectorStats {
    /// Stored chunk count across all documents.
    pub count: i64,
    /// Absolute path of the SQLite file hosting the vectors.
    pub storage_path: String,
}

/// Encode an embedding as a little-endian f32 blob.
fn encode_embedding(values: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(values.len() * 4);
    for value in values {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes
}

/// Decode a stored blob back into `dim` f32 values; `None` on size mismatch.
fn decode_embedding(blob: &[u8], dim: usize) -> Option<Vec<f32>> {
    if blob.len() != dim * 4 {
        return None;
    }
    blob.chunks_exact(4)
        .map(|chunk| Some(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]])))
        .collect()
}

/// Cosine similarity with zero-norm guards; falls back to 0.0.
fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let mut dot = 0.0_f32;
    let mut norm_a = 0.0_f32;
    let mut norm_b = 0.0_f32;
    for (x, y) in a.iter().zip(b.iter()) {
        dot += x * y;
        norm_a += x * x;
        norm_b += y * y;
    }
    if norm_a == 0.0 || norm_b == 0.0 {
        return 0.0;
    }
    dot / (norm_a.sqrt() * norm_b.sqrt())
}

/// Validate one chunk before it reaches the database.
fn validate_chunk(chunk: &UpsertChunk) -> Result<(), String> {
    if chunk.content.trim().is_empty() {
        return Err("分块内容不能为空".to_string());
    }
    if chunk.embedding.is_empty() || chunk.embedding.len() > MAX_DIM {
        return Err(format!(
            "embedding 维度无效：{}（允许 1–{MAX_DIM}）",
            chunk.embedding.len()
        ));
    }
    if chunk.index < 0 {
        return Err("分块序号不能为负数".to_string());
    }
    Ok(())
}

/// Store or replace chunks of one document; returns the number written.
///
/// All chunks must share one dimension — mixing embedding models inside a
/// document would silently poison search results.
///
/// Does NOT open a transaction itself: the caller owns atomicity. The
/// standalone command wraps this call in a transaction, and ingest wraps it
/// together with the document-row write in one transaction.
pub(crate) fn upsert_chunks_conn(
    conn: &Connection,
    doc_id: &str,
    chunks: &[UpsertChunk],
) -> Result<usize, String> {
    if doc_id.trim().is_empty() {
        return Err("doc_id 不能为空".to_string());
    }
    if chunks.is_empty() {
        return Err("chunks 不能为空".to_string());
    }

    // Validate everything up front so a bad chunk aborts the whole call.
    let dim = chunks[0].embedding.len();
    for chunk in chunks {
        validate_chunk(chunk)?;
        if chunk.embedding.len() != dim {
            return Err("同一文档的分块必须使用相同维度的 embedding".to_string());
        }
    }

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|delta| delta.as_secs() as i64)
        .unwrap_or_default();

    let mut written = 0usize;
    for chunk in chunks {
        let affected = conn
            .execute(
                "INSERT INTO vectors(doc_id, chunk_index, content, dim, embedding, created_at)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(doc_id, chunk_index) DO UPDATE SET
                     content = excluded.content,
                     dim = excluded.dim,
                     embedding = excluded.embedding,
                     created_at = excluded.created_at",
                params![
                    doc_id.trim(),
                    chunk.index,
                    chunk.content,
                    dim as i64,
                    encode_embedding(&chunk.embedding),
                    now,
                ],
            )
            .map_err(|err| format!("failed to store chunk: {err}"))?;
        written += affected;
    }
    Ok(written)
}

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
///
/// Rows with a different dimension are skipped (different embedding model);
/// optional `doc_ids` narrows the scan to selected documents.
pub(crate) fn search_conn(
    conn: &Connection,
    query_embedding: &[f32],
    top_k: u32,
    doc_ids: Option<&[String]>,
) -> Result<Vec<SearchHit>, String> {
    if query_embedding.is_empty() || query_embedding.len() > MAX_DIM {
        return Err(format!(
            "查询 embedding 维度无效：{}（允许 1–{MAX_DIM}）",
            query_embedding.len()
        ));
    }
    let top_k = top_k.clamp(1, MAX_TOP_K);

    let mut statement = conn
        .prepare("SELECT doc_id, chunk_index, content, dim, embedding FROM vectors")
        .map_err(|err| format!("failed to read vectors: {err}"))?;
    let mut rows = statement.query([]).map_err(|err| err.to_string())?;

    let mut hits: Vec<SearchHit> = Vec::new();
    while let Some(row) = rows.next().map_err(|err| err.to_string())? {
        let doc_id: String = row.get(0).map_err(|err| err.to_string())?;
        if let Some(filter) = doc_ids {
            if !filter.contains(&doc_id) {
                continue;
            }
        }
        let chunk_index: i64 = row.get(1).map_err(|err| err.to_string())?;
        let content: String = row.get(2).map_err(|err| err.to_string())?;
        let dim: i64 = row.get(3).map_err(|err| err.to_string())?;
        let blob: Vec<u8> = row.get(4).map_err(|err| err.to_string())?;

        let dim = match usize::try_from(dim) {
            Ok(dim) => dim,
            Err(_) => continue,
        };
        // Dimension mismatch = another embedding model's row; skip quietly.
        let Some(embedding) = decode_embedding(&blob, dim) else {
            continue;
        };
        if embedding.len() != query_embedding.len() {
            continue;
        }
        hits.push(SearchHit {
            doc_id,
            chunk_index,
            content,
            score: cosine(query_embedding, &embedding),
        });
    }

    hits.sort_by(|a, b| b.score.total_cmp(&a.score));
    hits.truncate(top_k as usize);
    Ok(hits)
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
pub(crate) fn delete_doc_conn(conn: &Connection, doc_id: &str) -> Result<usize, String> {
    conn.execute(
        "DELETE FROM vectors WHERE doc_id = ?1",
        params![doc_id.trim()],
    )
    .map_err(|err| format!("failed to delete document vectors: {err}"))
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
        dir.join(crate::db::DB_FILE_NAME).display().to_string()
    };
    Ok(VectorStats {
        count,
        storage_path,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(a: f32, b: f32, c: f32) -> Vec<f32> {
        vec![a, b, c]
    }

    #[test]
    fn embedding_blob_roundtrips() {
        let values = sample(0.5, -1.25, 3.0);
        let bytes = encode_embedding(&values);
        assert_eq!(bytes.len(), 12);
        assert_eq!(decode_embedding(&bytes, 3), Some(values));
        assert_eq!(decode_embedding(&bytes, 2), None);
    }

    #[test]
    fn cosine_scores_align_and_orthogonality() {
        let a = sample(1.0, 0.0, 0.0);
        assert!((cosine(&a, &a) - 1.0).abs() < 1e-6);
        let b = sample(0.0, 1.0, 0.0);
        assert!(cosine(&a, &b).abs() < 1e-6);
        // Zero vectors never divide by zero.
        assert_eq!(cosine(&a, &[0.0, 0.0, 0.0]), 0.0);
    }

    #[test]
    fn chunk_validation_bounds() {
        let ok = UpsertChunk {
            index: 0,
            content: "hello".into(),
            embedding: sample(1.0, 2.0, 3.0),
        };
        assert!(validate_chunk(&ok).is_ok());

        let empty_content = UpsertChunk {
            index: 0,
            content: "   ".into(),
            embedding: sample(1.0, 2.0, 3.0),
        };
        assert!(validate_chunk(&empty_content).is_err());

        let empty_embedding = UpsertChunk {
            index: 0,
            content: "hello".into(),
            embedding: vec![],
        };
        assert!(validate_chunk(&empty_embedding).is_err());

        let negative_index = UpsertChunk {
            index: -1,
            content: "hello".into(),
            embedding: sample(1.0, 2.0, 3.0),
        };
        assert!(validate_chunk(&negative_index).is_err());
    }

    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory db");
        conn.execute_batch(crate::db::SCHEMA_SQL).expect("schema");
        conn
    }

    #[test]
    fn upsert_search_delete_roundtrip() {
        let conn = memory_db();

        // Doc A: two chunks; the first is nearly identical to the query.
        let written = upsert_chunks_conn(
            &conn,
            "doc-a",
            &[
                UpsertChunk {
                    index: 0,
                    content: "closest match".into(),
                    embedding: sample(1.0, 0.05, 0.0),
                },
                UpsertChunk {
                    index: 1,
                    content: "orthogonal".into(),
                    embedding: sample(0.0, 0.0, 1.0),
                },
            ],
        )
        .expect("insert doc-a");
        assert_eq!(written, 2);

        // Doc B lands in a different dimension bucket and must be ignored.
        upsert_chunks_conn(
            &conn,
            "doc-b",
            &[UpsertChunk {
                index: 0,
                content: "other model".into(),
                embedding: vec![1.0, 2.0],
            }],
        )
        .expect("insert doc-b");

        let hits = search_conn(&conn, &sample(1.0, 0.0, 0.0), 5, None).expect("search");
        assert_eq!(hits.len(), 2, "mismatched-dimension rows are skipped");
        assert_eq!(hits[0].doc_id, "doc-a");
        assert_eq!(hits[0].chunk_index, 0);
        assert!(hits[0].score > 0.99);

        // doc_ids filter narrows results.
        let empty: Vec<String> = Vec::new();
        let filtered =
            search_conn(&conn, &sample(1.0, 0.0, 0.0), 5, Some(&empty)).expect("filtered");
        assert!(filtered.is_empty());

        // top_k is respected.
        let one = search_conn(&conn, &sample(1.0, 0.0, 0.0), 1, None).expect("top-1");
        assert_eq!(one.len(), 1);
    }

    #[test]
    fn reupsert_updates_in_place_without_duplicates() {
        let conn = memory_db();
        upsert_chunks_conn(
            &conn,
            "doc",
            &[UpsertChunk {
                index: 0,
                content: "old".into(),
                embedding: sample(1.0, 0.0, 0.0),
            }],
        )
        .expect("first write");
        upsert_chunks_conn(
            &conn,
            "doc",
            &[UpsertChunk {
                index: 0,
                content: "new".into(),
                embedding: sample(0.0, 1.0, 0.0),
            }],
        )
        .expect("second write");

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM vectors", [], |row| row.get(0))
            .expect("count");
        assert_eq!(count, 1);

        let hits = search_conn(&conn, &sample(0.0, 1.0, 0.0), 5, None).expect("search");
        assert_eq!(hits[0].content, "new");
    }

    #[test]
    fn mixed_dimensions_inside_one_doc_are_rejected() {
        let conn = memory_db();
        let err = upsert_chunks_conn(
            &conn,
            "doc",
            &[
                UpsertChunk {
                    index: 0,
                    content: "a".into(),
                    embedding: vec![1.0, 2.0, 3.0],
                },
                UpsertChunk {
                    index: 1,
                    content: "b".into(),
                    embedding: vec![1.0, 2.0],
                },
            ],
        )
        .expect_err("must reject");
        assert!(err.contains("相同维度"));
    }

    #[test]
    fn failed_midway_upsert_rolls_back_all_chunks() {
        let conn = memory_db();
        // Deterministic mid-transaction failure: abort the second INSERT.
        conn.execute_batch(
            "CREATE TRIGGER fail_second AFTER INSERT ON vectors
             WHEN NEW.chunk_index = 1 BEGIN
                 SELECT RAISE(ABORT, 'boom');
             END;",
        )
        .expect("create trigger");

        // Atomicity is supplied by the caller's transaction (as in ingest /
        // the standalone command), not by upsert_chunks_conn itself.
        let tx = conn.unchecked_transaction().expect("begin tx");
        let err = upsert_chunks_conn(
            &tx,
            "doc",
            &[
                UpsertChunk {
                    index: 0,
                    content: "first".into(),
                    embedding: sample(1.0, 0.0, 0.0),
                },
                UpsertChunk {
                    index: 1,
                    content: "second".into(),
                    embedding: sample(1.0, 0.0, 0.0),
                },
                UpsertChunk {
                    index: 2,
                    content: "third".into(),
                    embedding: sample(1.0, 0.0, 0.0),
                },
            ],
        )
        .expect_err("second insert must abort");
        assert!(err.contains("failed to store chunk"));
        // Dropping the transaction without commit rolls everything back.
        drop(tx);

        // Rollback means not even the first chunk survived.
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM vectors", [], |row| row.get(0))
            .expect("count");
        assert_eq!(count, 0);
    }

    #[test]
    fn delete_removes_only_target_document() {
        let conn = memory_db();
        for doc in ["doc-1", "doc-2"] {
            upsert_chunks_conn(
                &conn,
                doc,
                &[UpsertChunk {
                    index: 0,
                    content: doc.into(),
                    embedding: sample(1.0, 0.0, 0.0),
                }],
            )
            .expect("seed");
        }
        let removed = delete_doc_conn(&conn, "doc-1").expect("delete");
        assert_eq!(removed, 1);
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM vectors", [], |row| row.get(0))
            .expect("count");
        assert_eq!(count, 1);
    }
}
