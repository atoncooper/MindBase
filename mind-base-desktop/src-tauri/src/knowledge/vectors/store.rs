//! 向量存储：embedding blob 编解码、余弦相似度、分块写入与文档级删除。

use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};

use super::fts::index_tokens;
use super::types::UpsertChunk;
use super::MAX_DIM;

/// Encode an embedding as a little-endian f32 blob.
fn encode_embedding(values: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(values.len() * 4);
    for value in values {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes
}

/// Decode a stored blob back into `dim` f32 values; `None` on size mismatch.
pub(super) fn decode_embedding(blob: &[u8], dim: usize) -> Option<Vec<f32>> {
    if blob.len() != dim * 4 {
        return None;
    }
    blob.chunks_exact(4)
        .map(|chunk| Some(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]])))
        .collect()
}

/// Cosine similarity with zero-norm guards; falls back to 0.0.
pub(super) fn cosine(a: &[f32], b: &[f32]) -> f32 {
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
        // Keep the BM25 index in lockstep (caller owns the transaction, so
        // vector + FTS rows commit or roll back together).
        let tokens = index_tokens(&chunk.content).join(" ");
        conn.execute(
            "DELETE FROM vectors_fts WHERE doc_id = ?1 AND chunk_index = ?2",
            params![doc_id.trim(), chunk.index],
        )
        .map_err(|err| format!("failed to sync fts index: {err}"))?;
        conn.execute(
            "INSERT INTO vectors_fts(content, doc_id, chunk_index) VALUES(?1, ?2, ?3)",
            params![tokens, doc_id.trim(), chunk.index],
        )
        .map_err(|err| format!("failed to sync fts index: {err}"))?;
        written += affected;
    }
    Ok(written)
}

/// Delete every chunk of one document; returns the number removed.
pub(crate) fn delete_doc_conn(conn: &Connection, doc_id: &str) -> Result<usize, String> {
    let removed = conn
        .execute(
            "DELETE FROM vectors WHERE doc_id = ?1",
            params![doc_id.trim()],
        )
        .map_err(|err| format!("failed to delete document vectors: {err}"))?;
    conn.execute(
        "DELETE FROM vectors_fts WHERE doc_id = ?1",
        params![doc_id.trim()],
    )
    .map_err(|err| format!("failed to delete fts index: {err}"))?;
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge::vectors::{memory_db, search_conn};

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
