//! GitHub skill store: repository search + zipball install.

use std::path::Path;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use super::install::install_zip_bytes;
use super::paths::skills_dir;
use super::SkillMeta;
use crate::infra::db::Db;

// ---------------------------------------------------------------------------
// GitHub skill store — same protocol as app/skills/store/client.py: search
// repositories by query/topic, install by downloading the zipball (the repo
// is ONE skill pack). Routed through the user-configured egress proxy
// (proxy first, direct fallback) — see `api_keys::egress_agents`.
// ---------------------------------------------------------------------------

const GITHUB_API: &str = "https://api.github.com";
/// Default search topic when the query is empty (backend parity).
const STORE_TOPIC: &str = "mindbase-skill";
const STORE_TIMEOUT: Duration = Duration::from_secs(30);

/// One GitHub repository returned by the store search.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreRepo {
    pub full_name: String,
    pub description: String,
    pub stargazers_count: u64,
    pub default_branch: String,
    pub html_url: String,
}

/// GET `{GITHUB_API}{path}` through the configured egress route: proxy first
/// when the user set one for https targets, direct as the fallback — with
/// the proxy off, a refused connection fails in milliseconds, while a
/// *direct* attempt to GitHub can hang for the full timeout (os error
/// 10060) — so direct is the last resort, not the first try. Read-phase
/// errors participate in the same fallback (a TCP handshake may "succeed"
/// through GFW interference and still stall on read). 4xx/5xx statuses fail
/// fast — proxying won't change them.
fn github_get(path: &str) -> Result<Vec<u8>, String> {
    let url = format!("{GITHUB_API}{path}");
    let (primary, fallback) = crate::llm::api_keys::egress_agents(STORE_TIMEOUT, &url)?;
    let attempt = |agent: &ureq::Agent| -> Result<Vec<u8>, String> {
        use std::io::Read;
        let response = agent
            .get(&url)
            .set("User-Agent", "mindbase-desktop-skills")
            .set("Accept", "application/vnd.github+json")
            .call()
            .map_err(|err| match err {
                ureq::Error::Status(code, _) => format!("HTTP {code}"),
                other => format!("连接失败：{other}"),
            })?;
        let mut bytes = Vec::new();
        response
            .into_reader()
            .take(64 * 1024 * 1024)
            .read_to_end(&mut bytes)
            .map_err(|err| format!("读取响应失败：{err}"))?;
        Ok(bytes)
    };
    match attempt(&primary) {
        Ok(bytes) => Ok(bytes),
        Err(err) if err.starts_with("HTTP ") => Err(format!("GitHub {err}")),
        Err(first_err) => {
            let last_error = match &fallback {
                Some(agent) => match attempt(agent) {
                    Ok(bytes) => return Ok(bytes),
                    Err(retry_err) => format!("{first_err}；回退直连仍失败：{retry_err}"),
                },
                None => first_err,
            };
            Err(format!(
                "{last_error}\n（代理与直连均失败；请确认代理软件已开启，或在「系统设置 → 网络代理」填入可用代理地址）"
            ))
        }
    }
}

/// Minimal percent-encoding for GitHub search queries.
fn url_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Search GitHub repositories for installable skills. Empty query falls back
/// to the `mindbase-skill` topic (backend parity).
#[tauri::command]
pub fn skills_store_search(query: Option<String>) -> Result<Vec<StoreRepo>, String> {
    let q = match query.as_deref().map(str::trim) {
        Some(text) if !text.is_empty() => text.to_string(),
        _ => format!("topic:{STORE_TOPIC}"),
    };
    let body = github_get(&format!(
        "/search/repositories?q={}&per_page=30",
        url_encode(&q)
    ))?;
    let value: serde_json::Value =
        serde_json::from_slice(&body).map_err(|err| format!("GitHub 响应解析失败：{err}"))?;
    let items = value
        .get("items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(items
        .iter()
        .filter_map(|item| {
            let full_name = item.get("full_name")?.as_str()?.to_string();
            if full_name.is_empty() {
                return None;
            }
            Some(StoreRepo {
                full_name,
                description: item
                    .get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                stargazers_count: item
                    .get("stargazers_count")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0),
                default_branch: item
                    .get("default_branch")
                    .and_then(|v| v.as_str())
                    .unwrap_or("main")
                    .to_string(),
                html_url: item
                    .get("html_url")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
            })
        })
        .collect())
}

/// Install one skill pack from GitHub by downloading the repo zipball.
/// `repo` must be `owner/repo`; empty branch = repo default.
#[tauri::command]
pub fn skills_store_install(
    app: AppHandle,
    repo: String,
    branch: Option<String>,
) -> Result<SkillMeta, String> {
    let repo = repo.trim().trim_matches('/').to_string();
    let parts: Vec<&str> = repo.split('/').collect();
    if parts.len() != 2
        || parts
            .iter()
            .any(|p| p.is_empty() || *p == "." || *p == "..")
    {
        return Err("仓库格式应为 owner/repo".to_string());
    }
    let branch = branch
        .as_deref()
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .map(|b| format!("/{b}"))
        .unwrap_or_default();
    let bytes = github_get(&format!("/repos/{repo}/zipball{branch}"))?;
    let repo_name = parts[1];
    let safe_repo_name: String = repo_name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '-'
            }
        })
        .collect();
    let db = app.state::<Db>();
    let target_root = {
        let dir = db
            .data_dir
            .lock()
            .map_err(|err| format!("failed to acquire data dir lock: {err}"))?;
        skills_dir(&dir)
    };
    install_zip_bytes(
        &target_root,
        Path::new(&format!("{safe_repo_name}.zip")),
        &bytes,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Live-network check (needs GitHub reachability): `cargo test -- --ignored skills::`
    #[test]
    #[ignore = "requires network access to api.github.com"]
    fn store_search_live_returns_repos() {
        // 普通关键词搜索必有结果；topic:mindbase-skill 目前生态为空，空结果合法。
        let repos =
            skills_store_search(Some("rust cli".to_string())).expect("store search should succeed");
        assert!(!repos.is_empty(), "keyword search should return results");
        assert!(repos[0].full_name.contains('/'));
        // 空查询走 topic 回落，协议应同样成功（可能为空列表）。
        let _ = skills_store_search(None).expect("topic fallback should succeed");
    }
}
