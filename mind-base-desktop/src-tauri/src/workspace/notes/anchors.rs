//! Bilibili anchors: target parsing, canonical jump URLs and anchor CRUD.

use rusqlite::{params, Connection};
use tauri::{Manager, State};

use crate::infra::db::{self, Db};
use crate::knowledge::bilibili::content as bili_content;

use super::{now_secs, AnchorRow};

/// Parsed bilibili target: video id, 分P index (1-based), timestamp seconds.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct BilibiliTarget {
    pub bvid: String,
    pub page_index: i64,
    pub seconds: i64,
}

/// Parse what a user pasted into a video anchor target.
///
/// Accepts full URLs (`https://www.bilibili.com/video/BVxx?p=2&t=95`) and
/// bare BV ids. Pure — the parse matrix lives in tests.
pub(crate) fn parse_bilibili_target(input: &str) -> Option<BilibiliTarget> {
    let trimmed = input.trim();

    // BV ids are exactly `BV` + 10 alphanumerics; find the first occurrence
    // anywhere so both bare ids and URLs work.
    let bytes = trimmed.as_bytes();
    let mut bvid: Option<String> = None;
    for index in 0..trimmed.len().saturating_sub(1) {
        if bytes[index] == b'B' && bytes[index + 1] == b'V' {
            let candidate = &trimmed[index..(index + 12).min(trimmed.len())];
            if candidate.len() == 12
                && candidate[2..].bytes().all(|c| c.is_ascii_alphanumeric())
            {
                bvid = Some(candidate.to_string());
                break;
            }
        }
    }
    let bvid = bvid?;

    let page_index = query_param(trimmed, "p")
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|page| *page >= 1)
        .unwrap_or(1);
    let seconds = query_param(trimmed, "t")
        .and_then(|value| {
            let digits: String = value.chars().take_while(char::is_ascii_digit).collect();
            digits.parse::<i64>().ok()
        })
        .unwrap_or(0);

    Some(BilibiliTarget {
        bvid,
        page_index,
        seconds,
    })
}

/// Read one raw query-string value (`?p=2&t=95` → "2" / "95").
fn query_param(input: &str, name: &str) -> Option<String> {
    let marker = format!("{name}=");
    let start = input.find(&marker)? + marker.len();
    let rest = &input[start..];
    let end = rest.find(['&', '#']).unwrap_or(rest.len());
    Some(rest[..end].to_string())
}

/// Canonical jump URL for one anchor (timestamp included when present).
pub(super) fn anchor_url(bvid: &str, page_index: i64, seconds: i64) -> String {
    let mut url = format!(
        "https://www.bilibili.com/video/{bvid}?p={page_index}"
    );
    if seconds > 0 {
        url.push_str(&format!("&t={seconds}"));
    }
    url
}

pub(super) fn fetch_anchors_conn(conn: &Connection, note_id: &str) -> Result<Vec<AnchorRow>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id, bvid, page_index, seconds, label, created_at
             FROM note_anchors WHERE note_id = ?1 ORDER BY created_at ASC",
        )
        .map_err(|err| format!("failed to load anchors: {err}"))?;
    let rows = statement
        .query_map(params![note_id], |row| {
            let bvid: String = row.get(1)?;
            let page_index: i64 = row.get(2)?;
            let seconds: i64 = row.get(3)?;
            Ok(AnchorRow {
                id: row.get(0)?,
                url: anchor_url(&bvid, page_index, seconds),
                bvid,
                page_index,
                seconds,
                label: row.get(4)?,
                created_at: row.get(5)?,
            })
        })
        .map_err(|err| format!("failed to query anchors: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("failed to read anchors: {err}"))
}

// ---------------------------------------------------------------------------
// Anchor commands (network touches bilibili view API for the title)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn anchor_add(
    app: tauri::AppHandle,
    note_id: String,
    input: String,
) -> Result<AnchorRow, String> {
    let target = parse_bilibili_target(&input)
        .ok_or_else(|| "无法识别视频：请粘贴 B 站视频链接或 BV 号".to_string())?;

    // Title lookup is best-effort: the anchor stays useful even offline,
    // falling back to the bare bvid as its label.
    let label_bvid = target.bvid.clone();
    let label = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let agent = crate::knowledge::bilibili::build_agent()?;
        match bili_content::fetch_video_brief(&agent, None, &label_bvid) {
            Ok(brief) => Ok(brief.title),
            Err(_) => Ok(label_bvid),
        }
    })
    .await
    .map_err(|err| format!("task failed: {err}"))?
    .unwrap_or_else(|_| target.bvid.clone());

    let db = app.state::<Db>();
    let anchor_id = db::local_id();
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    conn.execute(
        "INSERT INTO note_anchors(id, note_id, bvid, page_index, seconds, label, created_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            anchor_id,
            note_id,
            target.bvid,
            target.page_index,
            target.seconds,
            label,
            now_secs()
        ],
    )
    .map_err(|err| format!("failed to add anchor: {err}"))?;

    Ok(AnchorRow {
        url: anchor_url(&target.bvid, target.page_index, target.seconds),
        id: anchor_id,
        bvid: target.bvid,
        page_index: target.page_index,
        seconds: target.seconds,
        label,
        created_at: now_secs(),
    })
}

#[tauri::command]
pub fn anchor_delete(db: State<'_, Db>, anchor_id: String) -> Result<(), String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    conn.execute("DELETE FROM note_anchors WHERE id = ?1", params![anchor_id])
        .map_err(|err| format!("failed to delete anchor: {err}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // -- anchors --------------------------------------------------------------

    #[test]
    fn bilibili_target_parse_matrix() {
        // Full URL with p and t.
        let parsed =
            parse_bilibili_target("https://www.bilibili.com/video/BV1AbCdEfGhI?p=2&t=95&spm=x").unwrap();
        assert_eq!(parsed.bvid, "BV1AbCdEfGhI");
        assert_eq!(parsed.page_index, 2);
        assert_eq!(parsed.seconds, 95);

        // Bare BV id.
        let bare = parse_bilibili_target("BV1xx411c7mD").unwrap();
        assert_eq!(bare.bvid, "BV1xx411c7mD");
        assert_eq!(bare.page_index, 1);
        assert_eq!(bare.seconds, 0);

        // b23 short links carry no bvid — rejected rather than mis-parsed.
        assert!(parse_bilibili_target("https://b23.tv/abc123").is_none());
        assert!(parse_bilibili_target("随便一句话").is_none());
    }

    #[test]
    fn anchor_url_includes_timestamp_when_present() {
        assert_eq!(
            anchor_url("BV1AbCdEfGhI", 2, 95),
            "https://www.bilibili.com/video/BV1AbCdEfGhI?p=2&t=95"
        );
        assert_eq!(
            anchor_url("BV1AbCdEfGhI", 1, 0),
            "https://www.bilibili.com/video/BV1AbCdEfGhI?p=1"
        );
    }
}
