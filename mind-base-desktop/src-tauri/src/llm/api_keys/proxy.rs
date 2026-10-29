//! Process-wide egress proxy setting, direct-connect bypass list and ureq agents.

use std::sync::{OnceLock, RwLock};
use std::time::Duration;

use rusqlite::Connection;

// ---------------------------------------------------------------------------
// Egress proxy — the single source of truth for all outbound HTTP traffic.
//
// The user configures up to two addresses in the settings UI (`proxy_http`
// for http:// targets, `proxy_https` for https:// targets). System
// environment variables are deliberately ignored: the setting is the only
// knob. When a proxy is configured for the target scheme, requests go
// through it FIRST and fall back to a direct connection on transport
// errors — a refused proxy fails in milliseconds while a direct attempt to
// a blocked host can hang for the full timeout. Destinations on the
// direct-connect bypass list (domestic mirrors, loopback) never proxy.
// ---------------------------------------------------------------------------

/// Upper bound for a user-entered proxy address.
const MAX_PROXY_ADDR_LEN: usize = 256;

/// A configured egress proxy pair; `None` per scheme = direct connection.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ProxySetting {
    pub http: Option<String>,
    pub https: Option<String>,
}

static PROXY_SETTING: OnceLock<RwLock<ProxySetting>> = OnceLock::new();

/// Hosts that must always connect directly: domestic mirrors an overseas
/// proxy would only slow down (large model downloads), domestic LLM
/// endpoints, plus loopback.
const DIRECT_HOST_SUFFIXES: [&str; 8] = [
    "bilibili.com",
    "hf-mirror.com",
    "modelscope.cn",
    "huaweicloud.com",
    "tuna.tsinghua.edu.cn",
    "aliyun.com",
    "aliyuncs.com",
    "deepseek.com",
];

/// Overwrite the process-wide proxy setting (startup init + config saves).
pub(crate) fn set_proxy_setting(setting: ProxySetting) {
    let cell = PROXY_SETTING.get_or_init(|| RwLock::new(ProxySetting::default()));
    if let Ok(mut guard) = cell.write() {
        *guard = setting;
    }
}

/// Re-read the proxy fields from the app config and refresh the global.
pub(crate) fn refresh_proxy_setting(conn: &Connection) {
    let setting = crate::infra::config::load(conn)
        .map(|cfg| ProxySetting {
            http: cfg.proxy_http.clone(),
            https: cfg.proxy_https.clone(),
        })
        .unwrap_or_default();
    set_proxy_setting(setting);
}

/// Snapshot of the current setting (defaults to all-direct when unset).
pub(crate) fn proxy_setting() -> ProxySetting {
    PROXY_SETTING
        .get()
        .and_then(|lock| lock.read().ok())
        .map(|guard| guard.clone())
        .unwrap_or_default()
}

/// `(name, value)` proxy env pairs for child processes that do their own
/// networking (pip, the embedded Python ASR worker). Nothing configured →
/// empty (children stay direct). Configured → `HTTP_PROXY`/`HTTPS_PROXY`
/// (either filled address covers both schemes, mirroring
/// [`proxy_for_url`]) plus `NO_PROXY` carrying the bypass hosts, so
/// domestic mirrors keep their direct fast path inside children too.
/// socks5:// addresses stay Rust-side only: pip/requests need an extra
/// package for SOCKS and would fail the install outright.
pub(crate) fn child_proxy_env() -> Vec<(String, String)> {
    let setting = proxy_setting();
    let http_addr = setting
        .http
        .clone()
        .or_else(|| setting.https.clone())
        .filter(|url| url.starts_with("http://"));
    let https_addr = setting
        .https
        .clone()
        .or_else(|| setting.http.clone())
        .filter(|url| url.starts_with("http://"));
    if http_addr.is_none() && https_addr.is_none() {
        return Vec::new();
    }
    let mut vars: Vec<(String, String)> = Vec::new();
    if let Some(http) = &http_addr {
        for name in ["HTTP_PROXY", "http_proxy"] {
            vars.push((name.to_string(), http.clone()));
        }
    }
    if let Some(https) = &https_addr {
        for name in ["HTTPS_PROXY", "https_proxy"] {
            vars.push((name.to_string(), https.clone()));
        }
    }
    let no_proxy = DIRECT_HOST_SUFFIXES
        .iter()
        .copied()
        .chain(["localhost", "127.0.0.1", "::1"])
        .collect::<Vec<_>>()
        .join(",");
    for name in ["NO_PROXY", "no_proxy"] {
        vars.push((name.to_string(), no_proxy.clone()));
    }
    vars
}

/// Host part of a URL authority with userinfo / port / IPv6 brackets
/// stripped (`user@[::1]:8080` → `::1`).
fn host_of_authority(authority: &str) -> &str {
    let authority = match authority.rsplit_once('@') {
        Some((_, host)) => host,
        None => authority,
    };
    if let Some(rest) = authority.strip_prefix('[') {
        return rest.split(']').next().unwrap_or(authority);
    }
    authority.split(':').next().unwrap_or(authority)
}

/// Whether `host` must always connect directly.
fn host_bypasses_proxy(host: &str) -> bool {
    let host = host
        .trim()
        .trim_end_matches('.')
        .trim_matches(|c| c == '[' || c == ']')
        .to_ascii_lowercase();
    if host == "localhost" || host == "::1" {
        return true;
    }
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        return ip.is_loopback();
    }
    DIRECT_HOST_SUFFIXES
        .iter()
        .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
}

/// The configured proxy URL for a target URL (scheme-routed, bypass-aware).
/// Each scheme prefers its own field and falls back to the other one, so a
/// single filled address covers both protocols. `None` = connect directly.
pub(crate) fn proxy_for_url(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let host = host_of_authority(authority);
    if host.is_empty() || host_bypasses_proxy(host) {
        return None;
    }
    let setting = proxy_setting();
    match scheme.to_ascii_lowercase().as_str() {
        "https" => setting.https.or(setting.http),
        "http" => setting.http.or(setting.https),
        _ => None,
    }
}

/// Validate and normalize a user-entered proxy address. A bare `host:port`
/// gains the `http://` scheme; only `http://` and `socks5://` are accepted
/// (ureq's proxy stack has no TLS-to-proxy scheme), and any path is dropped.
pub(crate) fn normalize_proxy_addr(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("代理地址不能为空".to_string());
    }
    if trimmed.chars().count() > MAX_PROXY_ADDR_LEN {
        return Err("代理地址过长".to_string());
    }
    let candidate = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };
    let lower = candidate.to_ascii_lowercase();
    if !lower.starts_with("http://") && !lower.starts_with("socks5://") {
        return Err("代理地址仅支持 http:// 或 socks5://".to_string());
    }
    let (scheme, authority_full) = candidate.split_once("://").expect("scheme checked above");
    let scheme = scheme.to_ascii_lowercase();
    let authority = authority_full.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() {
        return Err("代理地址缺少主机部分".to_string());
    }
    Ok(format!("{scheme}://{authority}"))
}

/// Build a ureq agent with the given timeout, attaching a proxy if given.
pub(super) fn http_agent(timeout: Duration, proxy_url: Option<&str>) -> Result<ureq::Agent, String> {
    let builder = ureq::AgentBuilder::new().timeout(timeout);
    let builder = match proxy_url {
        Some(url) => builder
            .proxy(ureq::Proxy::new(url).map_err(|err| format!("invalid proxy url {url}: {err}"))?),
        None => builder,
    };
    Ok(builder.build())
}

/// Build the agents for one outbound request: `(primary, fallback)`.
///
/// Proxy configured for the target → proxy first with a direct fallback;
/// nothing configured → direct only (`fallback == None`). A transport error
/// on the primary is the caller's trigger to try the fallback once.
pub(crate) fn egress_agents(
    timeout: Duration,
    url: &str,
) -> Result<(ureq::Agent, Option<ureq::Agent>), String> {
    match proxy_for_url(url) {
        Some(proxy_url) => {
            let primary = http_agent(timeout, Some(&proxy_url))?;
            let fallback = http_agent(timeout, None)?;
            Ok((primary, Some(fallback)))
        }
        None => Ok((http_agent(timeout, None)?, None)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxy_addr_normalizes_bare_host_and_strips_path() {
        assert_eq!(
            normalize_proxy_addr(" 127.0.0.1:10808 "),
            Ok("http://127.0.0.1:10808".to_string())
        );
        assert_eq!(
            normalize_proxy_addr("HTTP://LocalHost:8080/base/path"),
            Ok("http://LocalHost:8080".to_string())
        );
        assert_eq!(
            normalize_proxy_addr("socks5://127.0.0.1:10808/"),
            Ok("socks5://127.0.0.1:10808".to_string())
        );
    }

    #[test]
    fn proxy_addr_rejects_unsupported_schemes_and_garbage() {
        assert!(normalize_proxy_addr("").is_err());
        assert!(normalize_proxy_addr("   ").is_err());
        assert!(normalize_proxy_addr("https://127.0.0.1:10808").is_err());
        assert!(normalize_proxy_addr("ftp://x").is_err());
        assert!(normalize_proxy_addr("http://").is_err());
        let oversized = "h".repeat(MAX_PROXY_ADDR_LEN + 1);
        assert!(normalize_proxy_addr(&oversized).is_err());
    }

    #[test]
    fn host_bypass_list_matches_suffix_and_loopback() {
        assert!(host_bypasses_proxy("api.bilibili.com"));
        assert!(host_bypasses_proxy("hf-mirror.com"));
        assert!(host_bypasses_proxy("HF-Mirror.COM.")); // case + trailing dot
        assert!(host_bypasses_proxy("mirrors.tuna.tsinghua.edu.cn"));
        assert!(host_bypasses_proxy("dashscope.aliyuncs.com"));
        assert!(host_bypasses_proxy("api.deepseek.com"));
        assert!(host_bypasses_proxy("localhost"));
        assert!(host_bypasses_proxy("127.0.0.1"));
        assert!(host_bypasses_proxy("[::1]"));
        assert!(!host_bypasses_proxy("api.github.com"));
        assert!(!host_bypasses_proxy("evil-hf-mirror.com.attacker.net"));
    }

    #[test]
    fn host_of_authority_strips_port_userinfo_and_brackets() {
        assert_eq!(host_of_authority("api.github.com"), "api.github.com");
        assert_eq!(host_of_authority("api.github.com:443"), "api.github.com");
        assert_eq!(
            host_of_authority("user:pw@host.example:8080"),
            "host.example"
        );
        assert_eq!(host_of_authority("[::1]:8080"), "::1");
    }

    #[test]
    fn proxy_for_url_routes_by_scheme_and_bypass() {
        // Single test body for the process-global setting so parallel test
        // threads never interleave mutations of PROXY_SETTING.
        set_proxy_setting(ProxySetting {
            http: Some("http://proxy.local:1".to_string()),
            https: Some("socks5://proxy.local:2".to_string()),
        });
        assert_eq!(
            proxy_for_url("https://api.github.com/zen"),
            Some("socks5://proxy.local:2".to_string())
        );
        assert_eq!(
            proxy_for_url("http://example.com/x?y=1"),
            Some("http://proxy.local:1".to_string())
        );
        // Bypass list wins even with a proxy configured.
        assert_eq!(proxy_for_url("https://hf-mirror.com/big-model.bin"), None);
        assert_eq!(proxy_for_url("https://api.bilibili.com/x"), None);
        assert_eq!(proxy_for_url("http://127.0.0.1:9123/health"), None);
        // Unknown scheme (ws://) is never proxied by the HTTP helper.
        assert_eq!(proxy_for_url("ws://example.com/socket"), None);
        // Scheme fallback: one filled address covers both protocols.
        set_proxy_setting(ProxySetting {
            http: Some("http://proxy.local:1".to_string()),
            https: None,
        });
        assert_eq!(
            proxy_for_url("https://api.github.com/zen"),
            Some("http://proxy.local:1".to_string())
        );
        set_proxy_setting(ProxySetting {
            http: None,
            https: Some("socks5://proxy.local:2".to_string()),
        });
        assert_eq!(
            proxy_for_url("http://example.com/x"),
            Some("socks5://proxy.local:2".to_string())
        );
        // All-direct default.
        set_proxy_setting(ProxySetting::default());
        assert_eq!(proxy_for_url("https://api.github.com/zen"), None);
    }
}
