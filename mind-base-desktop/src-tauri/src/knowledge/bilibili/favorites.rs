//! Favorites browsing: folder list and paged video listing (read-only).
//!
//! Both endpoints need login cookies but no WBI signing, which keeps this
//! module free of any signing machinery. Invalid videos are *marked*, not
//! dropped: silently filtering them would make `totalCount` disagree with
//! the visible rows, and a later knowledge-ingestion pass needs the count.

use serde::Serialize;
use tauri::State;

use super::{build_agent, get_json, require_session, Db};

const API_BASE: &str = "https://api.bilibili.com";

/// Bilibili caps `ps` at 20 for the resource-list endpoint.
pub(crate) const PAGE_SIZE: i64 = 20;

/// Titles Bilibili uses for dead entries.
const INVALID_TITLES: [&str; 2] = ["已失效视频", "已删除视频"];

/// One created favorites folder.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BiliFavoriteFolder {
    pub media_id: i64,
    pub title: String,
    pub media_count: i64,
    pub is_default: bool,
}

/// One video entry in a folder listing.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BiliVideoItem {
    pub bvid: String,
    pub title: String,
    pub cover: String,
    pub duration_sec: i64,
    pub upper_name: String,
    /// True when Bilibili reports the entry as dead; shown greyed out.
    pub invalid: bool,
}

/// One page of a folder's contents.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BiliVideoPage {
    pub folder_title: String,
    pub total_count: i64,
    pub page: i64,
    pub has_more: bool,
    pub videos: Vec<BiliVideoItem>,
}

/// True when an entry is dead per app/services/bilibili.py's filter rule.
fn is_invalid(attr: i64, title: &str) -> bool {
    attr == 9 || INVALID_TITLES.contains(&title)
}

/// Default-folder heuristic, matching the reference implementation's
/// fallback chain (`type==1` → `attr==1` → exact title).
fn is_default_folder(folder: &serde_json::Value) -> bool {
    if folder.get("type").and_then(|v| v.as_i64()) == Some(1) {
        return true;
    }
    if folder.get("attr").and_then(|v| v.as_i64()) == Some(1) {
        return true;
    }
    folder
        .get("title")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .is_some_and(|title| title == "默认收藏夹")
}

/// Build the list-all URL for a user's created folders.
fn build_folder_list_url(mid: i64) -> String {
    format!("{API_BASE}/x/v3/fav/folder/created/list-all?up_mid={mid}")
}

/// Build one page of the resource-list endpoint (`pn` is 1-based).
///
/// `page < 1` normalizes to 1 so a sloppy client cannot request pn=0.
fn build_resource_list_url(media_id: i64, page: i64) -> String {
    let page = page.max(1);
    format!(
        "{API_BASE}/x/v3/fav/resource/list?media_id={media_id}&pn={page}&ps={PAGE_SIZE}&platform=web"
    )
}

/// Read one JSON field as i64 with a default when absent or non-numeric.
/// Read one JSON field as i64 with a default when absent or non-numeric.
fn as_i64(value: &serde_json::Value, key: &str) -> i64 {
    value.get(key).and_then(|v| v.as_i64()).unwrap_or(0)
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

/// Pick the folder identifier that `fav/resource/list` expects.
///
/// Mirrors app/favorites.py's `folder.id or media_id`: the list-all endpoint
/// does not guarantee a `media_id` on every entry — `id` is the reliable
/// primary, `media_id` the fallback. Returns 0 when neither exists; callers
/// treat 0 as invalid.
fn pick_media_id(folder: &serde_json::Value) -> i64 {
    folder
        .get("id")
        .and_then(|v| v.as_i64())
        .or_else(|| folder.get("media_id").and_then(|v| v.as_i64()))
        .unwrap_or(0)
}

/// List every folder the logged-in user created (default folder first).
#[tauri::command]
pub async fn bili_list_folders(db: State<'_, Db>) -> Result<Vec<BiliFavoriteFolder>, String> {
    // Owned data crosses into the blocking worker; no lock is held across it.
    let session = {
        let conn = db
            .conn
            .lock()
            .map_err(|err| format!("failed to acquire database lock: {err}"))?;
        require_session(&conn)?
    };

    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<BiliFavoriteFolder>, String> {
        let agent = build_agent()?;
        let value = get_json(
            &agent,
            &build_folder_list_url(session.mid),
            Some(&session.cookie_header()),
        )?;
        let list = value
            .pointer("/data/list")
            .and_then(|list| list.as_array())
            .cloned()
            .unwrap_or_default();

        let mut folders: Vec<BiliFavoriteFolder> = list
            .iter()
            .map(|folder| BiliFavoriteFolder {
                media_id: pick_media_id(folder),
                title: {
                    let title = as_str(folder, "title");
                    if title.is_empty() { "未知收藏夹".to_string() } else { title }
                },
                media_count: as_i64(folder, "media_count"),
                is_default: is_default_folder(folder),
            })
            .collect();
        folders.sort_by_key(|folder| !folder.is_default);
        Ok(folders)
    })
    .await
    .map_err(|err| format!("task failed: {err}"))?
}

/// Fetch one page of a folder's videos (ps fixed at Bilibili's cap of 20).
#[tauri::command]
pub async fn bili_list_folder_videos(
    media_id: i64,
    page: i64,
    db: State<'_, Db>,
) -> Result<BiliVideoPage, String> {
    if media_id <= 0 {
        return Err("收藏夹 ID 无效".to_string());
    }
    let session = {
        let conn = db
            .conn
            .lock()
            .map_err(|err| format!("failed to acquire database lock: {err}"))?;
        require_session(&conn)?
    };

    tauri::async_runtime::spawn_blocking(move || -> Result<BiliVideoPage, String> {
        let agent = build_agent()?;
        let normalized_page = page.max(1);
        let value = get_json(
            &agent,
            &build_resource_list_url(media_id, normalized_page),
            Some(&session.cookie_header()),
        )?;

        let data = value.get("data").cloned().unwrap_or_default();
        let medias = data
            .get("medias")
            .and_then(|m| m.as_array())
            .cloned()
            .unwrap_or_default();

        let videos = medias
            .iter()
            .map(|item| BiliVideoItem {
                bvid: as_str(item, "bvid"),
                title: as_str(item, "title"),
                cover: as_str(item, "cover"),
                duration_sec: as_i64(item, "duration"),
                upper_name: item
                    .get("upper")
                    .map(|upper| as_str(upper, "name"))
                    .unwrap_or_default(),
                invalid: is_invalid(as_i64(item, "attr"), &as_str(item, "title")),
            })
            .collect();

        Ok(BiliVideoPage {
            folder_title: data
                .get("info")
                .map(|info| as_str(info, "title"))
                .unwrap_or_default(),
            total_count: data
                .get("info")
                .map(|info| as_i64(info, "media_count"))
                .unwrap_or(0),
            page: normalized_page,
            has_more: data
                .get("has_more")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            videos,
        })
    })
    .await
    .map_err(|err| format!("task failed: {err}"))?
}

/// One 分P (part) of a video.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BiliPageItem {
    pub cid: i64,
    /// 1-based position inside the video.
    pub index: i64,
    pub part_title: String,
    pub duration_sec: i64,
}

/// Video detail behind a folder entry: title + full page list.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BiliVideoDetail {
    pub bvid: String,
    pub title: String,
    pub upper_name: String,
    pub pages: Vec<BiliPageItem>,
}

/// BV ids are exactly `BV` + 10 alphanumeric characters.
fn is_valid_bvid(bvid: &str) -> bool {
    bvid.len() == 12
        && bvid.starts_with("BV")
        && bvid[2..].bytes().all(|c| c.is_ascii_alphanumeric())
}

/// Build the view endpoint URL for one video.
fn build_view_url(bvid: &str) -> String {
    format!("{API_BASE}/x/web-interface/view?bvid={bvid}")
}

/// Fetch a video's detail including every 分P (cid / index / part / duration).
///
/// Uses the public view endpoint with the session cookie attached — same
/// source as app/services/bilibili.py's summary flow. No WBI signing needed.
#[tauri::command]
pub async fn bili_video_pages(bvid: String, db: State<'_, Db>) -> Result<BiliVideoDetail, String> {
    let bvid = bvid.trim().to_string();
    if !is_valid_bvid(&bvid) {
        return Err("bvid 格式无效".to_string());
    }
    let session = {
        let conn = db
            .conn
            .lock()
            .map_err(|err| format!("failed to acquire database lock: {err}"))?;
        require_session(&conn)?
    };

    tauri::async_runtime::spawn_blocking(move || -> Result<BiliVideoDetail, String> {
        let agent = build_agent()?;
        let value = get_json(
            &agent,
            &build_view_url(&bvid),
            Some(&session.cookie_header()),
        )?;
        let data = value.get("data").cloned().unwrap_or_default();
        if data.get("pages").is_none() {
            return Err("未找到该视频或没有分P 信息".to_string());
        }

        let pages = data
            .get("pages")
            .and_then(|p| p.as_array())
            .map(|items| {
                items
                    .iter()
                    .map(|page| {
                        let index = as_i64(page, "page");
                        let part_title = as_str(page, "part");
                        BiliPageItem {
                            cid: as_i64(page, "cid"),
                            index,
                            // Bilibili leaves `part` empty on single-P videos.
                            part_title: if part_title.is_empty() {
                                format!("第 {index} P")
                            } else {
                                part_title
                            },
                            duration_sec: as_i64(page, "duration"),
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();

        Ok(BiliVideoDetail {
            bvid,
            title: as_str(&data, "title"),
            upper_name: data
                .get("owner")
                .map(|owner| as_str(owner, "name"))
                .unwrap_or_default(),
            pages,
        })
    })
    .await
    .map_err(|err| format!("task failed: {err}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_detection_matches_reference_rule() {
        assert!(is_invalid(9, "随便什么标题"));
        assert!(!is_invalid(0, "正常视频"));
        assert!(is_invalid(0, "已失效视频"));
        assert!(is_invalid(0, "已删除视频"));
        // The title rule applies regardless of attr.
        assert!(is_invalid(2, "已失效视频"));
    }

    #[test]
    fn folder_url_contains_mid_only() {
        assert_eq!(
            build_folder_list_url(12345),
            "https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=12345"
        );
    }

    #[test]
    fn resource_url_clamps_page_and_pins_page_size() {
        assert_eq!(
            build_resource_list_url(777, 1),
            format!("https://api.bilibili.com/x/v3/fav/resource/list?media_id=777&pn=1&ps={PAGE_SIZE}&platform=web")
        );
        // pn=0 / negative normalize to 1.
        assert!(build_resource_list_url(777, 0).contains("pn=1&"));
        assert!(build_resource_list_url(777, -3).contains("pn=1&"));
    }

    #[test]
    fn default_folder_detection_chain() {
        assert!(is_default_folder(&serde_json::json!({ "type": 1 })));
        assert!(is_default_folder(&serde_json::json!({ "attr": 1 })));
        assert!(is_default_folder(&serde_json::json!({ "title": " 默认收藏夹 " })));
        assert!(!is_default_folder(&serde_json::json!({
            "type": 0, "attr": 0, "title": "学习"
        })));
    }

    #[test]
    fn media_id_prefers_id_and_falls_back() {
        // Both present → `id` wins (matches the reference implementation).
        assert_eq!(
            pick_media_id(&serde_json::json!({ "id": 111, "media_id": 222 })),
            111
        );
        // list-all entries may lack `media_id` entirely.
        assert_eq!(pick_media_id(&serde_json::json!({ "id": 333 })), 333);
        // Rare: only media_id.
        assert_eq!(pick_media_id(&serde_json::json!({ "media_id": 444 })), 444);
        // Neither → 0, which the command rejects as invalid.
        assert_eq!(pick_media_id(&serde_json::json!({ "title": "x" })), 0);
    }

    #[test]
    fn bvid_validation_is_shape_only() {
        assert!(is_valid_bvid("BV1AbCdEfGhI"));
        assert!(is_valid_bvid("BV1xx411c7mD")); // real-shaped historic id
        // Wrong prefix / length / charset.
        assert!(!is_valid_bvid("av170001"));
        assert!(!is_valid_bvid("BV123"));
        assert!(!is_valid_bvid("BV1AbCdEfGh!"));
        assert!(!is_valid_bvid(""));
    }

    #[test]
    fn view_url_contains_bvid() {
        assert_eq!(
            build_view_url("BV1AbCdEfGhI"),
            "https://api.bilibili.com/x/web-interface/view?bvid=BV1AbCdEfGhI"
        );
    }
}
