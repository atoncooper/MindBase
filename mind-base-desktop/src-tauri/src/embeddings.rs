//! OpenAI-compatible embeddings client — provider-agnostic.
//!
//! Speaks the standard OpenAI `POST {base}/embeddings` contract (`model` +
//! `input`, `Bearer` auth, `data[].embedding` responses), so any provider
//! exposing an OpenAI-compatible embeddings endpoint works out of the box:
//! DashScope compatible-mode, OpenRouter, OpenAI, or a self-hosted gateway.
//!
//! The embedding slot (Base URL + key + model) fully determines the endpoint
//! and model. An empty slot falls back to the DashScope credential as a
//! convenience. The actual vector dimension is read from the response and
//! stored per document, so it adapts to each provider's native output.

use std::time::Duration;

use rusqlite::Connection;

use crate::api_keys;

const EMBED_MODEL_DEFAULT: &str = "text-embedding-v4";
/// Texts per request (DashScope compatible-mode batch cap is small).
pub(crate) const BATCH_SIZE: usize = 10;
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);

/// Max characters sent to the provider as one embedding input. Models differ
/// wildly in input-token limits (512 tokens for OpenRouter's liquid/*
/// embedding models, 8192 for DashScope text-embedding-*), and a 400
/// "exceeding the model maximum" kills the whole ingest page. Splitting the
/// chunk at call time and mean-pooling the part vectors keeps every provider
/// under its cap with no per-model configuration, and the pooled vector
/// still represents all of the chunk's content.
const EMBED_INPUT_CHAR_BUDGET: usize = 400;

/// Build an embeddings client from locally stored credentials. The dedicated
/// `embedding` slot wins when configured; otherwise fall back to the shared
/// DashScope credential (chat key doubles as the embedding key).
/// `None` = 没有任何可用密钥——对话轮次据此跳过检索，入库则直接报错。
pub(crate) fn embed_client_from_conn_opt(
    conn: &Connection,
) -> Result<Option<EmbedClient>, String> {
    let from_slot = api_keys::read_raw_config(conn, "embedding")?;
    let (api_key, custom_base, provider) = match from_slot {
        Some((key, base)) => (key, base, "embedding"),
        None => match api_keys::read_raw_config(conn, "dashscope")? {
            Some((key, base)) => (key, base, "dashscope"),
            None => return Ok(None),
        },
    };
    let base_url = if custom_base.trim().is_empty() {
        api_keys::default_endpoint(provider).to_string()
    } else {
        custom_base.trim().trim_end_matches('/').to_string()
    };
    let stored_model = api_keys::read_model(conn, "embedding")?;
    // Honor the embedding slot's explicit model verbatim (it may be a
    // third-party name like an OpenRouter embedding model); only an empty
    // value falls back to the DashScope default.
    let model = resolve_embed_model(&stored_model);
    Ok(Some(EmbedClient::new(base_url, api_key, model)?))
}

/// Strict variant for pipelines that cannot proceed without embeddings
/// (ingestion): turns the `None` case into an actionable error.
pub(crate) fn embed_client_from_conn(conn: &Connection) -> Result<EmbedClient, String> {
    embed_client_from_conn_opt(conn)?.ok_or_else(|| {
        "未配置向量化（Embedding）密钥：请在「API 设置」的向量化卡片填写任意 OpenAI 兼容的 Embedding 端点（DashScope/OpenRouter/OpenAI 等），或先配置 DashScope 密钥"
            .to_string()
    })
}

/// Blocking embeddings client with the standard direct-then-proxy retry.
#[derive(Clone)]
pub(crate) struct EmbedClient {
    direct: ureq::Agent,
    via_proxy: Option<ureq::Agent>,
    base_url: String,
    api_key: String,
    model: String,
}

impl EmbedClient {
    fn new(base_url: String, api_key: String, model: String) -> Result<Self, String> {
        Ok(Self {
            direct: api_keys::direct_agent(HTTP_TIMEOUT)?,
            via_proxy: api_keys::proxied_agent(HTTP_TIMEOUT)?,
            base_url,
            api_key,
            model,
        })
    }

    pub(crate) fn model_name(&self) -> &str {
        &self.model
    }

    /// Build one request payload for a batch of texts.
    fn build_payload(texts: &[String]) -> serde_json::Value {
        serde_json::json!({
            "model": "MODEL",
            "input": texts
        })
        // Model is injected by the caller below; placeholder keeps this
        // function pure for tests.
    }

    /// Embed one batch; preserves order via the response `index` field.
    fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
        let url = format!("{}/embeddings", self.base_url);
        let attempt = |agent: &ureq::Agent| -> Result<String, String> {
            let mut payload = Self::build_payload(texts);
            payload["model"] = serde_json::Value::String(self.model.clone());
            let response = agent
                .post(&url)
                .set("Authorization", &format!("Bearer {}", self.api_key))
                .set("Content-Type", "application/json")
                .send_json(payload)
                .map_err(|err| match err {
                    ureq::Error::Status(code, response) => {
                        let detail = response
                            .into_string()
                            .unwrap_or_default();
                        format!("Embedding 调用失败（HTTP {code}）：{}", truncate(&detail, 200))
                    }
                    other => format!("Embedding 请求失败：{other}"),
                })?;
            response
                .into_string()
                .map_err(|err| format!("读取 Embedding 响应失败：{err}"))
        };
        let body = match attempt(&self.direct) {
            Ok(body) => body,
            Err(direct_err) => match &self.via_proxy {
                Some(proxy_agent) => attempt(proxy_agent)
                    .map_err(|proxy_err| format!("{direct_err}；经代理重试仍失败：{proxy_err}"))?,
                None => return Err(direct_err),
            },
        };
        parse_embeddings_response(&body, texts.len())
    }

    /// Embed any number of texts in batches of [`BATCH_SIZE`]. Texts longer
    /// than [`EMBED_INPUT_CHAR_BUDGET`] are split, embedded per part, and
    /// mean-pooled back into one vector so a provider's input-token cap can
    /// never fail an ingest (see the constant's docs).
    pub(crate) fn embed_texts(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        // Flatten every original text into 1..n parts within the budget.
        let mut parts: Vec<String> = Vec::new();
        let mut spans: Vec<(usize, usize)> = Vec::with_capacity(texts.len());
        for text in texts {
            let start = parts.len();
            parts.extend(split_for_embedding(text, EMBED_INPUT_CHAR_BUDGET));
            spans.push((start, parts.len() - start));
        }
        let mut part_vectors: Vec<Vec<f32>> = Vec::with_capacity(parts.len());
        for batch in parts.chunks(BATCH_SIZE) {
            part_vectors.extend(self.embed_batch(batch)?);
        }
        // Mean-pool each text's part vectors back into one embedding.
        let mut all: Vec<Vec<f32>> = Vec::with_capacity(texts.len());
        for (start, len) in spans {
            if len == 1 {
                all.push(part_vectors[start].clone());
                continue;
            }
            let mut pooled = vec![0f32; part_vectors[start].len()];
            for vector in &part_vectors[start..start + len] {
                for (acc, value) in pooled.iter_mut().zip(vector) {
                    *acc += value;
                }
            }
            let count = len as f32;
            for value in &mut pooled {
                *value /= count;
            }
            all.push(pooled);
        }
        Ok(all)
    }

    /// Embed a single query string.
    pub(crate) fn embed_query(&self, query: &str) -> Result<Vec<f32>, String> {
        let trimmed = query.trim();
        if trimmed.is_empty() {
            return Err("查询内容不能为空".to_string());
        }
        Ok(self.embed_texts(&[trimmed.to_string()])?.remove(0))
    }
}

/// Split one text into pieces of at most `budget` characters (chars, not
/// bytes), preferring whitespace / sentence-punctuation boundaries near the
/// window end. Short texts pass through as a single piece.
fn split_for_embedding(text: &str, budget: usize) -> Vec<String> {
    if budget == 0 || text.chars().count() <= budget {
        return vec![text.to_string()];
    }
    let chars: Vec<char> = text.chars().collect();
    let is_break = |c: char| {
        c.is_whitespace()
            || matches!(
                c,
                '，' | '。' | '、' | '；' | '！' | '？' | '：' | ',' | '.' | ';' | '!' | '?' | ':'
            )
    };
    let total = chars.len();
    let mut pieces: Vec<String> = Vec::new();
    let mut start = 0usize;
    while start < total {
        let end = (start + budget).min(total);
        if end == total {
            pieces.push(chars[start..].iter().collect());
            break;
        }
        // Prefer the last break point inside the final fifth of the window;
        // a hard cut is the fallback for dense CJK text without breaks.
        let search_lo = start + (budget * 4) / 5;
        let mut cut = end;
        for i in (search_lo..end).rev() {
            if is_break(chars[i]) {
                cut = i + 1;
                break;
            }
        }
        pieces.push(chars[start..cut].iter().collect());
        start = cut;
    }
    pieces.retain(|piece| !piece.trim().is_empty());
    if pieces.is_empty() {
        pieces.push(text.to_string());
    }
    pieces
}

/// Resolve the effective embedding model. The embedding slot's stored model
/// is honored verbatim — it may be a third-party name (e.g. an OpenRouter
/// embedding model), not just `text-embedding-*`. Only an empty value falls
/// back to the DashScope default.
pub(crate) fn resolve_embed_model(stored: &str) -> String {
    let trimmed = stored.trim();
    if trimmed.is_empty() {
        EMBED_MODEL_DEFAULT.to_string()
    } else {
        trimmed.to_string()
    }
}

/// One real embedding probe with a tiny text — used by the settings
/// "测试连接" for the `embedding` slot. This is the check that catches the
/// "test passed but ingest 404" case: it exercises the real `POST
/// {base}/embeddings` route and the configured model, which the `GET
/// {base}/models` probe never does.
pub(crate) fn probe_embedding(
    base_url: &str,
    api_key: &str,
    model: &str,
) -> Result<String, String> {
    let resolved = resolve_embed_model(model);
    let client = EmbedClient::new(base_url.to_string(), api_key.to_string(), resolved)?;
    let vectors = client.embed_texts(&["测试向量化".to_string()])?;
    let vector = vectors
        .first()
        .ok_or_else(|| "端点返回了空向量".to_string())?;
    if vector.is_empty() {
        return Err("端点返回了空向量".to_string());
    }
    Ok(format!("真实向量化成功（维度 {}）", vector.len()))
}

/// Parse an `/embeddings` response body into ordered vectors.
///
/// Pure: sorts by `index`, validates count and consistent dimensions.
fn parse_embeddings_response(body: &str, expected: usize) -> Result<Vec<Vec<f32>>, String> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|err| format!("解析 Embedding 响应失败：{err}"))?;
    if let Some(message) = value.get("error").and_then(|e| e.get("message")).and_then(|m| m.as_str()) {
        return Err(format!("Embedding 接口报错：{message}"));
    }
    let items = value
        .get("data")
        .and_then(|d| d.as_array())
        .ok_or("Embedding 响应缺少 data 数组")?;
    if items.len() != expected {
        return Err(format!(
            "Embedding 返回数量不符：期望 {expected}，实际 {}",
            items.len()
        ));
    }
    let mut indexed: Vec<(usize, Vec<f32>)> = items
        .iter()
        .enumerate()
        .map(|(position, item)| {
            let index = item
                .get("index")
                .and_then(|i| i.as_u64())
                .map(|i| i as usize)
                .unwrap_or(position);
            let vector = item
                .get("embedding")
                .and_then(|e| e.as_array())
                .ok_or("Embedding 条目缺少向量")?;
            let vector: Option<Vec<f32>> = vector
                .iter()
                .map(|v| v.as_f64().map(|f| f as f32))
                .collect();
            Ok((index, vector.ok_or("Embedding 向量含非数值")?))
        })
        .collect::<Result<_, String>>()?;
    indexed.sort_by_key(|(index, _)| *index);
    let dim = indexed.first().map(|(_, v)| v.len()).unwrap_or_default();
    if indexed.iter().any(|(_, v)| v.len() != dim) {
        return Err("Embedding 批次内维度不一致".to_string());
    }
    if dim == 0 {
        return Err("Embedding 向量维度为空".to_string());
    }
    Ok(indexed.into_iter().map(|(_, v)| v).collect())
}

/// Clip long error bodies for display.
fn truncate(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        text.trim().to_string()
    } else {
        let cut: String = text.chars().take(max_chars).collect();
        format!("{cut}…")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_text_is_a_single_piece() {
        assert_eq!(split_for_embedding("你好世界", 400), vec!["你好世界"]);
    }

    #[test]
    fn oversized_text_splits_within_budget_on_breaks() {
        // 30 Chinese chars without breaks around a budget of 10: pieces must
        // all be <= 10 chars and preserve the full content in order.
        let text = "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十";
        let pieces = split_for_embedding(text, 10);
        assert!(pieces.len() >= 3);
        for piece in &pieces {
            assert!(piece.chars().count() <= 10, "piece too long: {piece}");
        }
        let joined: String = pieces.concat();
        assert_eq!(joined, text, "splitting must not lose content");
    }

    #[test]
    fn split_prefers_whitespace_break_points() {
        // 4-char words: with budget 10 the window's final fifth contains a
        // space, so each piece should end at that break (trailing space)
        // instead of cutting mid-word.
        let text = "aaaa bbbb cccc dddd eeee ffff";
        let pieces = split_for_embedding(text, 10);
        assert!(pieces.len() >= 3);
        for piece in pieces.iter().take(pieces.len() - 1) {
            assert!(piece.ends_with(' '), "piece should end at a break: {piece:?}");
        }
        assert_eq!(pieces.concat(), text);
    }

    #[test]
    fn zero_budget_falls_back_to_single_piece() {
        assert_eq!(split_for_embedding("文本", 0), vec!["文本"]);
    }

    #[test]
    fn response_parses_in_index_order() {
        // Deliberately shuffled indexes.
        let body = r#"{
            "data": [
                { "index": 1, "embedding": [0.4, 0.5, 0.6] },
                { "index": 0, "embedding": [0.1, 0.2, 0.3] }
            ]
        }"#;
        let vectors = parse_embeddings_response(body, 2).expect("parse");
        assert_eq!(vectors.len(), 2);
        assert_eq!(vectors[0], vec![0.1, 0.2, 0.3]);
        assert_eq!(vectors[1], vec![0.4, 0.5, 0.6]);
    }

    #[test]
    fn response_errors_surface_and_counts_validate() {
        assert!(parse_embeddings_response(
            r#"{"error": {"message": "quota exceeded"}}"#,
            1
        )
        .unwrap_err()
        .contains("quota exceeded"));
        assert!(parse_embeddings_response(r#"{"data": []}"#, 1).is_err());
        assert!(parse_embeddings_response(
            r#"{"data": [{"index": 0, "embedding": [1, 2]}, {"index": 1, "embedding": [1]}]}"#,
            2
        )
        .unwrap_err()
        .contains("维度不一致"));
        assert!(parse_embeddings_response("not json", 1).is_err());
    }

    #[test]
    fn payload_is_minimal_openai_compatible() {
        // Only `model` + `input` — no `dimensions` and no `encoding_format`,
        // so third-party OpenAI-compatible endpoints that reject unknown
        // params never 400. Float embeddings are the default return.
        let payload = EmbedClient::build_payload(&["文本".to_string()]);
        assert!(payload.get("dimensions").is_none());
        assert!(payload.get("encoding_format").is_none());
        assert_eq!(payload["model"], "MODEL");
        assert_eq!(payload["input"][0], "文本");
    }

    #[test]
    fn resolve_embed_model_honors_explicit_model_and_falls_back_when_empty() {
        // Third-party embedding names are honored verbatim.
        assert_eq!(
            resolve_embed_model("liquid/lfm-2.5-embedding-350m:free"),
            "liquid/lfm-2.5-embedding-350m:free"
        );
        assert_eq!(resolve_embed_model("text-embedding-v4"), "text-embedding-v4");
        // Empty / whitespace falls back to the DashScope default.
        assert_eq!(resolve_embed_model(""), EMBED_MODEL_DEFAULT);
        assert_eq!(resolve_embed_model("  "), EMBED_MODEL_DEFAULT);
    }
}
