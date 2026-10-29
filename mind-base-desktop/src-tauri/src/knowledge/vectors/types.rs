//! 向量库的对外数据类型：待写入分块、检索命中与存储统计。

use serde::{Deserialize, Serialize};

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
