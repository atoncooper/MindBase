//! Content acquisition for ingestion: the AI-conclusion outline and the
//! audio stream URL behind one 分P.
//!
//! Mirrors app/services/bilibili.py + content_fetcher.py: WBI-signed
//! `playurl` (unsigned fallback) for the audio, signed `conclusion/get` for
//! the outline used as chunk boundaries. Subtitles are intentionally not
//! fetched — the production backend's subtitle path is dead code.

use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::favorites::BiliPageItem;
use super::{REFERER, USER_AGENT};
use crate::wbi;

const API_BASE: &str = "https://api.bilibili.com";

/// Audio streams at or below this bandwidth are preferred (cheapest tier that
/// still decodes fine — mirrors bilibili.py's `max_bw = 64_000`).
const MAX_PREFERRED_BANDWIDTH: i64 = 64_000;

/// Smallest file size we accept as a real audio payload (< 1 KiB is an error
/// page or an empty body).
const MIN_AUDIO_BYTES: u64 = 1024;

/// Wall-clock budget for one CDN media download. The shared Bilibili API agent
/// is tuned for quick JSON round-trips ([`crate::bilibili::REQUEST_TIMEOUT`],
/// 8s) — far too tight for a multi-MB audio/video payload. Media downloads get
/// their own agent with this generous budget, mirroring the backend's
/// streaming downloader (`bilibili.py::download_audio_to_file`), so a slow CDN
/// doesn't cut the stream off mid-way with os error 10060.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);

/// Transient download retries. os error 10060 (connect timeout) is often
/// transient — a couple of short backoff retries resolve it without surfacing
/// a spurious page failure.
const DOWNLOAD_ATTEMPTS: usize = 3;

/// Everything ingestion needs about one video: title / description / uploader
/// plus the full 分P list. `desc` is kept as fetched video metadata (currently
/// only asserted in a parse test) — ingestion no longer degrades to it.
pub(crate) struct VideoBrief {
    pub title: String,
    #[allow(dead_code)]
    pub desc: String,
    pub upper_name: String,
    pub pages: Vec<BiliPageItem>,
}

/// Parse a `/x/web-interface/view` response body into a [`VideoBrief`].
fn parse_video_brief(value: &serde_json::Value) -> Result<VideoBrief, String> {
    let data = value.get("data").ok_or("视频信息响应缺少 data")?;
    let title = as_str(data, "title");
    if title.is_empty() {
        return Err("未找到该视频".to_string());
    }
    let pages = data
        .get("pages")
        .and_then(|p| p.as_array())
        .map(|items| {
            items
                .iter()
                .map(|page| {
                    let index = page
                        .get("page")
                        .and_then(|v| v.as_i64())
                        .unwrap_or_default();
                    let part_title = as_str(page, "part");
                    BiliPageItem {
                        cid: page.get("cid").and_then(|v| v.as_i64()).unwrap_or_default(),
                        index,
                        part_title: if part_title.is_empty() {
                            format!("第 {index} P")
                        } else {
                            part_title
                        },
                        duration_sec: page
                            .get("duration")
                            .and_then(|v| v.as_i64())
                            .unwrap_or_default(),
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(VideoBrief {
        title,
        desc: as_str(data, "desc"),
        upper_name: data
            .get("owner")
            .map(|owner| as_str(owner, "name"))
            .unwrap_or_default(),
        pages,
    })
}

/// Fetch title / desc / 分P list for one video (public view endpoint).
pub(crate) fn fetch_video_brief(
    agent: &ureq::Agent,
    cookie: Option<&str>,
    bvid: &str,
) -> Result<VideoBrief, String> {
    let mut request = agent
        .get(&format!("{API_BASE}/x/web-interface/view?bvid={bvid}"))
        .set("Referer", REFERER);
    if let Some(cookie) = cookie {
        request = request.set("Cookie", cookie);
    }
    let body = request
        .call()
        .map_err(|err| format!("获取视频信息失败：{err}"))?
        .into_string()
        .map_err(|err| format!("读取视频信息响应失败：{err}"))?;
    let value: serde_json::Value =
        serde_json::from_str(&body).map_err(|err| format!("解析视频信息失败：{err}"))?;
    parse_video_brief(&value)
}

/// Read one JSON field as a trimmed string with a default.
fn as_str(value: &serde_json::Value, key: &str) -> String {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn as_i64(value: &serde_json::Value, key: &str) -> Option<i64> {
    value.get(key).and_then(|v| v.as_i64())
}

/// First non-empty string among Bilibili's alternative field spellings.
fn pick_url_field(value: &serde_json::Value) -> Option<String> {
    ["baseUrl", "base_url", "url"]
        .iter()
        .find_map(|key| {
            let url = as_str(value, key);
            (!url.is_empty()).then_some(url)
        })
}

/// Extract outline titles from a `conclusion/get` response body.
///
/// Pure: `None`-ish shapes (missing model_result, empty outline) yield an
/// empty vec so callers can degrade to plain paragraph chunking.
fn parse_outline_titles(value: &serde_json::Value) -> Vec<String> {
    value
        .pointer("/data/model_result/outline")
        .and_then(|outline| outline.as_array())
        .map(|items| {
            items
                .iter()
                .map(|item| as_str(item, "title"))
                .filter(|title| !title.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// Pick the audio stream from a playurl response body.
///
/// Selection mirrors bilibili.py: prefer the lowest-bandwidth DASH track at
/// or below [`MAX_PREFERRED_BANDWIDTH`], else the lowest bandwidth overall;
/// legacy `durl[0]` is the last resort. `None` when nothing usable remains.
fn parse_audio_url(value: &serde_json::Value) -> Option<String> {
    let data = value.get("data")?;

    if let Some(tracks) = data.pointer("/dash/audio").and_then(|a| a.as_array()) {
        let candidates: Vec<(i64, String)> = tracks
            .iter()
            .filter_map(|track| {
                let url = pick_url_field(track)?;
                let bandwidth = as_i64(track, "bandwidth").unwrap_or(i64::MAX);
                Some((bandwidth, url))
            })
            .collect();
        if !candidates.is_empty() {
            let best_in_tier = candidates
                .iter()
                .filter(|(bandwidth, _)| *bandwidth <= MAX_PREFERRED_BANDWIDTH)
                .min_by_key(|(bandwidth, _)| *bandwidth);
            return Some(match best_in_tier {
                Some((_, url)) => url.clone(),
                None => {
                    let (bandwidth, url) = candidates
                        .iter()
                        .min_by_key(|(bw, _)| *bw)
                        .expect("non-empty above");
                    let _ = bandwidth;
                    url.clone()
                }
            });
        }
    }

    // Legacy FLV/mp4 fallback shape.
    data.pointer("/durl/0")
        .and_then(pick_url_field)
        .or_else(|| data.pointer("/durl/0/url").and_then(|v| v.as_str()).map(String::from))
}

/// Build the signed conclusion endpoint URL.
fn build_conclusion_url(agent: &ureq::Agent, bvid: &str, cid: i64) -> Result<String, String> {
    wbi::build_signed_url(
        agent,
        &format!("{API_BASE}/x/web-interface/view/conclusion/get"),
        &[("bvid", bvid.to_string()), ("cid", cid.to_string())],
    )
}

/// Unsigned playurl fallback (works for most videos, lower quality caps).
fn build_playurl_plain(bvid: &str, cid: i64) -> String {
    format!(
        "{API_BASE}/x/player/playurl?bvid={bvid}&cid={cid}&fnval=16&fnver=0&fourk=1"
    )
}

/// Fetch the AI outline titles of one 分P (best-effort chunking hints).
///
/// `Ok(None)` means "no AI summary available" — callers must treat any
/// outcome here as optional and never block ingestion on it.
pub(crate) fn fetch_outline_titles(
    agent: &ureq::Agent,
    cookie: Option<&str>,
    bvid: &str,
    cid: i64,
) -> Result<Option<Vec<String>>, String> {
    let url = build_conclusion_url(agent, bvid, cid)?;
    let request = agent.get(&url);
    let request = match cookie {
        Some(cookie) => request.set("Cookie", cookie),
        None => request,
    };
    let body = request
        .call()
        .map_err(|err| format!("获取视频总结失败：{err}"))?
        .into_string()
        .map_err(|err| format!("读取视频总结响应失败：{err}"))?;
    let value: serde_json::Value =
        serde_json::from_str(&body).map_err(|err| format!("解析视频总结失败：{err}"))?;
    let titles = parse_outline_titles(&value);
    Ok((!titles.is_empty()).then_some(titles))
}

/// Shared DASH request parameters for both playurl variants (`fnval=16` →
/// DASH manifest).
fn playurl_params(bvid: &str, cid: i64) -> Vec<(&'static str, String)> {
    vec![
        ("bvid", bvid.to_string()),
        ("cid", cid.to_string()),
        ("fnval", "16".to_string()),
        ("fnver", "0".to_string()),
        ("fourk", "1".to_string()),
    ]
}

/// Resolve the audio stream URL of one 分P; `None` when the video has no
/// usable audio (rare, e.g. pure-image videos).
///
/// Signed endpoint first, unsigned fallback on any failure or empty result —
/// mirrors bilibili.py's chain.
pub(crate) fn fetch_audio_url(
    agent: &ureq::Agent,
    cookie: Option<&str>,
    bvid: &str,
    cid: i64,
) -> Result<Option<String>, String> {
    let try_fetch = |url: String| -> Result<Option<String>, String> {
        let mut request = agent.get(&url).set("Referer", REFERER);
        if let Some(cookie) = cookie {
            request = request.set("Cookie", cookie);
        }
        let body = request
            .call()
            .map_err(|err| format!("获取音频地址失败：{err}"))?
            .into_string()
            .map_err(|err| format!("读取音频地址响应失败：{err}"))?;
        let value: serde_json::Value =
            serde_json::from_str(&body).map_err(|err| format!("解析音频地址失败：{err}"))?;
        Ok(parse_audio_url(&value))
    };

    let plain = || build_playurl_plain(bvid, cid);
    match wbi::build_signed_url(
        agent,
        &format!("{API_BASE}/x/player/wbi/playurl"),
        &playurl_params(bvid, cid),
    ) {
        Ok(signed_url) => match try_fetch(signed_url) {
            found @ Ok(Some(_)) => found,
            _ => try_fetch(plain()),
        },
        Err(_) => try_fetch(plain()),
    }
}

/// Resolve a **combined** (audio+video) stream URL for one 分P, used as a
/// fallback when the separate DASH audio stream can't be downloaded. Requests
/// `fnval=1` (legacy MP4/FLV with a built-in audio track) and returns `durl[0]`,
/// so ffmpeg can extract the audio track from the downloaded file.
pub(crate) fn fetch_combined_url(
    agent: &ureq::Agent,
    cookie: Option<&str>,
    bvid: &str,
    cid: i64,
) -> Result<Option<String>, String> {
    let try_fetch = |url: String| -> Result<Option<String>, String> {
        let mut request = agent.get(&url).set("Referer", REFERER);
        if let Some(cookie) = cookie {
            request = request.set("Cookie", cookie);
        }
        let body = request
            .call()
            .map_err(|err| format!("获取合并流地址失败：{err}"))?
            .into_string()
            .map_err(|err| format!("读取合并流地址响应失败：{err}"))?;
        let value: serde_json::Value =
            serde_json::from_str(&body).map_err(|err| format!("解析合并流地址失败：{err}"))?;
        // Combined stream lives under data.durl[0] (audio + video in one file).
        let data = value.get("data");
        Ok(data.and_then(|d| {
            d.pointer("/durl/0")
                .and_then(pick_url_field)
                .or_else(|| d.pointer("/durl/0/url").and_then(|v| v.as_str()).map(String::from))
        }))
    };

    // fnval=1 requests the legacy combined MP4/FLV format.
    let plain = || format!("{API_BASE}/x/player/playurl?bvid={bvid}&cid={cid}&fnval=1&fnver=0");
    let params = vec![
        ("bvid", bvid.to_string()),
        ("cid", cid.to_string()),
        ("fnval", "1".to_string()),
        ("fnver", "0".to_string()),
    ];
    match wbi::build_signed_url(
        agent,
        &format!("{API_BASE}/x/player/wbi/playurl"),
        &params,
    ) {
        Ok(signed_url) => match try_fetch(signed_url) {
            found @ Ok(Some(_)) => found,
            _ => try_fetch(plain()),
        },
        Err(_) => try_fetch(plain()),
    }
}

/// Probe whether DashScope can realistically fetch `url` itself.
///
/// HEAD first, then a 1-byte ranged GET (some CDNs reject HEAD). No cookies:
/// this simulates an outside consumer reaching the CDN link. Best-effort by
/// design — every failure reads as "not reachable".
pub(crate) fn probe_audio_url(url: &str) -> bool {
    let probe_agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(10))
        .build();
    if probe_agent
        .head(url)
        .set("User-Agent", USER_AGENT)
        .set("Referer", REFERER)
        .call()
        .is_ok()
    {
        return true;
    }
    probe_agent
        .get(url)
        .set("Range", "bytes=0-0")
        .set("User-Agent", USER_AGENT)
        .set("Referer", REFERER)
        .call()
        .is_ok()
}

/// Stream the audio/video CDN payload to `dest`; returns the path on success.
///
/// Downloads use a dedicated agent with a generous [`DOWNLOAD_TIMEOUT`] — not
/// the short API agent — and retry transient connection failures (os error
/// 10060) up to [`DOWNLOAD_ATTEMPTS`] times with backoff, mirroring the
/// backend's streaming downloader which returns gracefully on failure so the
/// caller can fall back to the next acquisition path.
pub(crate) fn download_audio(
    url: &str,
    cookie: Option<&str>,
    dest: &Path,
) -> Result<PathBuf, String> {
    let download_agent = ureq::AgentBuilder::new()
        .timeout(DOWNLOAD_TIMEOUT)
        .user_agent(USER_AGENT)
        .build();

    let mut last_err: Option<String> = None;
    for attempt in 0..DOWNLOAD_ATTEMPTS {
        match download_once(&download_agent, url, cookie, dest) {
            Ok(path) => return Ok(path),
            Err(err) => {
                last_err = Some(err);
                // Backoff between transient attempts; the final failure is
                // reported with the last error text.
                if attempt + 1 < DOWNLOAD_ATTEMPTS {
                    std::thread::sleep(Duration::from_millis(1500 * (attempt as u64 + 1)));
                }
            }
        }
    }
    Err(last_err.unwrap_or_else(|| "下载音频失败".to_string()))
}

/// One download attempt (no retry). Writes the response body to `dest` and
/// validates the payload is non-trivial.
fn download_once(
    agent: &ureq::Agent,
    url: &str,
    cookie: Option<&str>,
    dest: &Path,
) -> Result<PathBuf, String> {
    let mut request = agent.get(url).set("User-Agent", USER_AGENT).set("Referer", REFERER);
    if let Some(cookie) = cookie {
        request = request.set("Cookie", cookie);
    }
    let response = request
        .call()
        .map_err(|err| format!("下载音频失败：{err}"))?;

    let file = std::fs::File::create(dest)
        .map_err(|err| format!("无法创建临时文件 {}：{err}", dest.display()))?;
    let mut writer = BufWriter::new(file);
    let mut reader = response.into_reader();
    std::io::copy(&mut reader, &mut writer)
        .map_err(|err| format!("下载音频中断：{err}"))?;
    writer
        .flush()
        .map_err(|err| format!("写入临时音频失败：{err}"))?;

    let written = std::fs::metadata(dest)
        .map_err(|err| format!("校验临时音频失败：{err}"))?
        .len();
    if written < MIN_AUDIO_BYTES {
        let _ = std::fs::remove_file(dest);
        return Err(format!("下载的音频无效（仅 {written} 字节）"));
    }
    Ok(dest.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn outline_titles_extract_and_skip_empty() {
        let body = json!({
            "code": 0,
            "data": { "model_result": { "outline": [
                { "title": "第一部分 简介" },
                { "title": "" },
                { "title": "第二部分 原理" }
            ]}}
        });
        assert_eq!(
            parse_outline_titles(&body),
            vec!["第一部分 简介".to_string(), "第二部分 原理".to_string()]
        );
        // Missing model_result / empty outline both degrade to empty.
        assert!(parse_outline_titles(&json!({ "code": 0 })).is_empty());
        assert!(parse_outline_titles(&json!({ "code": -400 })).is_empty());
    }

    #[test]
    fn audio_selection_prefers_lowest_within_tier() {
        let body = json!({
            "code": 0,
            "data": { "dash": { "audio": [
                { "id": 30216, "bandwidth": 30000, "baseUrl": "https://cdn/30k" },
                { "id": 30232, "bandwidth": 64000, "baseUrl": "https://cdn/64k" },
                { "id": 30280, "bandwidth": 192000, "baseUrl": "https://cdn/192k" }
            ]}}
        });
        assert_eq!(parse_audio_url(&body).as_deref(), Some("https://cdn/30k"));
    }

    #[test]
    fn audio_selection_falls_back_to_lowest_overall() {
        let body = json!({
            "code": 0,
            "data": { "dash": { "audio": [
                { "id": 30280, "bandwidth": 192000, "base_url": "https://cdn/192k" },
                { "id": 30251, "bandwidth": 100000, "base_url": "https://cdn/100k" }
            ]}}
        });
        assert_eq!(parse_audio_url(&body).as_deref(), Some("https://cdn/100k"));
    }

    #[test]
    fn audio_selection_supports_legacy_shapes() {
        // Legacy durl entry and the snake_case field spelling.
        let durl = json!({ "code": 0, "data": { "durl": [ { "url": "https://cdn/flv" } ] } });
        assert_eq!(parse_audio_url(&durl).as_deref(), Some("https://cdn/flv"));
        // Nothing usable at all.
        assert_eq!(parse_audio_url(&json!({ "code": 0, "data": {} })), None);
    }

    #[test]
    fn playurl_plain_contains_dash_flags() {
        let url = build_playurl_plain("BV1AbCdEfGhI", 42);
        assert!(url.contains("/x/player/playurl?"));
        assert!(url.contains("fnval=16"));
        assert!(url.contains("cid=42"));
    }

    #[test]
    fn url_fields_tried_in_order() {
        let value = json!({ "base_url": "", "url": "https://cdn/x" });
        assert_eq!(pick_url_field(&value).as_deref(), Some("https://cdn/x"));
    }

    #[test]
    fn video_brief_parses_title_desc_and_pages() {
        let body = json!({
            "code": 0,
            "data": {
                "title": "视频标题",
                "desc": "这是简介",
                "owner": { "name": "UP主" },
                "pages": [
                    { "page": 1, "cid": 111, "part": "", "duration": 60 },
                    { "page": 2, "cid": 222, "part": "第二P", "duration": 120 }
                ]
            }
        });
        let brief = parse_video_brief(&body).expect("parse");
        assert_eq!(brief.title, "视频标题");
        assert_eq!(brief.desc, "这是简介");
        assert_eq!(brief.upper_name, "UP主");
        assert_eq!(brief.pages.len(), 2);
        // Empty `part` gets the 第 N P placeholder, same as favorites.rs.
        assert_eq!(brief.pages[0].part_title, "第 1 P");
        assert_eq!(brief.pages[1].part_title, "第二P");
        // Missing data / title are hard errors.
        assert!(parse_video_brief(&json!({ "code": -404 })).is_err());
    }
}
