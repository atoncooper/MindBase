//! GitHub release metadata requests and release / asset parsing.

use std::time::Duration;

use semver::Version;

use super::types::{GithubAsset, GithubRelease};

/// Base URL of the GitHub REST API.
pub(super) const GITHUB_API_BASE: &str = "https://api.github.com";

/// Only URLs under this prefix are ever handed to the frontend / opener
/// plugin as a release page; anything else collapses to an empty string.
pub(super) const GITHUB_HTML_BASE: &str = "https://github.com/";

/// Overall request timeout for metadata calls; a slow network must never hang
/// the UI flow. Installer downloads use their own, much longer budget.
pub(super) const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

/// GitHub API requires a User-Agent header to answer at all.
pub(super) const USER_AGENT: &str = concat!(
    env!("CARGO_PKG_NAME"),
    "-update-check/",
    env!("CARGO_PKG_VERSION")
);

/// Tag prefixes used by this project's releases, longest first so the most
/// specific one wins.
const TAG_PREFIXES: [&str; 3] = ["mind-base-desktop-v", "mind-base-desktop-", "v"];

/// Strip known release tag prefixes (`mind-base-desktop-v`, `v`, ...).
pub(super) fn strip_tag_prefix(tag: &str) -> String {
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
pub(super) fn is_newer_version(tag: &str, current: &str) -> bool {
    let latest = strip_tag_prefix(tag);
    let current = strip_tag_prefix(current);
    match (Version::parse(&latest), Version::parse(&current)) {
        (Ok(latest), Ok(current)) => latest > current,
        // Unparsable versions degrade to lexicographic comparison.
        _ => latest > current,
    }
}

/// Perform one release-metadata request through the configured egress route:
/// proxy first when the user set one for https targets, one direct fallback
/// retry when (and only when) the transport itself failed.
pub(super) fn request_release_routed(url: &str) -> Result<GithubRelease, String> {
    let (primary, fallback) = crate::llm::api_keys::egress_agents(REQUEST_TIMEOUT, url)?;
    match request_release(&primary, url) {
        Ok(release) => Ok(release),
        Err(err) if is_transport_error(err.as_ref()) => {
            let fallback = fallback.ok_or_else(|| err.to_string())?;
            request_release(&fallback, url).map_err(|retry| format!("{err}; fallback: {retry}"))
        }
        Err(err) => Err(err.to_string()),
    }
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

/// Fetch the latest release through the configured egress route.
pub(super) fn fetch_latest_release(repo: &str) -> Result<GithubRelease, String> {
    let url = format!("{GITHUB_API_BASE}/repos/{repo}/releases/latest");
    request_release_routed(&url)
}

/// Whitelist the release page URL before it reaches the frontend.
///
/// `html_url` is attacker-influenced API output; only genuine GitHub pages
/// may be opened by the desktop shell, everything else degrades to "".
pub(super) fn safe_release_url(html_url: &str) -> String {
    if html_url.starts_with(GITHUB_HTML_BASE) {
        html_url.to_string()
    } else {
        eprintln!(
            "[update] ignoring non-GitHub release url {html_url:?}; download action disabled"
        );
        String::new()
    }
}

/// Pick the Windows installer asset from a release's attachments.
///
/// Preference: the NSIS `-setup.exe` (has an embedded uninstaller and needs
/// no admin), then the `.msi`. Non-x64 builds are never selected.
pub(super) fn pick_windows_installer(assets: &[GithubAsset]) -> Option<&GithubAsset> {
    let is_x64 =
        |name: &str| name.to_lowercase().contains("x64") || name.to_lowercase().contains("x86_64");
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
pub(super) fn parse_release_url(html_url: &str) -> Result<(String, String), String> {
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

        let msi_only = vec![asset("app_0.2.0_x64_en-US.msi"), asset("latest.json")];
        assert_eq!(
            pick_windows_installer(&msi_only).unwrap().name,
            "app_0.2.0_x64_en-US.msi"
        );

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
