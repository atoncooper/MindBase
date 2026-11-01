//! DeepSeek 官方 Search / Fetch API 客户端（web_search / web_crawl 的首选后端）。
//!
//! - POST {base}/v1/tools/search：{ query, count, ori_question?, need_content? }
//! - POST {base}/v1/tools/fetch：{ url }
//!
//! 鉴权用「API 设置」里 DeepSeek 的 Key/Base（api_keys::read_raw_config）；
//! 出网走 api_keys::egress_agents（代理优先 + 直连回退），超时 20s；
//! HTTP 错误统一映射为中文提示（401 提示填 Key、402 余额不足、429 限速等）。
//!
//! 工具层先用 client_from_conn 在短锁内取客户端，再在锁外调用网络方法，避免长锁。

use std::time::Duration;

use rusqlite::Connection;
use serde_json::{json, Value};

use crate::llm::api_keys;

const DEFAULT_BASE: &str = "https://api.deepseek.com";
const TIMEOUT: Duration = Duration::from_secs(20);
pub(crate) const MAX_QUERY_CHARS: usize = 128;
const MAX_COUNT: usize = 50;

/// DeepSeek Search 返回的一条结果（缺字段给默认值）。
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct DeepSeekHit {
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub summary: String,
    pub content: String,
    pub site_name: String,
    pub site_icon: String,
    pub date: String,
    pub rerank_score: f64,
    pub authority: String,
}

#[derive(Debug, Clone)]
pub(crate) struct DeepSeekClient {
    api_key: String,
    base: String,
}

fn resolve_base(base: &str) -> String {
    let trimmed = base.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        DEFAULT_BASE.to_string()
    } else {
        trimmed.to_string()
    }
}

/// 拼接 API 端点：base 以 /v1 结尾时不重复拼接。
pub(crate) fn resolve_endpoint(base: &str, api_path: &str) -> String {
    let base = resolve_base(base);
    if base.ends_with("/v1") {
        format!("{base}{}", api_path.trim_start_matches("/v1"))
    } else if api_path.starts_with('/') {
        format!("{base}{api_path}")
    } else {
        format!("{base}/{api_path}")
    }
}

pub(crate) fn validate_query(query: &str) -> Result<String, String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Err("搜索词不能为空".to_string());
    }
    let chars = trimmed.chars().count();
    if chars > MAX_QUERY_CHARS {
        return Err(format!(
            "搜索词过长（{chars} 字符，上限 {MAX_QUERY_CHARS}）"
        ));
    }
    Ok(trimmed.to_string())
}

pub(crate) fn clamp_count(count: usize) -> usize {
    count.clamp(1, MAX_COUNT)
}

/// Fetch URL 的基础校验：仅 http/https 且必须有主机名（SSRF 细筛在 web_crawl）。
pub(crate) fn validate_fetch_url(url: &str) -> Result<String, String> {
    let trimmed = url.trim();
    let (scheme, rest) = trimmed
        .split_once("://")
        .ok_or_else(|| "URL 缺少协议（需 http:// 或 https://）".to_string())?;
    if scheme != "http" && scheme != "https" {
        return Err(format!("不允许的协议 {scheme}（仅支持 http/https）"));
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host = authority.rsplit('@').next().unwrap_or_default();
    if host.is_empty() {
        return Err("URL 缺少主机名".to_string());
    }
    Ok(trimmed.to_string())
}

fn error_detail(body: &str) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .pointer("/error/message")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|message| !message.is_empty())
                .map(|message| message.chars().take(300).collect::<String>())
        })
        .unwrap_or_default()
}

/// HTTP 状态 → 中文错误（400/401/402/403/404/408/413/429/500/504 有专门提示）。
pub(crate) fn map_http_error(status: u16, body: &str) -> String {
    let detail = error_detail(body);
    let suffix = if detail.is_empty() {
        String::new()
    } else {
        format!("：{detail}")
    };
    match status {
        400 => format!("DeepSeek 请求参数无效（400）{suffix}"),
        401 => "DeepSeek 鉴权失败（401）：请到「API 设置 → DeepSeek」填写有效的 API Key".to_string(),
        402 => format!("DeepSeek 账户余额不足（402）：请充值后重试{suffix}"),
        403 => format!("DeepSeek 拒绝访问（403）：当前 Key 无该能力权限{suffix}"),
        404 => format!("DeepSeek Search/Fetch 接口不存在（404）：请检查 Base URL{suffix}"),
        408 => format!("DeepSeek 请求超时（408）：请稍后重试{suffix}"),
        413 => format!("请求内容过大（413）：请缩短搜索词或 URL{suffix}"),
        429 => format!("DeepSeek 请求过于频繁（429）：请稍后重试{suffix}"),
        500 => format!("DeepSeek 服务端错误（500）：请稍后重试{suffix}"),
        504 => format!("DeepSeek 网关超时（504）：请稍后重试{suffix}"),
        other => format!("DeepSeek 调用失败（HTTP {other}）{suffix}"),
    }
}

fn post_json(url: &str, api_key: &str, payload: &Value) -> Result<String, String> {
    let (primary, fallback) = api_keys::egress_agents(TIMEOUT, url)?;
    let attempt = |agent: &ureq::Agent| -> Result<String, String> {
        let response = agent
            .post(url)
            .set("Authorization", &format!("Bearer {api_key}"))
            .set("Content-Type", "application/json")
            .set("User-Agent", "MindBase-Desktop/0.1")
            .send_json(payload.clone());
        match response {
            Ok(response) => response
                .into_string()
                .map_err(|err| format!("读取 DeepSeek 响应失败：{err}")),
            Err(ureq::Error::Status(code, response)) => {
                let body = response.into_string().unwrap_or_default();
                Err(map_http_error(code, &body))
            }
            Err(err) => Err(format!("DeepSeek 请求失败（网络错误）：{err}")),
        }
    };
    match attempt(&primary) {
        Ok(body) => Ok(body),
        Err(first) => match fallback {
            Some(agent) => attempt(&agent)
                .map_err(|second| format!("{first}；直连重试仍失败：{second}")),
            None => Err(first),
        },
    }
}

fn hit_from_value(item: &Value) -> DeepSeekHit {
    let text = |key: &str| {
        item.get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string()
    };
    let score = item
        .get("rerank_score")
        .and_then(Value::as_f64)
        .or_else(|| {
            item.get("rerank_score")
                .and_then(Value::as_i64)
                .map(|value| value as f64)
        })
        .unwrap_or(0.0);
    let authority = match item.get("authority") {
        Some(Value::String(value)) => value.trim().to_string(),
        Some(Value::Number(value)) => value.to_string(),
        _ => String::new(),
    };
    DeepSeekHit {
        title: text("title"),
        url: text("url"),
        snippet: text("snippet"),
        summary: text("summary"),
        content: text("content"),
        site_name: text("site_name"),
        site_icon: text("site_icon"),
        date: text("date"),
        rerank_score: score,
        authority,
    }
}

/// 解析 Search 响应（缺字段容错；缺少 results 数组视为错误）。
pub(crate) fn parse_search_response(body: &str) -> Result<Vec<DeepSeekHit>, String> {
    let value: Value = serde_json::from_str(body)
        .map_err(|err| format!("DeepSeek Search 响应解析失败：{err}"))?;
    let results = value
        .get("results")
        .and_then(Value::as_array)
        .ok_or_else(|| "DeepSeek Search 响应缺少 results 数组".to_string())?;
    Ok(results.iter().map(hit_from_value).collect())
}

/// 解析 Fetch 响应：title 可为空，content 不能为空。
pub(crate) fn parse_fetch_response(body: &str) -> Result<(String, String), String> {
    let value: Value = serde_json::from_str(body)
        .map_err(|err| format!("DeepSeek Fetch 响应解析失败：{err}"))?;
    let title = value
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let content = value
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if content.is_empty() {
        return Err("DeepSeek Fetch 返回空正文".to_string());
    }
    Ok((title, content))
}

impl DeepSeekClient {
    /// 联网搜索（count 夹取 1..=50；结果过滤掉无 URL 的条目）。
    pub(crate) fn search(
        &self,
        query: &str,
        count: usize,
        need_content: bool,
        ori_question: Option<&str>,
    ) -> Result<Vec<DeepSeekHit>, String> {
        let query = validate_query(query)?;
        let count = clamp_count(count);
        let mut payload = json!({
            "query": query,
            "count": count,
            "need_content": need_content,
        });
        if let Some(ori_question) = ori_question.map(str::trim).filter(|value| !value.is_empty()) {
            payload["ori_question"] = json!(ori_question);
        }
        let url = resolve_endpoint(&self.base, "/v1/tools/search");
        let body = post_json(&url, &self.api_key, &payload)?;
        let mut hits = parse_search_response(&body)?;
        hits.retain(|hit| !hit.url.is_empty());
        Ok(hits)
    }

    /// 抓取网页正文（Markdown）。
    pub(crate) fn fetch_page(&self, url: &str) -> Result<(String, String), String> {
        let url = validate_fetch_url(url)?;
        let endpoint = resolve_endpoint(&self.base, "/v1/tools/fetch");
        let body = post_json(&endpoint, &self.api_key, &json!({ "url": url }))?;
        parse_fetch_response(&body)
    }
}

/// 读取 DeepSeek Key/Base；未配置返回 None。
pub(crate) fn client_from_conn(conn: &Connection) -> Result<Option<DeepSeekClient>, String> {
    Ok(api_keys::read_raw_config(conn, "deepseek")?.map(|(api_key, base)| DeepSeekClient {
        api_key,
        base: resolve_base(&base),
    }))
}

pub(crate) fn is_configured(conn: &Connection) -> Result<bool, String> {
    Ok(api_keys::read_raw_config(conn, "deepseek")?.is_some())
}

// 契约 API（供其它调用方/测试使用）；工具层用 client_from_conn + 方法，避免网络期间持 DB 锁。
#[allow(dead_code)]
pub(crate) fn search(
    conn: &Connection,
    query: &str,
    count: usize,
    need_content: bool,
    ori_question: Option<&str>,
) -> Result<Vec<DeepSeekHit>, String> {
    let client = client_from_conn(conn)?
        .ok_or_else(|| "未配置 DeepSeek API Key，无法使用官方联网搜索".to_string())?;
    client.search(query, count, need_content, ori_question)
}

#[allow(dead_code)]
pub(crate) fn fetch_page(conn: &Connection, url: &str) -> Result<(String, String), String> {
    let client = client_from_conn(conn)?
        .ok_or_else(|| "未配置 DeepSeek API Key，无法使用官方 Fetch".to_string())?;
    client.fetch_page(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_joining_avoids_duplicate_v1() {
        assert_eq!(
            resolve_endpoint("https://api.deepseek.com", "/v1/tools/search"),
            "https://api.deepseek.com/v1/tools/search"
        );
        assert_eq!(
            resolve_endpoint("https://api.deepseek.com/", "/v1/tools/search"),
            "https://api.deepseek.com/v1/tools/search"
        );
        assert_eq!(
            resolve_endpoint("https://proxy.example.com/v1", "/v1/tools/search"),
            "https://proxy.example.com/v1/tools/search"
        );
        assert_eq!(
            resolve_endpoint("https://proxy.example.com/v1/", "/v1/tools/fetch"),
            "https://proxy.example.com/v1/tools/fetch"
        );
        // 空 base 回落官方地址。
        assert_eq!(
            resolve_endpoint("  ", "/v1/tools/fetch"),
            "https://api.deepseek.com/v1/tools/fetch"
        );
    }

    #[test]
    fn query_validation_and_count_clamp() {
        assert!(validate_query("   ").is_err());
        assert_eq!(validate_query(" deepseek 搜索 ").expect("query"), "deepseek 搜索");
        assert!(validate_query(&"词".repeat(MAX_QUERY_CHARS + 1)).is_err());
        assert_eq!(clamp_count(0), 1);
        assert_eq!(clamp_count(10), 10);
        assert_eq!(clamp_count(999), MAX_COUNT);
    }

    #[test]
    fn fetch_url_validation_requires_http_and_host() {
        assert_eq!(
            validate_fetch_url(" https://example.com/a?b=1 ").expect("url"),
            "https://example.com/a?b=1"
        );
        assert!(validate_fetch_url("ftp://example.com").is_err());
        assert!(validate_fetch_url("example.com").is_err());
        assert!(validate_fetch_url("https:///nohost").is_err());
    }

    #[test]
    fn search_response_parsing_is_tolerant() {
        let body = r#"{"results":[
            {"title":"标题","url":"https://e.com/a","snippet":"摘要","summary":"总结",
             "site_name":"示例站","date":"2024-01-01","rerank_score":0.87,"authority":"high"},
            {"url":"https://e.com/b"}
        ]}"#;
        let hits = parse_search_response(body).expect("parse search");
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].title, "标题");
        assert_eq!(hits[0].site_name, "示例站");
        assert!((hits[0].rerank_score - 0.87).abs() < f64::EPSILON);
        assert_eq!(hits[0].authority, "high");
        assert_eq!(hits[1].title, "");
        assert_eq!(hits[1].rerank_score, 0.0);
        assert!(parse_search_response("{}").is_err());
        assert!(parse_search_response("not json").is_err());
    }

    #[test]
    fn fetch_response_parsing_requires_content() {
        let (title, content) =
            parse_fetch_response(r#"{"title":"页面标题","content":"正文内容第一段"}"#)
                .expect("parse fetch");
        assert_eq!(title, "页面标题");
        assert!(content.contains("正文内容"));
        assert!(parse_fetch_response(r#"{"title":"空"}"#).is_err());
        assert!(parse_fetch_response("nope").is_err());
    }

    #[test]
    fn http_errors_map_to_chinese_hints() {
        let body = r#"{"error":{"message":"Authentication Fails","type":"authentication_error"}}"#;
        assert!(map_http_error(401, body).contains("API Key"));
        assert!(map_http_error(401, body).contains("401"));
        assert!(map_http_error(402, "").contains("余额不足"));
        assert!(map_http_error(403, "").contains("403"));
        assert!(map_http_error(404, "").contains("Base URL"));
        assert!(map_http_error(408, "").contains("408"));
        assert!(map_http_error(413, "").contains("过大"));
        assert!(map_http_error(429, "").contains("稍后重试"));
        assert!(map_http_error(500, "").contains("500"));
        assert!(map_http_error(504, "").contains("504"));
        assert!(map_http_error(400, body).contains("Authentication Fails"));
        assert!(map_http_error(418, "").contains("HTTP 418"));
    }
}
