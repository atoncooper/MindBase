//! QR-code login against Bilibili's passport API.
//!
//! Flow (frontend drives the cadence, ~2s per poll like the web app):
//! 1. [`bili_qr_generate`] — `GET /x/passport-login/web/qrcode/generate`
//!    returns `qrcode_key` + `url`; the URL is rendered as a QR image by the
//!    frontend.
//! 2. [`bili_qr_poll`] — `GET .../poll?qrcode_key=` maps inner codes
//!    86101/86090/86038/0 to waiting/scanned/expired/confirmed.
//! 3. On confirmed, cookies are assembled exactly like app/services/bilibili.py
//!    does — merged from multiple sources because any single one can be
//!    incomplete: this client's cookie jar (Set-Cookie captured across
//!    generate/poll) first, then the redirect URL's query string overriding.
//!    Identity is confirmed via `/x/web-interface/nav`.
//!
//! # Per-key cookie jars
//!
//! Bilibili tracks a QR session by `qrcode_key`, and its responses sprinkle
//! login cookies through `Set-Cookie`. A process-global jar keyed by
//! `qrcode_key` (mirroring `_qrcode_clients` in the reference router) carries
//! them between our stateless HTTP calls. Entries live until the flow reaches
//! a terminal state or the map hits its cap.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use tauri::State;

use super::{
    account_of, build_agent, get_json, get_json_reply, require_session, save_session,
    BiliAccount, BiliSession, Db, ERR_AUTH_EXPIRED,
};

const PASSPORT_BASE: &str = "https://passport.bilibili.com";
const NAV_URL: &str = "https://api.bilibili.com/x/web-interface/nav";

/// Poll inner codes, per bilibili-API-collect and app/services/bilibili.py.
const CODE_WAITING: i64 = 86101;
const CODE_SCANNED: i64 = 86090;
const CODE_EXPIRED: i64 = 86038;
const CODE_CONFIRMED: i64 = 0;

/// Upper bound for concurrent QR flows before stale jars are evicted.
const JAR_CAP: usize = 64;

/// Per-`qrcode_key` cookie store: `(name, value)` pairs in insertion order.
type Jars = HashMap<String, Vec<(String, String)>>;

/// Process-global jar map (login-scoped; entries popped at terminal states).
fn jars() -> &'static Mutex<Jars> {
    static JARS: OnceLock<Mutex<Jars>> = OnceLock::new();
    JARS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Snapshot the stored pairs for one key.
fn jar_pairs(key: &str) -> Vec<(String, String)> {
    jars()
        .lock()
        .ok()
        .and_then(|jars| jars.get(key).cloned())
        .unwrap_or_default()
}

/// Merge raw `Set-Cookie` values into a key's jar.
///
/// Only the first `name=value` segment of each header matters here. An empty
/// value is Bilibili's deletion marker and removes the pair.
fn apply_set_cookies(key: &str, set_cookies: &[String]) {
    let mut guard = match jars().lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };
    // Cap the map so abandoned flows cannot accumulate forever.
    if !guard.contains_key(key) && guard.len() >= JAR_CAP {
        guard.clear();
    }
    let entry = guard.entry(key.to_string()).or_default();
    for header in set_cookies {
        let pair = header.split(';').next().unwrap_or("");
        if let Some((name, value)) = pair.split_once('=') {
            let name = name.trim();
            let value = value.trim();
            if value.is_empty() {
                entry.retain(|(existing, _)| existing != name);
            } else if let Some(slot) = entry.iter_mut().find(|(existing, _)| existing == name) {
                slot.1 = value.to_string();
            } else {
                entry.push((name.to_string(), value.to_string()));
            }
        }
    }
}

/// Drop a key's jar (called when a flow leaves the waiting/scanned states).
fn pop_jar(key: &str) {
    if let Ok(mut guard) = jars().lock() {
        guard.remove(key);
    }
}

/// Build a Cookie header from pairs; `None` when there is nothing to send.
fn cookie_from_pairs(pairs: &[(String, String)]) -> Option<String> {
    if pairs.is_empty() {
        return None;
    }
    Some(
        pairs
            .iter()
            .map(|(name, value)| format!("{name}={value}"))
            .collect::<Vec<_>>()
            .join("; "),
    )
}

/// The three login cookies this app needs.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct LoginCookies {
    pub sessdata: String,
    pub bili_jct: String,
    pub dede_user_id: String,
}

/// Decode `%XX` sequences only; `+` must stay literal because SESSDATA
/// values legitimately contain it (form-encoding rules do not apply here).
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        // Two hex digits must follow '%' (let-chains need edition 2024).
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (
                (bytes[i + 1] as char).to_digit(16),
                (bytes[i + 2] as char).to_digit(16),
            ) {
                out.push((high * 16 + low) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    // Cookie values are ASCII in practice; lossy keeps malformed input visible.
    String::from_utf8_lossy(&out).into_owned()
}

/// Collect the three interesting cookies from a redirect/query string.
///
/// Malformed pairs (no `=`) are skipped rather than failing the whole parse;
/// fragments are stripped. Values may be empty — callers decide what counts
/// as complete.
fn scan_query_cookies(query: &str) -> LoginCookies {
    let mut cookies = LoginCookies {
        sessdata: String::new(),
        bili_jct: String::new(),
        dede_user_id: String::new(),
    };
    for pair in query.split('&') {
        if let Some((key, value)) = pair.split_once('=') {
            match key {
                "SESSDATA" => cookies.sessdata = percent_decode(value),
                "bili_jct" => cookies.bili_jct = percent_decode(value),
                "DedeUserID" => cookies.dede_user_id = percent_decode(value),
                _ => {}
            }
        }
    }
    cookies
}

/// Parse cookies out of the confirmed poll's redirect URL (source ③).
fn parse_redirect_query(url: &str) -> Option<LoginCookies> {
    let query = url.split_once('?')?.1.split('#').next()?;
    Some(scan_query_cookies(query))
}

/// Assemble the final cookies from jar pairs (sources ①+②) plus the
/// redirect URL (source ③), which overrides the jar when both have a value —
/// mirroring the merge order of app/services/bilibili.py.
///
/// Returns `None` when SESSDATA / DedeUserID are still missing afterwards;
/// an absent `bili_jct` is tolerated (read-only flows do not need CSRF).
fn extract_cookies(jar: &[(String, String)], redirect_url: &str) -> Option<LoginCookies> {
    // Start from the jar, then fold the redirect query over it.
    let mut pairs: Vec<(String, String)> = jar.to_vec();
    if let Some(query_cookies) = parse_redirect_query(redirect_url) {
        for (name, value) in [
            ("SESSDATA", query_cookies.sessdata),
            ("bili_jct", query_cookies.bili_jct),
            ("DedeUserID", query_cookies.dede_user_id),
        ] {
            if !value.is_empty() {
                if let Some(slot) = pairs.iter_mut().find(|(existing, _)| existing == name) {
                    slot.1 = value;
                } else {
                    pairs.push((name.to_string(), value));
                }
            }
        }
    }

    let pick = |name: &str| -> Option<String> {
        pairs
            .iter()
            .rev()
            .find(|(existing, _)| existing == name)
            .map(|(_, value)| value.clone())
            .filter(|value| !value.is_empty())
    };
    let sessdata = pick("SESSDATA")?;
    let dede_user_id = pick("DedeUserID")?;
    Some(LoginCookies {
        sessdata,
        bili_jct: pick("bili_jct").unwrap_or_default(),
        dede_user_id,
    })
}

/// Classification of one poll response's inner code.
#[derive(Debug)]
enum PollOutcome {
    Waiting,
    Scanned,
    Expired,
    /// Redirect URL (may be empty/incomplete) + refresh token.
    Confirmed(String, String),
}

/// Map the poll response's inner code to an outcome.
fn map_poll_code(code: i64, redirect_url: &str, refresh_token: &str) -> Result<PollOutcome, String> {
    match code {
        CODE_WAITING => Ok(PollOutcome::Waiting),
        CODE_SCANNED => Ok(PollOutcome::Scanned),
        CODE_EXPIRED => Ok(PollOutcome::Expired),
        CODE_CONFIRMED => Ok(PollOutcome::Confirmed(redirect_url.to_string(), refresh_token.to_string())),
        other => Err(format!("二维码状态异常（code {other}）")),
    }
}

/// UI-safe start payload handed to the frontend.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QrLoginStart {
    pub qrcode_key: String,
    /// Content to encode into the QR image (the mobile app scans this URL).
    pub qr_url: String,
}

/// One poll result as surfaced to the frontend.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QrPollState {
    /// `waiting` | `scanned` | `expired` | `confirmed`.
    pub state: String,
    /// Present only when `state == "confirmed"`.
    pub account: Option<BiliAccount>,
}

/// Generate a fresh QR code and open its cookie jar.
#[tauri::command]
pub async fn bili_qr_generate() -> Result<QrLoginStart, String> {
    tauri::async_runtime::spawn_blocking(|| -> Result<QrLoginStart, String> {
        let agent = build_agent()?;
        let url = format!("{PASSPORT_BASE}/x/passport-login/web/qrcode/generate");
        let reply = get_json_reply(&agent, &url, None)?;
        let data = reply
            .value
            .get("data")
            .ok_or_else(|| "二维码生成失败：响应缺少 data".to_string())?;
        let qrcode_key = data
            .get("qrcode_key")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "二维码生成失败：缺少 qrcode_key".to_string())?
            .to_string();
        let qr_url = data
            .get("url")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "二维码生成失败：缺少 url".to_string())?
            .to_string();

        // Open the jar with whatever generate already set (usually nothing).
        apply_set_cookies(&qrcode_key, &reply.set_cookies);
        Ok(QrLoginStart { qrcode_key, qr_url })
    })
    .await
    .map_err(|err| format!("task failed: {err}"))?
}

/// Poll once; on confirmed, persist the session and verify identity via nav.
#[tauri::command]
pub async fn bili_qr_poll(qrcode_key: String, db: State<'_, Db>) -> Result<QrPollState, String> {
    let qrcode_key = qrcode_key.trim().to_string();
    if qrcode_key.is_empty() {
        return Err("qrcode_key 不能为空".to_string());
    }

    // Owned data crosses into the blocking worker; no lock is held across it.
    let jar = jar_pairs(&qrcode_key);
    let jar_cookie = cookie_from_pairs(&jar);
    let worker_key = qrcode_key.clone();

    let outcome = tauri::async_runtime::spawn_blocking(move || -> Result<PollOutcome, String> {
        let agent = build_agent()?;
        let url = format!("{PASSPORT_BASE}/x/passport-login/web/qrcode/poll?qrcode_key={worker_key}");
        let reply = get_json_reply(&agent, &url, jar_cookie.as_deref())?;
        // Absorb this response's cookies into the jar BEFORE classifying so
        // a confirmed response's Set-Cookie participates in the merge.
        apply_set_cookies(&worker_key, &reply.set_cookies);
        let data = reply
            .value
            .get("data")
            .cloned()
            .unwrap_or_default();
        let code = data.get("code").and_then(|c| c.as_i64()).unwrap_or(-1);
        let redirect_url = data.get("url").and_then(|u| u.as_str()).unwrap_or("");
        let refresh_token = data
            .get("refresh_token")
            .and_then(|t| t.as_str())
            .unwrap_or("");
        map_poll_code(code, redirect_url, refresh_token)
    })
    .await
    .map_err(|err| format!("task failed: {err}"))??;

    match outcome {
        PollOutcome::Waiting => Ok(QrPollState { state: "waiting".into(), account: None }),
        PollOutcome::Scanned => Ok(QrPollState { state: "scanned".into(), account: None }),
        PollOutcome::Expired => {
            pop_jar(&qrcode_key);
            Ok(QrPollState { state: "expired".into(), account: None })
        }
        PollOutcome::Confirmed(redirect_url, refresh_token) => {
            // Merge sources exactly like the reference implementation.
            let jar = jar_pairs(&qrcode_key);
            let cookies = extract_cookies(&jar, &redirect_url)
                .ok_or_else(|| "登录回调数据异常，请重试".to_string())?;

            let mut session = BiliSession {
                sessdata: cookies.sessdata,
                bili_jct: cookies.bili_jct,
                dede_user_id: cookies.dede_user_id.clone(),
                mid: cookies.dede_user_id.parse().unwrap_or(0),
                uname: String::new(),
                face: String::new(),
                refresh_token,
                logged_in_at: unix_now(),
            };

            // Identity check fills uname/face and validates the mid.
            let identity = fetch_nav_identity(&session.cookie_header()).await?;
            if identity.mid > 0 {
                session.mid = identity.mid;
            }
            session.uname = identity.uname;
            session.face = identity.face;

            if session.mid <= 0 {
                pop_jar(&qrcode_key);
                return Err("无法识别哔哩哔哩账号身份，请重试".to_string());
            }

            let conn = db
                .conn
                .lock()
                .map_err(|err| format!("failed to acquire database lock: {err}"))?;
            save_session(&conn, &session)?;
            // Terminal state reached successfully — drop the jar.
            pop_jar(&qrcode_key);
            Ok(QrPollState {
                state: "confirmed".into(),
                account: Some(account_of(&session)),
            })
        }
    }
}

/// Identity fields returned by the nav endpoint.
struct NavIdentity {
    mid: i64,
    uname: String,
    face: String,
}

/// Blocking helper: call `/x/web-interface/nav` with cookies.
///
/// nav returns `code -101` when the cookies are not logged in; that specific
/// case maps to the shared auth-expired sentinel.
fn fetch_nav_identity_blocking(cookie: &str) -> Result<NavIdentity, String> {
    let agent = build_agent()?;
    let value = get_json(&agent, NAV_URL, Some(cookie))?;
    let data = value
        .get("data")
        .ok_or_else(|| "哔哩哔哩接口错误：nav 响应缺少 data".to_string())?;
    let mid = data.get("mid").and_then(|m| m.as_i64()).unwrap_or(0);
    if mid <= 0 {
        return Err(format!("{ERR_AUTH_EXPIRED}：Cookie 已过期，请重新扫码"));
    }
    Ok(NavIdentity {
        mid,
        uname: data
            .get("uname")
            .and_then(|u| u.as_str())
            .unwrap_or("")
            .to_string(),
        face: data
            .get("face")
            .and_then(|f| f.as_str())
            .unwrap_or("")
            .to_string(),
    })
}

/// Async wrapper so commands can await the blocking nav call off-runtime.
async fn fetch_nav_identity(cookie: &str) -> Result<NavIdentity, String> {
    let cookie = cookie.to_string();
    tauri::async_runtime::spawn_blocking(move || fetch_nav_identity_blocking(&cookie))
        .await
        .map_err(|err| format!("task failed: {err}"))?
}

/// Unix seconds right now (same convention as api_keys.rs).
fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|delta| delta.as_secs() as i64)
        .unwrap_or_default()
}

/// Probe whether the stored cookies still identify a logged-in user.
///
/// Updates the cached uname/face on success; on Bilibili's "not logged in"
/// (-101) or any other failure it reports through the shared sentinel so
/// the UI can grey out the account row. The row itself is kept — the failure
/// may be transient and re-scanning overwrites it anyway.
#[tauri::command]
pub async fn bili_session_verify(db: State<'_, Db>) -> Result<BiliAccount, String> {
    let session = {
        let conn = db
            .conn
            .lock()
            .map_err(|err| format!("failed to acquire database lock: {err}"))?;
        require_session(&conn)?
    };

    let identity = fetch_nav_identity(&session.cookie_header()).await?;

    // Re-read after the await: a concurrent logout/scan may have changed the row.
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    let mut current = require_session(&conn)?;
    current.uname = identity.uname;
    current.face = identity.face;
    save_session(&conn, &current)?;
    Ok(account_of(&current))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_decode_handles_escapes_but_keeps_plus() {
        assert_eq!(percent_decode("a%2Cb"), "a,b");
        assert_eq!(percent_decode("%E4%B8%AD"), "中");
        // Regression: '+' is part of real SESSDATA values and must survive.
        assert_eq!(percent_decode("a+b"), "a+b");
        // Trailing lone '%' stays literal instead of panicking.
        assert_eq!(percent_decode("100%"), "100%");
    }

    #[test]
    fn query_scan_tolerates_malformed_pairs() {
        // 'flag' has no '='; parsing must skip it instead of aborting.
        let cookies = scan_query_cookies("flag&SESSDATA=a%2Cb&bili_jct=j&DedeUserID=7");
        assert_eq!(cookies.sessdata, "a,b");
        assert_eq!(cookies.bili_jct, "j");
        assert_eq!(cookies.dede_user_id, "7");
        // Fragment stripping happens in parse_redirect_query, not here.
        let cookies = parse_redirect_query("https://x.com/?SESSDATA=a&bili_jct=j#junk")
            .expect("parse with fragment");
        assert_eq!(cookies.sessdata, "a");
        assert_eq!(cookies.bili_jct, "j");
    }

    #[test]
    fn extract_prefers_url_but_falls_back_to_jar() {
        // Jar alone suffices (URL missing entirely).
        let jar = vec![
            ("SESSDATA".to_string(), "jar-sess".to_string()),
            ("bili_jct".to_string(), "jar-jct".to_string()),
            ("DedeUserID".to_string(), "42".to_string()),
        ];
        let cookies = extract_cookies(&jar, "").expect("jar only");
        assert_eq!(cookies.sessdata, "jar-sess");

        // URL overrides matching jar entries.
        let cookies = extract_cookies(
            &jar,
            "https://x.com/?SESSDATA=url-sess&DedeUserID=42&bili_jct=url-jct",
        )
        .expect("merged");
        assert_eq!(cookies.sessdata, "url-sess");

        // URL fills a gap left by the jar (bili_jct absent from jar).
        let partial_jar = vec![("SESSDATA".to_string(), "s".to_string())];
        let cookies = extract_cookies(
            &partial_jar,
            "https://x.com/?DedeUserID=9&bili_jct=j",
        )
        .expect("merged gap");
        assert_eq!(cookies.dede_user_id, "9");
        assert_eq!(cookies.bili_jct, "j");
    }

    #[test]
    fn extract_requires_sessdata_and_mid_even_with_empty_jct() {
        // bili_jct missing everywhere is fine for read-only sessions.
        let jar = vec![
            ("SESSDATA".to_string(), "s".to_string()),
            ("DedeUserID".to_string(), "42".to_string()),
        ];
        let cookies =
            extract_cookies(&jar, "https://x.com/?SESSDATA=s&DedeUserID=42").expect("no jct ok");
        assert_eq!(cookies.bili_jct, "");

        // SESSDATA missing everywhere fails.
        assert!(extract_cookies(&[], "https://x.com/?DedeUserID=42").is_none());
        // DedeUserID missing everywhere fails.
        assert!(
            extract_cookies(&[("SESSDATA".to_string(), "s".to_string())], "").is_none()
        );
    }

    #[test]
    fn poll_codes_map_to_states() {
        assert!(matches!(
            map_poll_code(CODE_WAITING, "", ""),
            Ok(PollOutcome::Waiting)
        ));
        assert!(matches!(
            map_poll_code(CODE_SCANNED, "", ""),
            Ok(PollOutcome::Scanned)
        ));
        assert!(matches!(
            map_poll_code(CODE_EXPIRED, "", ""),
            Ok(PollOutcome::Expired)
        ));
        match map_poll_code(CODE_CONFIRMED, "https://x.com/?a=1", "rt") {
            Ok(PollOutcome::Confirmed(url, refresh)) => {
                assert_eq!(url, "https://x.com/?a=1");
                assert_eq!(refresh, "rt");
            }
            other => panic!("expected confirmed, got {other:?}"),
        }
        assert!(map_poll_code(-101, "", "").is_err());
    }

    #[test]
    fn set_cookie_application_upserts_and_deletes() {
        let key = "test-key-upsert";
        apply_set_cookies(
            key,
            &[
                "SESSDATA=a%2Cb; Path=/; HttpOnly".to_string(),
                "bili_jct=t; Path=/".to_string(),
            ],
        );
        let pairs = jar_pairs(key);
        assert!(pairs.contains(&("SESSDATA".to_string(), "a%2Cb".to_string())));
        assert!(pairs.contains(&("bili_jct".to_string(), "t".to_string())));

        // Overwrite one value, delete another via the empty-value marker.
        apply_set_cookies(key, &["SESSDATA=new".to_string(), "bili_jct=; Path=/".to_string()]);
        let pairs = jar_pairs(key);
        assert!(pairs.contains(&("SESSDATA".to_string(), "new".to_string())));
        assert!(!pairs.iter().any(|(n, _)| n == "bili_jct"));

        pop_jar(key);
        assert!(jar_pairs(key).is_empty());
    }

    #[test]
    fn cookie_header_from_jar_pairs() {
        let header = cookie_from_pairs(&[
            ("SESSDATA".to_string(), "s".to_string()),
            ("DedeUserID".to_string(), "1".to_string()),
        ])
        .expect("header");
        assert_eq!(header, "SESSDATA=s; DedeUserID=1");
        assert!(cookie_from_pairs(&[]).is_none());
    }
}
