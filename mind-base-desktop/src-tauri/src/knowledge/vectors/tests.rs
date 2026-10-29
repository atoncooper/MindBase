//! 跨子模块的向量库集成测试（写入 / 检索 / 删除 / FTS 融合）。

use super::fts::fts_search_conn;
use super::*;

    fn sample(a: f32, b: f32, c: f32) -> Vec<f32> {
        vec![a, b, c]
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
    fn fts_sync_and_hybrid_fusion_rank_exact_hits() {
        let conn = memory_db();

        // Doc A: semantically closest to the query vector, but never mentions
        // the exact term. Doc B: orthogonal to the query vector — ONLY
        // reachable through the BM25 channel via its exact-term marker.
        upsert_chunks_conn(
            &conn,
            "doc-a",
            &[UpsertChunk {
                index: 0,
                content: "模型通过相似度找到相关内容".into(),
                embedding: sample(1.0, 0.02, 0.0),
            }],
        )
        .expect("doc-a");
        upsert_chunks_conn(
            &conn,
            "doc-b",
            &[UpsertChunk {
                index: 0,
                content: "错误码 ERR_RAG_40412 表示检索服务不可用".into(),
                embedding: sample(0.0, 1.0, 0.0),
            }],
        )
        .expect("doc-b");

        // The exact term "ERR_RAG_40412" is invisible to cosine but BM25
        // must surface doc-b, and RRF places it alongside doc-a.
        let hits = hybrid_search_conn(
            &conn,
            &sample(1.0, 0.0, 0.0),
            "ERR_RAG_40412 是什么",
            5,
            None,
        )
        .expect("hybrid search");
        assert_eq!(hits.len(), 2, "both channels feed the fusion");
        let docs: Vec<&str> = hits.iter().map(|hit| hit.doc_id.as_str()).collect();
        assert!(docs.contains(&"doc-b"), "bm25-only hit must survive fusion");

        // Re-upsert replaces the FTS row instead of duplicating it: the BM25
        // channel alone must stop matching the removed marker.
        upsert_chunks_conn(
            &conn,
            "doc-b",
            &[UpsertChunk {
                index: 0,
                content: "换成别的内容 no marker anymore".into(),
                embedding: sample(0.0, 1.0, 0.0),
            }],
        )
        .expect("doc-b rewrite");
        let fts_hits = fts_search_conn(&conn, "ERR_RAG_40412", 5, None).expect("fts after rewrite");
        assert!(
            !fts_hits.iter().any(|(doc_id, _, _)| doc_id == "doc-b"),
            "stale FTS rows must not survive a rewrite"
        );

        // Deleting a document drops its FTS rows too.
        delete_doc_conn(&conn, "doc-b").expect("delete doc-b");
        let fts_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM vectors_fts", [], |row| row.get(0))
            .expect("fts count");
        assert_eq!(fts_count, 1, "only doc-a's row remains indexed");
    }

    #[test]
    fn hybrid_degrades_to_vector_channel_on_tokenless_query() {
        let conn = memory_db();
        upsert_chunks_conn(
            &conn,
            "doc",
            &[UpsertChunk {
                index: 0,
                content: "some content".into(),
                embedding: sample(1.0, 0.0, 0.0),
            }],
        )
        .expect("seed");
        // "！！？" tokenizes to nothing → FTS skips, vector results pass through.
        let hits =
            hybrid_search_conn(&conn, &sample(1.0, 0.0, 0.0), "！！？", 5, None).expect("hybrid");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].doc_id, "doc");
    }
