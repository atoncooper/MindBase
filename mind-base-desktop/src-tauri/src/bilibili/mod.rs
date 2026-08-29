//! Bilibili integration: QR-code login and favorites browsing, talking to
//! Bilibili's web APIs directly from the desktop app (no backend involved).
//!
//! Module layout:
//! - [`mod.rs`]  — shared transport (headers, agent, envelope parsing) and
//!   the locally persisted login session.
//! - [`login.rs`] — QR-code protocol, cookie extraction, identity check.
//! - [`favorites.rs`] — folder list + paged video listing.
//!
//! # Session storage
//!
//! Cookies live in the single-row `bili_session` table of the same SQLite
//! database as everything else, so they survive restarts and move together
//! with 数据存储 relocation. Secrets (`sessdata` / `bili_jct` /
//! `refresh_token`) never cross back to the frontend — the account DTO
//! carries only `mid` / `uname` / `face` / `logged_in_at`, mirroring the
//! api_keys.rs "secrets stay in the backend" rule.
//!
//! # Error contract
//!
//! Every "not logged in / cookie expired" failure is a `String` starting
//! with [`ERR_AUTH_EXPIRED`]; the frontend matches that prefix to decide
//! when to open the login dialog. This is the machine-readable slice of the
//! `Result<T, String>` command convention — keep the prefix stable.

pub mod favorites;
pub mod login;

/// Ingestion-side content acquisition (outline + audio URL + download).
pub(crate) mod content;

use std::time::Duration;

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use tauri::State;

use crate::db::Db;

/// Wall-clock cap for one Bilibili API request.
pub(crate) const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);

/// Bilibili rejects requests without a believable browser UA.
pub(crate) const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
     AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

pub(crate) const REFERER: &str = "https://www.bilibili.com/";
pub(crate) const ORIGIN: &str = "https://www.bilibili.com";

/// Error-prefix sentinel shared with the frontend (`lib/bili.ts`).
pub const ERR_AUTH_EXPIRED: &str = "登录已失效";

/// Account facts safe to expose to the UI (no credential fields, ever).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BiliAccount {
    pub mid: i64,
    pub uname: String,
    pub face: String,
    pub logged_in_at: i64,
}

/// Locally persisted login session (single row in `bili_session`).
#[derive(Debug, Clone)]
pub(crate) struct BiliSession {
    pub sessdata: String,
    pub bili_jct: String,
    pub dede_user_id: String,
    pub mid: i64,
    pub uname: String,
    pub face: String,
    pub refresh_token: String,
    pub logged_in_at: i64,
}

impl BiliSession {
    /// The three cookies Bilibili's web APIs expect, in header order.
    pub fn cookie_header(&self) -> String {
        format!(
            "SESSDATA={}; bili_jct={}; DedeUserID={}",
            self.sessdata, self.bili_jct, self.dede_user_id
        )
    }
}

/// Read the persisted session, if any.
pub(crate) fn read_session(conn: &Connection) -> Result<Option<BiliSession>, String> {
    let row = conn
        .query_row(
            "SELECT sessdata, bili_jct, dede_user_id, mid, uname, face, refresh_token, logged_in_at
             FROM bili_session WHERE id = 1",
            [],
            |row| {
                Ok(BiliSession {
                    sessdata: row.get(0)?,
                    bili_jct: row.get(1)?,
                    dede_user_id: row.get(2)?,
                    mid: row.get(3)?,
                    uname: row.get(4)?,
                    face: row.get(5)?,
                    refresh_token: row.get(6)?,
                    logged_in_at: row.get(7)?,
                })
            },
        )
        .optional()
        .map_err(|err| format!("failed to read bilibili session: {err}"))?;
    // A row without a usable credential is treated as logged out.
    Ok(row.filter(|session| !session.sessdata.is_empty() && session.mid > 0))
}

/// Insert or overwrite the single session row.
pub(crate) fn save_session(conn: &Connection, session: &BiliSession) -> Result<(), String> {
    let affected = conn
        .execute(
            "INSERT INTO bili_session(id, sessdata, bili_jct, dede_user_id, mid, uname, face,
                                       refresh_token, logged_in_at)
             VALUES(1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET
                 sessdata = excluded.sessdata,
                 bili_jct = excluded.bili_jct,
                 dede_user_id = excluded.dede_user_id,
                 mid = excluded.mid,
                 uname = excluded.uname,
                 face = excluded.face,
                 refresh_token = excluded.refresh_token,
                 logged_in_at = excluded.logged_in_at",
            params![
                session.sessdata,
                session.bili_jct,
                session.dede_user_id,
                session.mid,
                session.uname,
                session.face,
                session.refresh_token,
                session.logged_in_at,
            ],
        )
        .map_err(|err| format!("failed to persist bilibili session: {err}"))?;
    if affected == 0 {
        return Err("bilibili session persistence affected no rows".to_string());
    }
    Ok(())
}

/// Remove the session row (idempotent logout).
pub(crate) fn clear_session(conn: &Connection) -> Result<(), String> {
    conn.execute("DELETE FROM bili_session WHERE id = 1", [])
        .map_err(|err| format!("failed to clear bilibili session: {err}"))?;
    Ok(())
}

/// Require a session or fail with the shared auth-expired sentinel.
pub(crate) fn require_session(conn: &Connection) -> Result<BiliSession, String> {
    read_session(conn)?.ok_or_else(|| {
        format!("{ERR_AUTH_EXPIRED}：尚未登录哔哩哔哩，请先扫码登录")
    })
}

/// ureq agent with the shared timeout and browser UA.
///
/// Deliberately no proxy wiring: Bilibili API calls go out directly, matching
/// how a browser on this machine would reach them. Referer/Origin are set
/// per-request in [`get_json`] because `AgentBuilder` has no generic header
/// setter in ureq 2.x.
pub(crate) fn build_agent() -> Result<ureq::Agent, String> {
    Ok(ureq::AgentBuilder::new()
        .timeout(REQUEST_TIMEOUT)
        .user_agent(USER_AGENT)
        .build())
}

/// GET a URL with Bilibili's required headers and parse its envelope.
///
/// Envelope contract: top-level `{code, message|msg, data}`; `code == 0` is
/// success, anything else is an error whose message prefers `message` and
/// falls back to `msg`. Non-JSON bodies (risk-control pages, proxy HTML)
/// are truncated into the error instead of failing opaquely.
pub(crate) fn get_json(
    agent: &ureq::Agent,
    url: &str,
    cookie: Option<&str>,
) -> Result<serde_json::Value, String> {
    get_json_reply(agent, url, cookie).map(|reply| reply.value)
}

/// Envelope payload plus the response's `Set-Cookie` headers.
pub(crate) struct JsonReply {
    pub value: serde_json::Value,
    /// Raw `Set-Cookie` header values, in response order.
    pub set_cookies: Vec<String>,
}

/// Like [`get_json`] but also captures `Set-Cookie` headers — the login flow
/// needs them to mirror Bilibili's own client-side cookie jar.
pub(crate) fn get_json_reply(
    agent: &ureq::Agent,
    url: &str,
    cookie: Option<&str>,
) -> Result<JsonReply, String> {
    let mut request = agent
        .get(url)
        .set("Accept", "application/json")
        .set("Referer", REFERER)
        .set("Origin", ORIGIN);
    if let Some(cookie) = cookie {
        request = request.set("Cookie", cookie);
    }
    let response = request.call().map_err(|err| match err {
        ureq::Error::Status(code, _) => format!("HTTP {code}"),
        ureq::Error::Transport(transport) => {
            format!("网络错误，无法连接哔哩哔哩：{transport}")
        }
    })?;

    let set_cookies = response.all("set-cookie").into_iter().map(String::from).collect();
    let body = response
        .into_string()
        .map_err(|err| format!("failed to read response body: {err}"))?;
    Ok(JsonReply {
        value: parse_envelope(&body)?,
        set_cookies,
    })
}

/// Parse and validate a Bilibili envelope (see [`get_json`]).
fn parse_envelope(body: &str) -> Result<serde_json::Value, String> {
    let value: serde_json::Value = match serde_json::from_str(body) {
        Ok(value) => value,
        Err(_) => {
            let mut snippet = body.chars().take(200).collect::<String>();
            if body.chars().count() > 200 {
                snippet.push('…');
            }
            return Err(format!("哔哩哔哩返回了非 JSON 响应：{snippet}"));
        }
    };
    let code = value.get("code").and_then(|code| code.as_i64()).unwrap_or(0);
    if code != 0 {
        let message = value
            .get("message")
            .and_then(|m| m.as_str())
            .or_else(|| value.get("msg").and_then(|m| m.as_str()))
            .unwrap_or("未知错误");
        return Err(format!("哔哩哔哩接口错误({code})：{message}"));
    }
    Ok(value)
}

/// Tauri command: read-only session facts for the status card (no network).
///
/// Lives here because it only touches the session table.
#[tauri::command]
pub fn bili_session_status(db: State<'_, Db>) -> Result<Option<BiliAccount>, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    Ok(read_session(&conn)?.map(|session| account_of(&session)))
}

/// Tauri command: forget the stored session (idempotent logout).
///
/// Remote revocation is out of scope for now — the cookies simply stop
/// being used locally.
#[tauri::command]
pub fn bili_logout(db: State<'_, Db>) -> Result<(), String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    clear_session(&conn)
}

/// Project a stored session onto the UI-safe account DTO.
pub(crate) fn account_of(session: &BiliSession) -> BiliAccount {
    BiliAccount {
        mid: session.mid,
        uname: session.uname.clone(),
        face: session.face.clone(),
        logged_in_at: session.logged_in_at,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_session() -> BiliSession {
        BiliSession {
            sessdata: "abc%2Cdef".into(),
            bili_jct: "csrf-token".into(),
            dede_user_id: "42".into(),
            mid: 42,
            uname: "tester".into(),
            face: "http://example.com/face.jpg".into(),
            refresh_token: "rt".into(),
            logged_in_at: 1700000000,
        }
    }

    #[test]
    fn cookie_header_has_expected_shape() {
        assert_eq!(
            sample_session().cookie_header(),
            "SESSDATA=abc%2Cdef; bili_jct=csrf-token; DedeUserID=42"
        );
    }

    #[test]
    fn session_roundtrip_upsert_and_clear() {
        let conn = Connection::open_in_memory().expect("in-memory db");
        conn.execute_batch(crate::db::SCHEMA_SQL).expect("schema");

        // Empty database reads as logged out.
        assert!(read_session(&conn).expect("read").is_none());

        save_session(&conn, &sample_session()).expect("save");
        let loaded = read_session(&conn).expect("read").expect("some");
        assert_eq!(loaded.sessdata, "abc%2Cdef");
        assert_eq!(loaded.mid, 42);

        // Second save overwrites the single row instead of duplicating it.
        let mut updated = sample_session();
        updated.uname = "renamed".into();
        save_session(&conn, &updated).expect("save again");
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM bili_session", [], |row| row.get(0))
            .expect("count");
        assert_eq!(count, 1);
        assert_eq!(read_session(&conn).expect("read").unwrap().uname, "renamed");

        clear_session(&conn).expect("clear");
        // Clear is idempotent.
        clear_session(&conn).expect("clear again");
        assert!(read_session(&conn).expect("read").is_none());
    }

    #[test]
    fn row_without_credential_reads_as_logged_out() {
        let conn = Connection::open_in_memory().expect("in-memory db");
        conn.execute_batch(crate::db::SCHEMA_SQL).expect("schema");
        conn.execute(
            "INSERT INTO bili_session(id, sessdata, mid, logged_in_at) VALUES(1, '', 0, 1)",
            [],
        )
        .expect("seed empty row");
        assert!(read_session(&conn).expect("read").is_none());
        assert!(require_session(&conn).is_err());
    }

    #[test]
    fn envelope_parses_code_message_and_msg_fallback() {
        let ok = parse_envelope(r#"{"code":0,"data":{"a":1}}"#).expect("ok");
        assert_eq!(ok["data"]["a"], 1);

        let err = parse_envelope(r#"{"code":-101,"message":"账号未登录"}"#).unwrap_err();
        assert!(err.contains("-101") && err.contains("账号未登录"));

        // `msg` fallback when `message` is absent.
        let err = parse_envelope(r#"{"code":-352,"msg":"风控拦截"}"#).unwrap_err();
        assert!(err.contains("风控拦截"));
    }

    #[test]
    fn non_json_body_is_truncated_not_panic() {
        let html = format!("<html>{}</html>", "x".repeat(500));
        let err = parse_envelope(&html).unwrap_err();
        assert!(err.contains("非 JSON"));
        assert!(err.chars().count() < 260);
    }
}
