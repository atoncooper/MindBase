//! B站 WBI request signing, ported from the backend's `app/services/wbi.py`.
//!
//! Some player/web endpoints (`playurl`, `conclusion/get`) expect a `w_rid`
//! signature derived from public rotation keys. The keys come anonymously
//! from `/x/web-interface/nav` (code -101 "not logged in" still ships them),
//! are stable for hours and are cached in-process for 6 — the same window as
//! the backend.
//!
//! The signature input must match Python's `urlencode` byte-for-byte
//! (`quote_plus`: unreserved letters/digits/`_.-~` literal, space → `+`,
//! everything else percent-encoded uppercase), which is why the encoder here
//! is hand-rolled instead of using any URL crate.

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use md5::{Digest, Md5};

use crate::bilibili::REFERER;
use crate::bilibili::USER_AGENT;

/// WBI key permutation table (from bilibili-API-collect; identical to wbi.py).
const MIXIN_KEY_ENC_TAB: [usize; 64] = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, //
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, //
    37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, //
    22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

/// How long fetched keys stay trusted; B站 rotates at most daily.
const KEY_TTL: Duration = Duration::from_secs(6 * 3600);

/// Process-wide `{mixin_key, cached_at}`; `OnceLock<Mutex<_>>` mirrors the
/// login flow's cookie-jar pattern (never blocks startup, lazily initialized).
static KEY_CACHE: OnceLock<Mutex<Option<(String, Instant)>>> = OnceLock::new();

/// Permute + truncate the concatenated img/sub key names into the mixin key.
fn mixin_key_from(img_name: &str, sub_name: &str) -> String {
    let orig: Vec<char> = format!("{img_name}{sub_name}").chars().collect();
    MIXIN_KEY_ENC_TAB
        .iter()
        .filter_map(|&i| orig.get(i))
        .collect::<String>()
        .chars()
        .take(32)
        .collect()
}

/// Lowercase MD5 hex of the UTF-8 input.
fn md5_hex(input: &str) -> String {
    let mut hasher = Md5::new();
    hasher.update(input.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(32);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Python `urllib.parse.quote_plus` equivalent (the exact encoding wbi.py's
/// `urlencode` produces): keep RFC-3986 unreserved bytes literal, map space to
/// `+`, percent-encode everything else with uppercase hex.
fn quote_plus(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for &byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'_' | b'.' | b'-' | b'~' => {
                out.push(byte as char);
            }
            b' ' => out.push('+'),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// Characters B站 forbids inside signed values (wbi.py `_filter_params`).
const FORBIDDEN_CHARS: &str = "!'()*";

/// Strip the forbidden characters from one value.
fn filter_value(value: &str) -> String {
    value.chars().filter(|c| !FORBIDDEN_CHARS.contains(*c)).collect()
}

/// Build the canonical query string and its `w_rid` signature.
///
/// Pure: sorting, filtering, timestamp injection and hashing all happen here
/// so tests can pin exact outputs without network access.
fn sign_with(params: &mut Vec<(String, String)>, mixin_key: &str, wts: u64) {
    for (_, value) in params.iter_mut() {
        *value = filter_value(value);
    }
    params.push(("wts".to_string(), wts.to_string()));
    params.sort_by(|a, b| a.0.cmp(&b.0));
    let query = params
        .iter()
        .map(|(key, value)| format!("{key}={}", quote_plus(value)))
        .collect::<Vec<_>>()
        .join("&");
    let w_rid = md5_hex(&format!("{query}{mixin_key}"));
    params.push(("w_rid".to_string(), w_rid));
}

/// Fetch fresh keys from `/x/web-interface/nav` and derive the mixin key.
fn fetch_mixin_key(agent: &ureq::Agent) -> Result<String, String> {
    const NAV_URL: &str = "https://api.bilibili.com/x/web-interface/nav";
    let body = agent
        .get(NAV_URL)
        .set("User-Agent", USER_AGENT)
        .set("Referer", REFERER)
        .call()
        .map_err(|err| format!("获取 WBI keys 失败：{err}"))?
        .into_string()
        .map_err(|err| format!("读取 WBI keys 响应失败：{err}"))?;
    let value: serde_json::Value =
        serde_json::from_str(&body).map_err(|err| format!("解析 WBI keys 失败：{err}"))?;

    // Anonymous nav answers code=-101 but still ships wbi_img — the keys are
    // public. Only a missing/malformed wbi_img is fatal.
    let wbi_img = value.pointer("/data/wbi_img").ok_or("获取 Wbi keys 失败：响应缺少 wbi_img")?;
    let img_url = wbi_img
        .get("img_url")
        .and_then(|v| v.as_str())
        .ok_or("获取 Wbi keys 失败：缺少 img_url")?;
    let sub_url = wbi_img
        .get("sub_url")
        .and_then(|v| v.as_str())
        .ok_or("获取 Wbi keys 失败：缺少 sub_url")?;

    let name_of = |url: &str| -> String {
        url.rsplit('/')
            .next()
            .unwrap_or_default()
            .split('.')
            .next()
            .unwrap_or_default()
            .to_string()
    };
    let key = mixin_key_from(&name_of(img_url), &name_of(sub_url));
    if key.len() < 32 {
        return Err("获取 Wbi keys 失败：key 长度异常".to_string());
    }
    Ok(key)
}

/// Cached mixin key lookup; refreshes after [`KEY_TTL`].
fn get_mixin_key(agent: &ureq::Agent) -> Result<String, String> {
    let cache = KEY_CACHE.get_or_init(|| Mutex::new(None));
    if let Ok(guard) = cache.lock() {
        if let Some((key, cached_at)) = guard.as_ref() {
            if cached_at.elapsed() < KEY_TTL {
                return Ok(key.clone());
            }
        }
    }
    let key = fetch_mixin_key(agent)?;
    if let Ok(mut guard) = cache.lock() {
        *guard = Some((key.clone(), Instant::now()));
    }
    Ok(key)
}

/// Unix seconds right now (0 when the clock is before the epoch — same
/// fallback as every other timestamp in this codebase).
fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|delta| delta.as_secs())
        .unwrap_or_default()
}

/// Sign `params` in place by appending `wts` and `w_rid`.
///
/// Callers then send the pairs as the query string of a GET request. Network
/// only happens when the cached keys are missing or stale.
pub(crate) fn sign_params(
    agent: &ureq::Agent,
    params: &mut Vec<(String, String)>,
) -> Result<(), String> {
    let mixin_key = get_mixin_key(agent)?;
    sign_with(params, &mixin_key, unix_now());
    Ok(())
}

/// Build a fully signed GET URL: appends `wts`/`w_rid` plus every param.
pub(crate) fn build_signed_url(
    agent: &ureq::Agent,
    base: &str,
    params: &[(&str, String)],
) -> Result<String, String> {
    let mut pairs: Vec<(String, String)> = params
        .iter()
        .map(|(key, value)| (key.to_string(), value.clone()))
        .collect();
    sign_params(agent, &mut pairs)?;
    let query = pairs
        .iter()
        .map(|(key, value)| format!("{key}={}", quote_plus(value)))
        .collect::<Vec<_>>()
        .join("&");
    Ok(format!("{base}?{query}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Golden vector generated from the backend's wbi.py algorithm.
    const IMG_NAME: &str = "7cd084941338484aae1ad9425b84077c";
    const SUB_NAME: &str = "4932caff0ff746eab6f01bf08b70ac45";

    #[test]
    fn mixin_key_matches_backend_golden_vector() {
        assert_eq!(
            mixin_key_from(IMG_NAME, SUB_NAME),
            "ea1db124af3c7062474693fa704f4ff8"
        );
        // Truncation to 32 chars even with long inputs.
        let long_a = "a".repeat(40);
        let long_b = "b".repeat(40);
        assert_eq!(mixin_key_from(&long_a, &long_b).len(), 32);
    }

    #[test]
    fn quote_plus_matches_python_urlencode() {
        assert_eq!(quote_plus("one two"), "one+two");
        assert_eq!(quote_plus("标题测试"), "%E6%A0%87%E9%A2%98%E6%B5%8B%E8%AF%95");
        assert_eq!(quote_plus("a~b-c_d.e"), "a~b-c_d.e");
        assert_eq!(quote_plus("100%"), "100%25");
        assert_eq!(quote_plus("a/b"), "a%2Fb");
    }

    #[test]
    fn sign_with_matches_backend_golden_vector() {
        let mut params: Vec<(String, String)> = [
            ("foo", "one two"),
            ("bvid", "BV1xx411c7mD"),
            ("cid", "42"),
            ("title", "标题(测试)!"),
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        sign_with(&mut params, "ea1db124af3c7062474693fa704f4ff8", 1_700_000_000);

        // Sorted keys with wts appended, forbidden chars stripped from values.
        let query = params
            .iter()
            .map(|(k, v)| format!("{k}={}", quote_plus(v)))
            .collect::<Vec<_>>()
            .join("&");
        assert_eq!(
            query,
            "bvid=BV1xx411c7mD&cid=42&foo=one+two&title=%E6%A0%87%E9%A2%98%E6%B5%8B%E8%AF%95\
             &wts=1700000000&w_rid=2a58035d77e23a804f2313d64081b385"
        );
    }

    #[test]
    fn filter_value_strips_only_forbidden_chars() {
        assert_eq!(filter_value("a!(b)*c'"), "abc");
        assert_eq!(filter_value("普通文本"), "普通文本");
    }

    #[test]
    fn md5_hex_is_lowercase_and_known() {
        assert_eq!(
            md5_hex("hello"),
            "5d41402abc4b2a76b9719d911017c592"
        );
    }
}
