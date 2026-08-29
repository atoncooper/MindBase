//! Web page capture for 文件入库: fetch URLs with browser-like headers and
//! save the HTML under the media dir, where the regular file-ingest pipeline
//! (hash → extract → chunk → embed) takes over.
//!
//! Anti-block strategy, layered:
//! 1. real-browser request headers (UA / Accept / Accept-Language) — enough
//!    for sites that only gate on user-agent;
//! 2. explicit anti-bot detection (Cloudflare "Just a moment"-style markers,
//!    403/429/503) so a block surfaces as an actionable Chinese error instead
//!    of silently ingesting a challenge page as knowledge;
//! 3. honest fallback: sites needing login/interactive verification can't be
//!    fetched headless — the error tells the user to save the page as HTML
//!    from their browser and import that file instead.
//!
//! The capture target file is `<data>/media/web/<md5(url)>.html`, so one URL
//! always maps to one cache path → one doc_id; re-capturing a changed page
//! replaces its vectors, an unchanged one is skipped by content-hash dedup.

use std::io::Read;
use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use crate::db::Db;

/// Body cap for a captured page — bigger than this is not an article.
const MAX_HTML_BYTES: u64 = 10 * 1024 * 1024;
/// Whole-request timeout.
const FETCH_TIMEOUT: Duration = Duration::from_secs(30);

/// Chrome desktop UA — the single header most anti-bot layers check.
const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/// Markers (lowercase) of an anti-bot / challenge page. Matching only the
/// first 8 KiB keeps false positives low (real articles never carry these in
/// the opening markup) while catching challenge pages, whose payload is tiny.
const ANTIBOT_MARKERS: &[&str] = &[
    "just a moment...",
    "cf-chl",
    "cf-browser-verification",
    "challenge-platform",
    "checking your browser",
    "attention required! | cloudflare",
    "请完成安全验证",
    "安全验证",
    "ddos-guard",
];

// ---------------------------------------------------------------------------
// Progress events
// ---------------------------------------------------------------------------

/// One progress update pushed to the frontend during capture.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum WebCaptureEvent {
    Start { total: usize },
    UrlDone {
        index: i64,
        path: String,
        name: String,
        bytes: u64,
    },
    UrlFailed { index: i64, error: String },
    Done { ok: usize, failed: usize },
}

fn emit(event: &WebCaptureEvent, channel: &Channel<WebCaptureEvent>) {
    let _ = channel.send(event.clone());
}

/// Final tally of one capture run.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSummary {
    pub ok: usize,
    pub failed: usize,
}

// ---------------------------------------------------------------------------
// URL handling
// ---------------------------------------------------------------------------

/// Canonical cache key for a URL: scheme+host folded to lowercase (they are
/// case-insensitive), path/query kept verbatim (they are not).
fn normalize_url_key(url: &str) -> String {
    let trimmed = url.trim();
    match trimmed.find("://") {
        Some(scheme_end) => {
            let scheme = trimmed[..scheme_end].to_lowercase();
            let rest = &trimmed[scheme_end + 3..];
            match rest.find('/') {
                Some(slash) => {
                    let host = rest[..slash].to_lowercase();
                    format!("{scheme}://{host}{}", &rest[slash..])
                }
                None => format!("{scheme}://{}", rest.to_lowercase()),
            }
        }
        None => trimmed.to_string(),
    }
}

/// Human-facing display name for a captured page (host + last path segment).
fn display_name(url: &str) -> String {
    let trimmed = url.trim();
    let without_scheme = trimmed.split("://").nth(1).unwrap_or(trimmed);
    let (host, path) = match without_scheme.find('/') {
        Some(slash) => (&without_scheme[..slash], &without_scheme[slash..]),
        None => (without_scheme, ""),
    };
    let segment = path
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_string();
    if segment.is_empty() {
        host.to_string()
    } else {
        format!("{host} · {segment}")
    }
}

fn is_http_url(url: &str) -> bool {
    url.starts_with("http://") || url.starts_with("https://")
}

/// Whether a captured body smells like an anti-bot challenge page.
fn looks_like_challenge(body: &[u8]) -> bool {
    let head: String = String::from_utf8_lossy(&body[..body.len().min(8 * 1024)]).to_lowercase();
    ANTIBOT_MARKERS.iter().any(|marker| head.contains(marker))
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/// Fetch one URL with browser-like headers, returning the HTML body.
fn fetch_html(url: &str) -> Result<Vec<u8>, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout(FETCH_TIMEOUT)
        .user_agent(BROWSER_UA)
        .build();
    let response = match agent
        .get(url)
        .set(
            "Accept",
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        )
        .set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
        .set("Upgrade-Insecure-Requests", "1")
        .call()
    {
        Ok(response) => response,
        Err(ureq::Error::Status(code, _)) => {
            let hint = match code {
                403 | 429 | 503 => "（疑似被目标网站反爬拦截）".to_string(),
                _ => String::new(),
            };
            return Err(format!("网页请求失败：HTTP {code}{hint}"));
        }
        Err(other) => return Err(format!("网页请求失败：{other}")),
    };
    let content_type = response.content_type().to_lowercase();
    if !content_type.contains("html") && !content_type.contains("xml") {
        return Err(format!(
            "该地址不是网页（content-type: {content_type}），暂不支持入库"
        ));
    }
    let mut body: Vec<u8> = Vec::new();
    response
        .into_reader()
        .take(MAX_HTML_BYTES + 1)
        .read_to_end(&mut body)
        .map_err(|err| format!("读取网页内容失败：{err}"))?;
    if body.len() as u64 > MAX_HTML_BYTES {
        return Err("网页内容超过 10MB，暂不支持入库".to_string());
    }
    if looks_like_challenge(&body) {
        return Err(
            "该网站返回了反爬验证页（Cloudflare 等），程序无法直接抓取。\
             可在浏览器中打开该页面 → 另存为 HTML → 用「选择文件」入库"
                .to_string(),
        );
    }
    Ok(body)
}

/// Cache path for one URL under `<data>/media/web/`.
fn cache_path(web_dir: &std::path::Path, url: &str) -> PathBuf {
    use md5::{Digest, Md5};

    let mut hasher = Md5::new();
    hasher.update(normalize_url_key(url).as_bytes());
    web_dir.join(format!("web-{:x}.html", hasher.finalize()))
}

/// Capture a batch of URLs, saving each page into the media dir. The frontend
/// learns the saved cache paths from [`WebCaptureEvent::UrlDone`] events and
/// pushes them into the regular file-ingest queue.
fn run_capture(
    urls: &[String],
    web_dir: &std::path::Path,
    channel: &Channel<WebCaptureEvent>,
) -> Result<CaptureSummary, String> {
    std::fs::create_dir_all(web_dir)
        .map_err(|err| format!("无法创建网页缓存目录 {}：{err}", web_dir.display()))?;

    emit(&WebCaptureEvent::Start { total: urls.len() }, channel);
    let mut ok = 0usize;
    let mut failed = 0usize;
    for (index, raw) in urls.iter().enumerate() {
        let index = index as i64;
        let url = raw.trim();
        if !is_http_url(url) {
            emit(
                &WebCaptureEvent::UrlFailed {
                    index,
                    error: format!("无效网址（需要 http/https 开头）：{url}"),
                },
                channel,
            );
            failed += 1;
            continue;
        }
        match fetch_html(url) {
            Ok(body) => {
                let path = cache_path(web_dir, url);
                if let Err(err) = std::fs::write(&path, &body) {
                    emit(
                        &WebCaptureEvent::UrlFailed {
                            index,
                            error: format!("写入网页缓存失败：{err}"),
                        },
                        channel,
                    );
                    failed += 1;
                    continue;
                }
                emit(
                    &WebCaptureEvent::UrlDone {
                        index,
                        path: path.to_string_lossy().to_string(),
                        name: display_name(url),
                        bytes: body.len() as u64,
                    },
                    channel,
                );
                ok += 1;
            }
            Err(error) => {
                emit(&WebCaptureEvent::UrlFailed { index, error }, channel);
                failed += 1;
            }
        }
    }
    emit(&WebCaptureEvent::Done { ok, failed }, channel);
    Ok(CaptureSummary { ok, failed })
}

/// Fetch web pages into the local ingest queue.
#[tauri::command]
pub async fn capture_urls(
    app: AppHandle,
    urls: Vec<String>,
    on_event: Channel<WebCaptureEvent>,
) -> Result<CaptureSummary, String> {
    let cleaned: Vec<String> = urls
        .iter()
        .map(|raw| raw.trim().to_string())
        .filter(|raw| !raw.is_empty())
        .collect();
    if cleaned.is_empty() {
        return Err("未输入任何网址".to_string());
    }
    let web_dir = {
        let db = app.state::<Db>();
        db.data_dir
            .lock()
            .map(|dir| dir.join("media").join("web"))
            .map_err(|err| format!("failed to acquire data dir lock: {err}"))?
    };
    // Network I/O must stay off the async runtime (blocking ureq, mirrors
    // the other ingestion paths).
    tauri::async_runtime::spawn_blocking(move || run_capture(&cleaned, &web_dir, &on_event))
        .await
        .map_err(|err| format!("task failed: {err}"))?
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_url_key_folds_host_but_keeps_path() {
        assert_eq!(
            normalize_url_key("HTTPS://Example.COM/wiki/Page_One?a=B"),
            "https://example.com/wiki/Page_One?a=B"
        );
        assert_eq!(
            normalize_url_key("https://example.com"),
            "https://example.com"
        );
    }

    #[test]
    fn display_name_prefers_last_path_segment() {
        assert_eq!(display_name("https://a.com/x/y/article.html"), "a.com · article.html");
        assert_eq!(display_name("https://a.com/"), "a.com");
        assert_eq!(display_name("https://a.com"), "a.com");
    }

    #[test]
    fn challenge_markers_are_detected() {
        assert!(looks_like_challenge(b"<html>Just a moment...</html>"));
        assert!(looks_like_challenge(b"<script src=\"/cdn-cgi/challenge-platform/h/b/orchestrate\"></script>"));
        assert!(!looks_like_challenge(
            "<html><body><h1>Redis 分片研究</h1></body></html>".as_bytes()
        ));
    }

    #[test]
    fn only_http_urls_accepted() {
        assert!(is_http_url("https://a.com"));
        assert!(is_http_url("http://a.com"));
        assert!(!is_http_url("ftp://a.com"));
        assert!(!is_http_url("a.com"));
    }
}
