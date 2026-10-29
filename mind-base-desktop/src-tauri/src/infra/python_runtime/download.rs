//! Mirrored downloads for runtime assets.

use std::io::Read;
use std::time::Duration;

const USER_AGENT: &str = "mind-base-desktop/0.1";

/// Download from the first URL that works (domestic mirrors first, so a
/// mainland network still succeeds when the official host is blocked/slow).
pub(super) fn download_bytes(urls: &[&str]) -> Result<Vec<u8>, String> {
    let mut last_err = String::new();
    for url in urls {
        match download_one(url) {
            Ok(bytes) => return Ok(bytes),
            Err(err) => last_err = format!("{url}: {err}"),
        }
    }
    Err(format!("所有下载源均失败：{last_err}"))
}

/// Download a single URL into memory with a generous timeout.
fn download_one(url: &str) -> Result<Vec<u8>, String> {
    let (primary, fallback) = crate::llm::api_keys::egress_agents(Duration::from_secs(300), url)?;
    let fetch = |agent: &ureq::Agent| -> Result<Vec<u8>, String> {
        let response = agent
            .get(url)
            .set("User-Agent", USER_AGENT)
            .call()
            .map_err(|err| format!("下载失败：{err}"))?;
        let mut bytes: Vec<u8> = Vec::new();
        response
            .into_reader()
            .take(512 * 1024 * 1024)
            .read_to_end(&mut bytes)
            .map_err(|err| format!("读取下载内容失败：{err}"))?;
        Ok(bytes)
    };
    fetch(&primary).or_else(|first_err| match &fallback {
        Some(agent) => {
            fetch(agent).map_err(|retry_err| format!("{first_err}；回退直连仍失败：{retry_err}"))
        }
        None => Err(first_err),
    })
}
