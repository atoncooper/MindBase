//! GitHub release update checking.
//!
//! The desktop app is offline-first: every failure path here degrades to an
//! `Err(String)` that callers may ignore silently. Network IO is blocking
//! (ureq) and therefore always wrapped in `spawn_blocking`.

use std::io::Read;
use std::path::PathBuf;
use std::time::Duration;

use semver::Version;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::config;
use crate::db::Db;

/// Base URL of the GitHub REST API.
const GITHUB_API_BASE: &str = "https://api.github.com";

/// Only URLs under this prefix are ever handed to the frontend / opener
/// plugin as a release page; anything else collapses to an empty string.
const GITHUB_HTML_BASE: &str = "https://github.com/";

/// Overall request timeout for metadata calls; a slow network must never hang
/// the UI flow. Installer downloads use their own, much longer budget.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

/// Whole-request budget for downloading one installer (a release build is
/// tens of MB; a mainland connection through a proxy can be slow).
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(1800);

/// GitHub API requires a User-Agent header to answer at all.
const USER_AGENT: &str = concat!(
    env!("CARGO_PKG_NAME"),
    "-update-check/",
    env!("CARGO_PKG_VERSION")
);

/// Tag prefixes used by this project's releases, longest first so the most
/// specific one wins.
const TAG_PREFIXES: [&str; 3] = ["mind-base-desktop-v", "mind-base-desktop-", "v"];

/// Update information surfaced to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// Version of the running app, e.g. `"0.1.0"`.
    pub current_version: String,
    /// Latest release version with tag prefixes stripped, e.g. `"0.2.0"`.
    pub latest_version: String,
    /// Whether the latest release is newer than the running app.
    pub has_update: bool,
    /// HTML page of the latest release on GitHub; empty when the API returned
    /// a URL outside `https://github.com/` (the frontend then hides the
    /// download action).
    pub release_url: String,
    /// Release notes body; `None` when the release has none.
    pub release_notes: Option<String>,
    /// ISO 8601 publish timestamp; `None` when the API omits it.
    pub published_at: Option<String>,
}

/// One downloadable file attached to a release.
#[derive(Debug, Clone, Deserialize)]
pub struct GithubAsset {
    pub name: String,
    pub size: u64,
    pub browser_download_url: String,
}

/// Subset of the GitHub `/releases/latest` payload we consume.
#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    html_url: String,
    body: Option<String>,
    published_at: Option<String>,
    #[serde(default)]
    assets: Vec<GithubAsset>,
}

/// Strip known release tag prefixes (`mind-base-desktop-v`, `v`, ...).
fn strip_tag_prefix(tag: &str) -> String {
    let trimmed = tag.trim();
    for prefix in TAG_PREFIXES {
        if let Some(rest) = trimmed.strip_prefix(prefix) {
            // A bare prefix with no version left behind means the tag was not
            // actually prefixed; keep the original value instead of "".
            if rest.is_empty() {
                break;
            }
            return rest.to_string();
        }
    }
    trimmed.to_string()
}

/// Compare a release tag against the current version.
///
/// Prefers semantic comparison; falls back to plain string comparison when
/// either side cannot be parsed as a semantic version. Never panics.
fn is_newer_version(tag: &str, current: &str) -> bool {
    let latest = strip_tag_prefix(tag);
    let current = strip_tag_prefix(current);
    match (Version::parse(&latest), Version::parse(&current)) {
        (Ok(latest), Ok(current)) => latest > current,
        // Unparsable versions degrade to lexicographic comparison.
        _ => latest > current,
    }
}

/// Normalize a raw proxy env value into a URL ureq accepts, adding the
/// `http://` scheme when it is missing (e.g. `127.0.0.1:10808`).
fn normalize_proxy_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.contains("://") {
        Some(trimmed.to_string())
    } else {
        Some(format!("http://{trimmed}"))
    }
}

/// Read the first usable proxy URL from the environment (HTTPS before HTTP).
fn proxy_from_env() -> Option<String> {
    for key in ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] {
        if let Ok(value) = std::env::var(key) {
            if let Some(url) = normalize_proxy_url(&value) {
                return Some(url);
            }
        }
    }
    None
}

/// Build a ureq agent, attaching the proxy when one is provided.
fn build_agent(proxy_url: Option<&str>) -> Result<ureq::Agent, String> {
    build_agent_with_timeout(proxy_url, REQUEST_TIMEOUT)
}

/// [`build_agent`] with a caller-chosen timeout (downloads need minutes, not
/// the 5 s metadata budget).
fn build_agent_with_timeout(
    proxy_url: Option<&str>,
    timeout: Duration,
) -> Result<ureq::Agent, String> {
    let builder = ureq::AgentBuilder::new().timeout(timeout);
    let builder = match proxy_url {
        Some(url) => builder
            .proxy(ureq::Proxy::new(url).map_err(|err| format!("invalid proxy url {url}: {err}"))?),
        None => builder,
    };
    Ok(builder.build())
}

/// Perform a single release request with a prebuilt agent.
///
/// The error is erased to a trait object: both `ureq::Error` and the JSON
/// decoder's `io::Error` exceed the large-Err lint threshold, and callers
/// only ever Display it or probe for the transport variant.
fn request_release(
    agent: &ureq::Agent,
    url: &str,
) -> Result<GithubRelease, Box<dyn std::error::Error>> {
    let response = agent
        .get(url)
        .set("User-Agent", USER_AGENT)
        .set("Accept", "application/vnd.github+json")
        .call()?;
    Ok(response.into_json::<GithubRelease>()?)
}

/// Whether the error came from the transport layer (DNS / connect / timeout)
/// rather than from an authoritative non-2xx HTTP status.
fn is_transport_error(err: &(dyn std::error::Error + 'static)) -> bool {
    err.downcast_ref::<ureq::Error>()
        .is_some_and(|inner| matches!(inner, ureq::Error::Transport(_)))
}

/// Fetch the latest release: direct connection first, then one retry through
/// the environment proxy if (and only if) the transport itself failed.
fn fetch_latest_release(repo: &str) -> Result<GithubRelease, String> {
    let url = format!("{GITHUB_API_BASE}/repos/{repo}/releases/latest");
    let direct_agent = build_agent(None)?;
    match request_release(&direct_agent, &url) {
        Ok(release) => Ok(release),
        Err(err) if is_transport_error(err.as_ref()) => {
            let proxy_url = proxy_from_env().ok_or_else(|| err.to_string())?;
            let proxy_agent = build_agent(Some(&proxy_url))?;
            request_release(&proxy_agent, &url)
                .map_err(|retry| format!("direct: {err}; via proxy: {retry}"))
        }
        Err(err) => Err(err.to_string()),
    }
}

/// Whitelist the release page URL before it reaches the frontend.
///
/// `html_url` is attacker-influenced API output; only genuine GitHub pages
/// may be opened by the desktop shell, everything else degrades to "".
fn safe_release_url(html_url: &str) -> String {
    if html_url.starts_with(GITHUB_HTML_BASE) {
        html_url.to_string()
    } else {
        eprintln!(
            "[update] ignoring non-GitHub release url {html_url:?}; download action disabled"
        );
        String::new()
    }
}

/// Tauri command: check GitHub for a newer desktop release.
#[tauri::command]
pub async fn check_update(app: AppHandle, db: State<'_, Db>) -> Result<UpdateInfo, String> {
    let repo = {
        let conn =
            db.conn
                .lock()
                .map_err(|err| format!("failed to acquire database lock: {err}"))?;
        config::load(&conn)?.update_repo
    };
    // Same shared rule that guards writes in `set_config`; re-checking here
    // also defends against rows persisted by older builds before strict
    // validation existed.
    let repo = config::validate_update_repo(&repo)?;
    let current_version = app.package_info().version.to_string();

    // Blocking network IO must stay off the async runtime worker threads.
    let release = tauri::async_runtime::spawn_blocking(move || fetch_latest_release(&repo))
        .await
        .map_err(|err| format!("update check task failed: {err}"))??;

    Ok(UpdateInfo {
        has_update: is_newer_version(&release.tag_name, &current_version),
        current_version,
        latest_version: strip_tag_prefix(&release.tag_name),
        release_url: safe_release_url(&release.html_url),
        release_notes: release.body,
        published_at: release.published_at,
    })
}

// ---------------------------------------------------------------------------
// In-app installer download & launch
// ---------------------------------------------------------------------------

/// Progress pushed to the frontend while an installer downloads.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum UpdateDownloadEvent {
    Start { total_bytes: u64 },
    /// Heartbeat with running totals (throttled to ~4 per second).
    Progress { received: u64, total_bytes: u64 },
    Done { path: String, bytes: u64 },
}

/// Outcome of one installer download.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDownloadSummary {
    pub path: String,
    pub bytes: u64,
}

/// Pick the Windows installer asset from a release's attachments.
///
/// Preference: the NSIS `-setup.exe` (has an embedded uninstaller and needs
/// no admin), then the `.msi`. Non-x64 builds are never selected.
fn pick_windows_installer(assets: &[GithubAsset]) -> Option<&GithubAsset> {
    let is_x64 = |name: &str| name.to_lowercase().contains("x64") || name.to_lowercase().contains("x86_64");
    let setup = assets
        .iter()
        .find(|asset| is_x64(&asset.name) && asset.name.to_lowercase().ends_with("-setup.exe"));
    if setup.is_some() {
        return setup;
    }
    assets
        .iter()
        .find(|asset| is_x64(&asset.name) && asset.name.to_lowercase().ends_with(".msi"))
}

/// Extract `owner/repo` and `tag` from a whitelisted release page URL, e.g.
/// `https://github.com/o/r/releases/tag/mind-base-desktop-v0.2.0`.
fn parse_release_url(html_url: &str) -> Result<(String, String), String> {
    let rest = html_url
        .strip_prefix(GITHUB_HTML_BASE)
        .ok_or_else(|| format!("非 GitHub 发布页地址：{html_url}"))?;
    let mut parts = rest.split('/');
    let owner = parts.next().unwrap_or_default();
    let repo = parts.next().unwrap_or_default();
    let tag = match (parts.next(), parts.next(), parts.next()) {
        (Some("releases"), Some("tag"), Some(tag)) => tag.to_string(),
        (Some("releases"), Some("tag"), None) => {
            return Err("发布页地址缺少 tag".to_string());
        }
        _ => return Err(format!("无法从地址解析发布 tag：{html_url}")),
    };
    if owner.is_empty() || repo.is_empty() || tag.is_empty() {
        return Err(format!("无法从地址解析发布 tag：{html_url}"));
    }
    Ok((format!("{owner}/{repo}"), tag))
}

/// Stream one asset to disk with throttled progress events. Writes to a
/// `.part` sibling first so a killed download never leaves a half installer
/// that could later be launched.
fn download_asset(
    asset: &GithubAsset,
    dest: &std::path::Path,
    channel: &Channel<UpdateDownloadEvent>,
) -> Result<u64, String> {
    let agent = build_agent_with_timeout(proxy_from_env().as_deref(), DOWNLOAD_TIMEOUT)?;
    let mut response = agent
        .get(&asset.browser_download_url)
        .set("User-Agent", USER_AGENT)
        .call()
        .map_err(|err| format!("安装包下载失败：{err}"))?;
    if response.status() != 200 {
        return Err(format!("安装包下载失败：HTTP {}", response.status()));
    }

    let total = asset.size;
    let part_path = dest.with_extension("part");
    let mut file = std::fs::File::create(&part_path)
        .map_err(|err| format!("无法创建下载文件 {}：{err}", part_path.display()))?;
    let mut reader = response.into_reader();
    let mut buf = [0u8; 64 * 1024];
    let mut received: u64 = 0;
    let mut last_emit = std::time::Instant::now();
    loop {
        let read = reader
            .read(&mut buf)
            .map_err(|err| format!("下载中断：{err}"))?;
        if read == 0 {
            break;
        }
        std::io::Write::write_all(&mut file, &buf[..read])
            .map_err(|err| format!("写入下载文件失败：{err}"))?;
        received += read as u64;
        if last_emit.elapsed() >= Duration::from_millis(250) {
            let _ = channel.send(UpdateDownloadEvent::Progress { received, total_bytes: total });
            last_emit = std::time::Instant::now();
        }
    }
    file.sync_all()
        .map_err(|err| format!("写入下载文件失败：{err}"))?;
    drop(file);
    if received != total {
        return Err(format!(
            "下载不完整（{} / {} 字节），请重试",
            received, total
        ));
    }
    std::fs::rename(&part_path, dest)
        .map_err(|err| format!("无法完成下载文件：{err}"))?;
    let _ = channel.send(UpdateDownloadEvent::Done {
        path: dest.to_string_lossy().to_string(),
        bytes: received,
    });
    Ok(received)
}

/// Download the Windows installer of one release into `<data>/updates/`.
#[tauri::command]
pub async fn download_update(
    app: AppHandle,
    db: State<'_, Db>,
    release_url: String,
    on_event: Channel<UpdateDownloadEvent>,
) -> Result<UpdateDownloadSummary, String> {
    let (repo, tag) = parse_release_url(release_url.trim())?;
    let updates_dir = {
        let conn = db
            .conn
            .lock()
            .map_err(|err| format!("failed to acquire database lock: {err}"))?;
        let _ = config::load(&conn)?; // config sanity before a long download
        app.state::<Db>()
            .data_dir
            .lock()
            .map(|dir| dir.join("updates"))
            .map_err(|err| format!("failed to acquire data dir lock: {err}"))?
    };

    tauri::async_runtime::spawn_blocking(move || {
        let agent = build_agent(proxy_from_env().as_deref())?;
        let url = format!("{GITHUB_API_BASE}/repos/{repo}/releases/tags/{tag}");
        let release = request_release(&agent, &url).map_err(|err| err.to_string())?;
        let asset = pick_windows_installer(&release.assets)
            .ok_or_else(|| "该版本没有提供 Windows x64 安装包，请到发布页手动下载".to_string())?;

        let _ = on_event.send(UpdateDownloadEvent::Start {
            total_bytes: asset.size,
        });
        std::fs::create_dir_all(&updates_dir)
            .map_err(|err| format!("无法创建更新目录：{err}"))?;
        let dest = updates_dir.join(&asset.name);
        let bytes = download_asset(asset, &dest, &on_event)?;
        Ok(UpdateDownloadSummary {
            path: dest.to_string_lossy().to_string(),
            bytes,
        })
    })
    .await
    .map_err(|err| format!("download task failed: {err}"))?
}

/// Launch a downloaded installer (NSIS setup.exe or MSI). The installer takes
/// over from there — Tauri's NSIS build prompts to close the running app and
/// its bundled uninstaller replaces the old version.
#[tauri::command]
pub fn run_update_installer(app: AppHandle, path: String) -> Result<(), String> {
    let path = PathBuf::from(path.trim());
    let allowed_dir = {
        let db = app.state::<Db>();
        db.data_dir
            .lock()
            .map(|dir| dir.join("updates"))
            .map_err(|err| format!("failed to acquire data dir lock: {err}"))?
    };
    // Only files this app itself downloaded may be launched.
    if !path.starts_with(&allowed_dir) {
        return Err("只允许启动应用下载的安装包".to_string());
    }
    if !path.is_file() {
        return Err(format!("安装包不存在：{}", path.display()));
    }
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if name.ends_with(".msi") {
        std::process::Command::new("msiexec")
            .arg("/i")
            .arg(&path)
            .spawn()
            .map_err(|err| format!("无法启动安装程序：{err}"))?;
    } else if name.ends_with(".exe") {
        std::process::Command::new(&path)
            .spawn()
            .map_err(|err| format!("无法启动安装程序：{err}"))?;
    } else {
        return Err("该文件不是可执行的安装包".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(name: &str) -> GithubAsset {
        GithubAsset {
            name: name.to_string(),
            size: 1,
            browser_download_url: format!("https://github.com/o/r/releases/download/v1/{name}"),
        }
    }

    #[test]
    fn installer_pick_prefers_nsis_setup_then_msi() {
        let assets = vec![
            asset("mind-base-desktop_0.2.0_x64-setup.exe"),
            asset("mind-base-desktop_0.2.0_x64_en-US.msi"),
            asset("mind-base-desktop_0.2.0_arm64-setup.exe"),
            asset("latest.json"),
        ];
        let picked = pick_windows_installer(&assets).unwrap();
        assert!(picked.name.ends_with("x64-setup.exe"));

        let msi_only = vec![
            asset("app_0.2.0_x64_en-US.msi"),
            asset("latest.json"),
        ];
        assert_eq!(pick_windows_installer(&msi_only).unwrap().name, "app_0.2.0_x64_en-US.msi");

        let none = vec![asset("latest.json")];
        assert!(pick_windows_installer(&none).is_none());
    }

    #[test]
    fn release_url_parses_owner_repo_and_tag() {
        let (repo, tag) = parse_release_url(
            "https://github.com/atoncooper/MindBase/releases/tag/mind-base-desktop-v0.2.0",
        )
        .unwrap();
        assert_eq!(repo, "atoncooper/MindBase");
        assert_eq!(tag, "mind-base-desktop-v0.2.0");
        assert!(parse_release_url("https://evil.com/releases/tag/v1").is_err());
        assert!(parse_release_url("https://github.com/o/r/releases").is_err());
    }
}
