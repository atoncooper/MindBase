//! BM25 关键词通道：CJK/ASCII 分词、FTS5 匹配表达式与检索。

use rusqlite::Connection;

// ---------------------------------------------------------------------------
// Hybrid retrieval: BM25 (FTS5) fused with the vector channel via RRF
// ---------------------------------------------------------------------------

/// `true` for CJK ideograph ranges (the characters bigram tokenization is for).
fn is_cjk(ch: char) -> bool {
    matches!(
        ch as u32,
        0x4E00..=0x9FFF | 0x3400..=0x4DBF | 0xF900..=0xFAFF | 0x20000..=0x2A6DF
    )
}

/// Tokenize text for BM25 matching: CJK runs become character bigrams (a
/// lone CJK char stays whole), ASCII runs become lowercased words, everything
/// else separates. The FTS5 default tokenizer splits on the spaces we join
/// with, so plain `unicode61` handles Chinese without a custom tokenizer —
/// critical because unicode61 alone treats a whole CJK sentence as ONE token
/// and Chinese queries would never match.
pub(crate) fn index_tokens(text: &str) -> Vec<String> {
    fn flush_ascii(ascii: &mut String, tokens: &mut Vec<String>) {
        if !ascii.is_empty() {
            tokens.push(std::mem::take(ascii).to_lowercase());
        }
    }
    fn flush_cjk(cjk: &mut Vec<char>, tokens: &mut Vec<String>) {
        if cjk.len() == 1 {
            tokens.push(cjk[0].to_string());
        } else {
            for pair in cjk.windows(2) {
                tokens.push(pair.iter().collect());
            }
        }
        cjk.clear();
    }

    let mut tokens = Vec::new();
    let mut ascii = String::new();
    let mut cjk: Vec<char> = Vec::new();
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() {
            flush_cjk(&mut cjk, &mut tokens);
            ascii.push(ch);
        } else if is_cjk(ch) {
            flush_ascii(&mut ascii, &mut tokens);
            cjk.push(ch);
        } else {
            flush_ascii(&mut ascii, &mut tokens);
            flush_cjk(&mut cjk, &mut tokens);
        }
    }
    flush_ascii(&mut ascii, &mut tokens);
    flush_cjk(&mut cjk, &mut tokens);
    tokens
}

/// Build the FTS5 MATCH expression for a query: each token double-quoted and
/// OR-joined. OR favors recall — the vector channel supplies precision, and
/// bm25() ranks documents matching more/longer tokens above the rest.
fn fts_match_expression(query: &str) -> Option<String> {
    let tokens = index_tokens(query);
    if tokens.is_empty() {
        return None;
    }
    Some(
        tokens
            .iter()
            .map(|token| format!("\"{}\"", token.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" OR "),
    )
}

/// BM25 keyword search over the FTS index; returns chunk keys ranked by
/// bm25 (best first). Empty when the query has no usable tokens.
pub(super) fn fts_search_conn(
    conn: &Connection,
    query: &str,
    limit: usize,
    doc_ids: Option<&[String]>,
) -> Result<Vec<(String, i64, String)>, String> {
    let Some(match_query) = fts_match_expression(query) else {
        return Ok(Vec::new());
    };
    // SQL shape depends on the filter; both branches share the ordering.
    let sql = if doc_ids.is_some() {
        "SELECT v.doc_id, v.chunk_index, v.content
         FROM vectors_fts f
         JOIN vectors v ON v.doc_id = f.doc_id AND v.chunk_index = f.chunk_index
         WHERE vectors_fts MATCH ?1 AND v.doc_id IN (SELECT value FROM json_each(?2))
         ORDER BY bm25(vectors_fts)
         LIMIT ?3"
    } else {
        "SELECT v.doc_id, v.chunk_index, v.content
         FROM vectors_fts f
         JOIN vectors v ON v.doc_id = f.doc_id AND v.chunk_index = f.chunk_index
         WHERE vectors_fts MATCH ?1
         ORDER BY bm25(vectors_fts)
         LIMIT ?3"
    };
    let mut statement = conn
        .prepare(sql)
        .map_err(|err| format!("failed to prepare fts search: {err}"))?;
    let json_filter = serde_json::to_string(&doc_ids.unwrap_or(&[])).unwrap_or_default();
    let rows = statement
        .query_map(
            rusqlite::params![match_query, json_filter, limit as i64],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .map_err(|err| format!("failed to run fts search: {err}"))?;
    Ok(rows.filter_map(Result::ok).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_tokens_bigrams_cjk_and_ascii_words() {
        assert_eq!(
            index_tokens("向量检索 RAG"),
            vec!["向量", "量检", "检索", "rag"]
        );
        // A lone CJK char stays whole instead of vanishing.
        assert_eq!(index_tokens("问"), vec!["问"]);
        // ASCII words lowercase; punctuation and spaces only separate.
        assert_eq!(index_tokens("HTTP-2!"), vec!["http", "2"]);
        assert!(index_tokens("。。。！！").is_empty());
    }
}
