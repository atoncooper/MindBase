//! 知识检索：混合召回 + 文档元数据附加，以及语义搜索命令。

use std::collections::HashMap;

use rusqlite::params;
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::infra::db::Db;
use crate::knowledge::vectors::{self, SearchHit};
use crate::llm::embeddings::embed_client_from_conn;

use super::documents::page_url;

/// Default hits returned by workspace search.
const DEFAULT_TOP_K: u32 = 8;

/// One search hit with its document metadata attached.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeHit {
    pub doc_id: String,
    pub chunk_index: i64,
    pub content: String,
    pub score: f32,
    pub bvid: String,
    pub page_index: i64,
    pub video_title: String,
    pub page_title: String,
    pub url: String,
}

/// Attach document metadata to raw vector hits; misses degrade to blanks.
pub(crate) fn join_metadata(
    conn: &rusqlite::Connection,
    hits: Vec<SearchHit>,
) -> Result<Vec<KnowledgeHit>, String> {
    let doc_ids: Vec<String> = hits.iter().map(|hit| hit.doc_id.clone()).collect();
    let mut meta: HashMap<String, (String, i64, String, String)> = HashMap::new();
    for doc_id in &doc_ids {
        if meta.contains_key(doc_id) {
            continue;
        }
        let row = conn
            .query_row(
                "SELECT bvid, page_index, video_title, page_title FROM documents WHERE doc_id = ?1",
                params![doc_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .ok();
        if let Some((bvid, page_index, video_title, page_title)) = row {
            meta.insert(
                doc_id.clone(),
                (bvid, page_index, video_title, page_title),
            );
        }
    }
    Ok(hits
        .into_iter()
        .map(|hit| {
            let (bvid, page_index, video_title, page_title) = meta
                .get(&hit.doc_id)
                .cloned()
                .unwrap_or_default();
            let url = if bvid.is_empty() {
                String::new()
            } else {
                page_url(&bvid, page_index)
            };
            KnowledgeHit {
                doc_id: hit.doc_id,
                chunk_index: hit.chunk_index,
                content: hit.content,
                score: hit.score,
                bvid,
                page_index,
                video_title,
                page_title,
                url,
            }
        })
        .collect())
}

/// Semantic workspace search: query → embedding → hybrid (cosine + BM25 RRF
/// fusion) top-k + metadata.
#[tauri::command]
pub async fn search_knowledge(
    app: AppHandle,
    query: String,
    top_k: Option<u32>,
) -> Result<Vec<KnowledgeHit>, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Err("请输入查询内容".to_string());
    }
    let client = {
        let db = app.state::<Db>();
        let conn = db
            .conn
            .lock()
            .map_err(|err| format!("failed to acquire database lock: {err}"))?;
        embed_client_from_conn(&conn)?
    };

    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let db = handle.state::<Db>();
        let vector = client.embed_query(&query)?;
        let top_k = top_k.unwrap_or(DEFAULT_TOP_K).clamp(1, 50);
        let conn = db
            .conn
            .lock()
            .map_err(|err| format!("failed to acquire database lock: {err}"))?;
        let hits = vectors::hybrid_search_conn(&conn, &vector, &query, top_k, None)?;
        join_metadata(&conn, hits)
    })
    .await
    .map_err(|err| format!("task failed: {err}"))?
}

// ---------------------------------------------------------------------------
