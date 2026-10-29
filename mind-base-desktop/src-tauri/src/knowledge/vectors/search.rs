//! 向量检索：余弦暴力扫描与 BM25/RRF 混合融合。

use rusqlite::Connection;

use super::fts::fts_search_conn;
use super::store::{cosine, decode_embedding};
use super::types::SearchHit;
use super::{MAX_DIM, MAX_TOP_K};

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

/// Hybrid retrieval: vector cosine + FTS5 BM25, fused with Reciprocal Rank
/// Fusion. BM25 rescues exact-term matches (错误码、专有名词、代码标识符)
/// that embeddings blur away; RRF (`1 / (60 + rank)`) merges both rankings
/// without any score-scale tuning. Either channel failing alone degrades
/// gracefully to the other.
pub(crate) fn hybrid_search_conn(
    conn: &Connection,
    query_embedding: &[f32],
    query_text: &str,
    top_k: u32,
    doc_ids: Option<&[String]>,
) -> Result<Vec<SearchHit>, String> {
    let top_k = top_k.clamp(1, MAX_TOP_K) as usize;
    /// Candidates fetched per channel before fusion.
    const FUSION_POOL: usize = 20;
    /// Classic RRF smoothing constant (from the paper).
    const RRF_K: f32 = 60.0;

    let vector_hits = search_conn(conn, query_embedding, FUSION_POOL as u32, doc_ids)?;
    let fts_hits = fts_search_conn(conn, query_text, FUSION_POOL, doc_ids)?;
    if fts_hits.is_empty() {
        return Ok(vector_hits.into_iter().take(top_k).collect());
    }

    let mut scores: std::collections::HashMap<(String, i64), f32> =
        std::collections::HashMap::new();
    let mut contents: std::collections::HashMap<(String, i64), String> =
        std::collections::HashMap::new();
    for (rank, hit) in vector_hits.iter().enumerate() {
        *scores
            .entry((hit.doc_id.clone(), hit.chunk_index))
            .or_default() += 1.0 / (RRF_K + rank as f32);
    }
    for (rank, (doc_id, chunk_index, content)) in fts_hits.iter().enumerate() {
        *scores
            .entry((doc_id.clone(), *chunk_index))
            .or_default() += 1.0 / (RRF_K + rank as f32);
        contents.entry((doc_id.clone(), *chunk_index)).or_insert_with(|| content.clone());
    }

    let mut fused: Vec<((String, i64), f32)> = scores.into_iter().collect();
    fused.sort_by(|a, b| b.1.total_cmp(&a.1));
    fused.truncate(top_k);
    Ok(fused
        .into_iter()
        .map(|((doc_id, chunk_index), score)| {
            let content = contents.get(&(doc_id.clone(), chunk_index)).cloned();
            SearchHit {
                doc_id,
                chunk_index,
                // Vector-channel hits carry content in their payload; FTS-only
                // hits got it from the join above.
                content: content.unwrap_or_default(),
                score,
            }
        })
        .collect())
}
