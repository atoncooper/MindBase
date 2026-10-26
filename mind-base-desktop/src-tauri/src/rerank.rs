//! Rerank: 对混合检索候选做一次语义精排（DashScope gte-rerank）。
//!
//! 链路：vector_search → hybrid_search_conn（余弦 + BM25）→ rerank → join_metadata。
//! 设计约束：
//! - 永远不阻断检索：未配置 key / 网络失败 / 解析失败 → 原顺序返回（只 eprintln）。
//! - 只认 DashScope 原生 rerank 端点（compatible-mode 的 base 会自动归一到原生 URL）；
//!   其他自定义 base 视为完整 URL，便于代理/自建网关。
//! - 默认开启（有 DashScope key 即生效），环境变量 MIND_BASE_RERANK=off 可关闭；
//!   MIND_BASE_RERANK_MODEL / MIND_BASE_RERANK_URL 可覆盖（模型/端点）。

use std::time::Duration;

use serde_json::{json, Value};

use crate::vectors::SearchHit;

const NATIVE_URL: &str =
    "https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank";
const DEFAULT_MODEL: &str = "gte-rerank-v2";
const TIMEOUT: Duration = Duration::from_secs(10);
/// 单条候选送排文本上限：chunk 一般 750 字，这里留足余量又避免长文费用。
const DOC_CHAR_CAP: usize = 4000;

pub(crate) struct RerankClient {
    url: String,
    api_key: String,
    model: String,
}

impl RerankClient {
    /// Build the client from the stored credentials (rerank slot, else DashScope).
    /// Returns None when disabled or unconfigured — callers keep the fusion order.
    pub(crate) fn from_conn(conn: &rusqlite::Connection) -> Result<Option<Self>, String> {
        if !enabled() {
            return Ok(None);
        }
        let slot = match crate::api_keys::read_raw_config(conn, "rerank")? {
            Some(value) => Some(value),
            None => crate::api_keys::read_raw_config(conn, "dashscope")?,
        };
        let Some((api_key, base)) = slot else {
            return Ok(None);
        };
        let model = std::env::var("MIND_BASE_RERANK_MODEL")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| {
                let stored = crate::api_keys::read_model(conn, "rerank").unwrap_or_default();
                if stored.trim().is_empty() {
                    DEFAULT_MODEL.to_string()
                } else {
                    stored.trim().to_string()
                }
            });
        let url = std::env::var("MIND_BASE_RERANK_URL")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| resolve_url(&base));
        Ok(Some(Self {
            url,
            api_key,
            model,
        }))
    }

    /// Score every hit and return the new index order (all indices, best first).
    pub(crate) fn rerank(&self, query: &str, hits: &[SearchHit]) -> Result<Vec<usize>, String> {
        if hits.len() < 2 {
            return Ok((0..hits.len()).collect());
        }
        let documents: Vec<String> = hits
            .iter()
            .map(|hit| truncate_chars(&hit.content, DOC_CHAR_CAP))
            .collect();
        let body = build_payload(&self.model, query, &documents);
        let (primary, fallback) = crate::api_keys::egress_agents(TIMEOUT, &self.url)?;
        let raw = match post_json(&primary, &self.url, &self.api_key, &body) {
            Ok(text) => text,
            Err(first) => match fallback {
                Some(agent) => post_json(&agent, &self.url, &self.api_key, &body)
                    .map_err(|second| format!("{first}；重试：{second}"))?,
                None => return Err(first),
            },
        };
        let value: Value =
            serde_json::from_str(&raw).map_err(|err| format!("rerank 响应非 JSON：{err}"))?;
        parse_order(&value, hits.len())
    }
}

fn enabled() -> bool {
    match std::env::var("MIND_BASE_RERANK") {
        Ok(value) => {
            let value = value.trim().to_ascii_lowercase();
            !matches!(value.as_str(), "off" | "0" | "false" | "no")
        }
        Err(_) => true,
    }
}

/// DashScope-compatible base URLs (compatible-mode) must map to the native
/// rerank endpoint; any other custom base is treated as a full endpoint URL.
fn resolve_url(base: &str) -> String {
    let base = base.trim();
    if base.is_empty() || base.contains("dashscope.aliyuncs.com") {
        NATIVE_URL.to_string()
    } else {
        base.trim_end_matches('/').to_string()
    }
}

fn build_payload(model: &str, query: &str, documents: &[String]) -> String {
    json!({
        "model": model,
        "input": { "query": query, "documents": documents },
        "parameters": { "return_documents": false, "top_n": documents.len() }
    })
    .to_string()
}

fn post_json(agent: &ureq::Agent, url: &str, key: &str, body: &str) -> Result<String, String> {
    let response = agent
        .post(url)
        .set("Authorization", &format!("Bearer {key}"))
        .set("Content-Type", "application/json")
        .send_string(body);
    match response {
        Ok(resp) => resp.into_string().map_err(|err| format!("读取响应失败：{err}")),
        Err(ureq::Error::Status(code, resp)) => {
            let detail: String = resp
                .into_string()
                .unwrap_or_default()
                .chars()
                .take(200)
                .collect();
            Err(format!("HTTP {code}: {detail}"))
        }
        Err(err) => Err(format!("请求失败：{err}")),
    }
}

/// Parse the provider response into a complete index order.
/// output.results[] is the documented shape; a bare results[] is tolerated.
fn parse_order(value: &Value, len: usize) -> Result<Vec<usize>, String> {
    let results = value
        .get("output")
        .and_then(|output| output.get("results"))
        .and_then(Value::as_array)
        .or_else(|| value.get("results").and_then(Value::as_array))
        .ok_or_else(|| {
            format!(
                "rerank 响应缺少 results：{}",
                value.to_string().chars().take(200).collect::<String>()
            )
        })?;
    let mut scored: Vec<(usize, f64)> = results
        .iter()
        .filter_map(|result| {
            let index = result.get("index").and_then(Value::as_u64)? as usize;
            let score = result
                .get("relevance_score")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            (index < len).then_some((index, score))
        })
        .collect();
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let mut used = vec![false; len];
    let mut order = Vec::with_capacity(len);
    for (index, _) in scored {
        if !used[index] {
            used[index] = true;
            order.push(index);
        }
    }
    // Provider may omit low-score rows (top_n); keep every hit exactly once.
    for (index, seen) in used.iter().enumerate() {
        if !seen {
            order.push(index);
        }
    }
    Ok(order)
}

fn truncate_chars(text: &str, cap: usize) -> String {
    if text.chars().count() <= cap {
        text.to_string()
    } else {
        text.chars().take(cap).collect()
    }
}

/// Apply an index order to the hit list; unknown/duplicate indices are ignored,
/// missing hits keep their original relative order at the tail.
pub(crate) fn reorder(hits: Vec<SearchHit>, order: &[usize]) -> Vec<SearchHit> {
    let mut slots: Vec<Option<SearchHit>> = hits.into_iter().map(Some).collect();
    let mut out = Vec::with_capacity(slots.len());
    for &index in order {
        if let Some(slot) = slots.get_mut(index) {
            if let Some(hit) = slot.take() {
                out.push(hit);
            }
        }
    }
    for slot in slots {
        if let Some(hit) = slot {
            out.push(hit);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(doc_id: &str, score: f32) -> SearchHit {
        SearchHit {
            doc_id: doc_id.to_string(),
            chunk_index: 0,
            content: format!("content-{doc_id}"),
            score,
        }
    }

    #[test]
    fn resolve_url_uses_native_for_dashscope_and_custom_otherwise() {
        assert_eq!(resolve_url(""), NATIVE_URL);
        assert_eq!(
            resolve_url("https://dashscope.aliyuncs.com/compatible-mode/v1"),
            NATIVE_URL
        );
        assert_eq!(
            resolve_url("https://gateway.example.com/rerank/"),
            "https://gateway.example.com/rerank"
        );
    }

    #[test]
    fn payload_carries_model_query_documents_and_top_n() {
        let body = build_payload("gte-rerank-v2", "查询", &["甲".to_string(), "乙".to_string()]);
        let value: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(value["model"], "gte-rerank-v2");
        assert_eq!(value["input"]["query"], "查询");
        assert_eq!(value["input"]["documents"][1], "乙");
        assert_eq!(value["parameters"]["top_n"], 2);
        assert_eq!(value["parameters"]["return_documents"], false);
    }

    #[test]
    fn parse_order_sorts_by_score_and_keeps_omitted_rows() {
        let value: Value = serde_json::from_str(
            r#"{"output":{"results":[{"index":2,"relevance_score":0.1},{"index":0,"relevance_score":0.9}]}}"#,
        )
        .unwrap();
        assert_eq!(parse_order(&value, 3).unwrap(), vec![0, 2, 1]);
    }

    #[test]
    fn parse_order_rejects_missing_results() {
        let value: Value = serde_json::from_str(r#"{"output":{}}"#).unwrap();
        assert!(parse_order(&value, 3).is_err());
    }

    #[test]
    fn reorder_moves_ranked_hits_and_appends_unranked_ones() {
        let hits = vec![hit("a", 0.9), hit("b", 0.5), hit("c", 0.1)];
        let ordered = reorder(hits, &[2, 0]);
        let ids: Vec<&str> = ordered.iter().map(|h| h.doc_id.as_str()).collect();
        assert_eq!(ids, vec!["c", "a", "b"]);
    }

    #[test]
    fn reorder_ignores_out_of_range_and_duplicate_indices() {
        let hits = vec![hit("a", 0.9), hit("b", 0.5)];
        let ordered = reorder(hits, &[5, 1, 1]);
        let ids: Vec<&str> = ordered.iter().map(|h| h.doc_id.as_str()).collect();
        assert_eq!(ids, vec!["b", "a"]);
    }

    #[test]
    fn truncate_chars_is_char_safe_for_cjk() {
        assert_eq!(truncate_chars("中文abc", 3), "中文a");
        assert_eq!(truncate_chars("短", 10), "短");
    }
}
