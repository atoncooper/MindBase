//! Local markdown notes: CRUD with optimistic concurrency, revision
//! snapshots (backend policy: ≥30% change after ≥10 minutes), URL-scheme
//! sanitization, and video anchors.
//!
//! Storage is plain markdown so the content stays portable and greppable —
//! the same source the web app edits. Rendering happens client-side through
//! react-markdown (no raw HTML), and the sanitizer here is the second line
//! of defense for anything that might smuggle a dangerous link in.

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::{Manager, State};

use crate::db::{self, Db};

/// A snapshot is due only this long after the previous one.
const SNAPSHOT_MIN_INTERVAL_SECS: i64 = 600;
/// Char-bigram Jaccard distance a save must reach to earn a snapshot.
const SNAPSHOT_DIFF_THRESHOLD: f64 = 0.30;
/// Revisions kept per note; older ones are pruned.
const MAX_REVISIONS_PER_NOTE: i64 = 20;
/// List-row snippet length.
const SNIPPET_CHARS: usize = 80;
/// Hard cap on the list query.
const LIST_LIMIT: i64 = 500;

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|delta| delta.as_secs() as i64)
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteListRow {
    pub id: String,
    pub title: String,
    pub pinned: bool,
    pub updated_at: i64,
    pub char_count: i64,
    /// First chars of the body (newlines collapsed) for the list preview.
    pub snippet: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchorRow {
    pub id: String,
    pub bvid: String,
    pub page_index: i64,
    pub seconds: i64,
    pub label: String,
    pub url: String,
    pub created_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteDetail {
    pub id: String,
    pub title: String,
    pub content: String,
    pub pinned: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub anchors: Vec<AnchorRow>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionMeta {
    pub id: String,
    pub note_id: String,
    pub char_count: i64,
    pub created_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateResult {
    pub updated_at: i64,
    pub char_count: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PinResult {
    pub pinned: bool,
    /// Post-toggle `updated_at` — callers must adopt it as their new
    /// concurrency baseline or their next save will be rejected.
    pub updated_at: i64,
}

// ---------------------------------------------------------------------------
// Sanitizer (Phase C)
// ---------------------------------------------------------------------------

/// Neutralize dangerous link targets inside markdown.
///
/// Mirrors the spirit of app/services/notes/markdown.py scaled to plain
/// markdown text: script/iframe blocks are dropped entirely and any link or
/// autolink target carrying `javascript:` / `vbscript:` / `data:` collapses
/// to `#`. BlockNote-free markdown rarely contains raw HTML, but pasted
/// content is attacker-controlled by definition.
pub(crate) fn sanitize_markdown(markdown: &str) -> String {
    let mut text = remove_html_blocks(markdown);
    text = sanitize_link_targets(&text);
    text
}

/// Drop `<script …>…</script>` / `<iframe …>…</iframe>` blocks wholesale,
/// repeatedly, case-insensitive.
fn remove_html_blocks(text: &str) -> String {
    const PAIRS: [(&str, &str); 2] = [
        ("<script", "</script>"),
        ("<iframe", "</iframe>"),
    ];
    let mut current = text.to_string();
    for (open_tag, close_tag) in PAIRS {
        while let Some(start) = find_case_insensitive(&current, open_tag) {
            let Some(rel_end) = find_case_insensitive(&current[start..], close_tag) else {
                // Unterminated block: strip to the end of the document.
                current.truncate(start);
                break;
            };
            let end = start + rel_end + close_tag.len();
            current.replace_range(start..end, "");
        }
    }
    current
}

/// Case-insensitive substring search over UTF-8 (ASCII pattern).
fn find_case_insensitive(haystack: &str, needle: &str) -> Option<usize> {
    let lower = haystack.to_lowercase();
    lower.find(&needle.to_lowercase())
}

/// True when a URL target starts with a scheme we refuse to keep.
fn is_dangerous_target(target: &str) -> bool {
    let trimmed = target.trim().to_lowercase();
    ["javascript:", "vbscript:", "data:"]
        .iter()
        .any(|scheme| trimmed.starts_with(scheme))
}

/// Rewrite `[text](target)` links whose target carries a dangerous scheme —
/// the target collapses to `#`. Targets are collected with paren balancing so
/// payloads like `(javascript:alert(1))` are consumed in full.
fn sanitize_link_targets(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let bytes = text.as_bytes();
    let mut search_from = 0usize;
    loop {
        let Some(rel) = text[search_from..].find("](") else {
            output.push_str(&text[search_from..]);
            break;
        };
        let open_paren = search_from + rel + 1;
        output.push_str(&text[search_from..=open_paren]);

        // Collect the balanced target region.
        let mut pos = open_paren + 1;
        let mut depth = 0i32;
        let mut closed = false;
        while pos < bytes.len() {
            match bytes[pos] {
                b'(' => depth += 1,
                b')' => {
                    if depth == 0 {
                        closed = true;
                        pos += 1;
                        break;
                    }
                    depth -= 1;
                }
                _ => {}
            }
            pos += 1;
        }
        let end_target = if closed { pos - 1 } else { pos };
        let raw_target = &text[open_paren + 1..end_target];
        if is_dangerous_target(raw_target.trim()) {
            output.push('#');
        } else {
            output.push_str(raw_target);
        }
        if closed {
            output.push(')');
        }
        search_from = pos;
    }
    output
}

// ---------------------------------------------------------------------------
// Snapshot policy (Phase B)
// ---------------------------------------------------------------------------

/// Hash every adjacent character pair into a set of u64 fingerprints.
fn bigram_hashes(text: &str) -> HashSet<u64> {
    use std::hash::{Hash, Hasher};
    let chars: Vec<char> = text.chars().collect();
    let mut set = HashSet::with_capacity(chars.len());
    for pair in chars.windows(2) {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        pair[0].hash(&mut hasher);
        pair[1].hash(&mut hasher);
        set.insert(hasher.finish());
    }
    set
}

/// Symmetric-difference over union of the two bigram sets — an O(n)
/// stand-in for difflib's ratio (backend uses difflib; at desktop note sizes
/// a quadratic edit distance would dominate save latency). Identical texts
/// score 0; disjoint non-empty texts approach 1.
pub(crate) fn diff_ratio(old_text: &str, new_text: &str) -> f64 {
    let old_set = bigram_hashes(old_text);
    let new_set = bigram_hashes(new_text);
    if old_set.is_empty() && new_set.is_empty() {
        return 0.0;
    }
    let union = old_set.union(&new_set).count();
    if union == 0 {
        return 0.0;
    }
    let symmetric_difference = old_set.symmetric_difference(&new_set).count();
    symmetric_difference as f64 / union as f64
}

/// Decide whether this save earns a snapshot, then insert one for the OLD
/// content. Policy mirrors the backend: at least [`SNAPSHOT_MIN_INTERVAL_SECS`]
/// since the last snapshot AND at least [`SNAPSHOT_DIFF_THRESHOLD`]
/// difference. The very first non-empty version always snapshots so every
/// note has a base revision.
fn maybe_snapshot_conn(
    conn: &Connection,
    note_id: &str,
    old_content: &str,
    new_content: &str,
    now: i64,
) -> Result<(), String> {
    if old_content.trim().is_empty() || old_content == new_content {
        return Ok(());
    }

    let last_created: Option<i64> = conn
        .query_row(
            "SELECT created_at FROM note_revisions WHERE note_id = ?1
             ORDER BY created_at DESC LIMIT 1",
            params![note_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| format!("failed to read revisions: {err}"))?;

    let elapsed_ok = match last_created {
        Some(last) => now - last >= SNAPSHOT_MIN_INTERVAL_SECS,
        None => true, // no baseline yet — first meaningful save snapshots
    };
    let changed_ok = diff_ratio(old_content, new_content) >= SNAPSHOT_DIFF_THRESHOLD;
    if !elapsed_ok || !changed_ok {
        return Ok(());
    }

    insert_revision_conn(conn, note_id, old_content, now)?;
    prune_revisions_conn(conn, note_id)?;
    Ok(())
}

fn insert_revision_conn(
    conn: &Connection,
    note_id: &str,
    content: &str,
    now: i64,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO note_revisions(id, note_id, content, char_count, created_at)
         VALUES(?1, ?2, ?3, ?4, ?5)",
        params![db::local_id(), note_id, content, content.chars().count() as i64, now],
    )
    .map_err(|err| format!("failed to insert revision: {err}"))?;
    Ok(())
}

/// Keep only the newest [`MAX_REVISIONS_PER_NOTE`] revisions of one note.
fn prune_revisions_conn(conn: &Connection, note_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM note_revisions WHERE note_id = ?1 AND id NOT IN (
             SELECT id FROM note_revisions WHERE note_id = ?1
             ORDER BY created_at DESC, rowid DESC LIMIT ?2
         )",
        params![note_id, MAX_REVISIONS_PER_NOTE],
    )
    .map_err(|err| format!("failed to prune revisions: {err}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Anchors (Phase D helpers)
// ---------------------------------------------------------------------------

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
fn anchor_url(bvid: &str, page_index: i64, seconds: i64) -> String {
    let mut url = format!(
        "https://www.bilibili.com/video/{bvid}?p={page_index}"
    );
    if seconds > 0 {
        url.push_str(&format!("&t={seconds}"));
    }
    url
}

fn fetch_anchors_conn(conn: &Connection, note_id: &str) -> Result<Vec<AnchorRow>, String> {
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
// Internal store operations (&Connection scoped, testable)
// ---------------------------------------------------------------------------

pub(crate) fn get_detail_conn(conn: &Connection, id: &str) -> Result<Option<NoteDetail>, String> {
    let note = conn
        .query_row(
            "SELECT id, title, content, pinned, created_at, updated_at
             FROM notes WHERE id = ?1",
            params![id],
            |row| {
                Ok(NoteDetail {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    content: row.get(2)?,
                    pinned: row.get::<_, i64>(3)? != 0,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                    anchors: Vec::new(),
                })
            },
        )
        .optional()
        .map_err(|err| format!("failed to read note: {err}"))?;
    match note {
        Some(mut detail) => {
            detail.anchors = fetch_anchors_conn(conn, id)?;
            Ok(Some(detail))
        }
        None => Ok(None),
    }
}

fn insert_note_conn(conn: &Connection, id: &str, title: &str) -> Result<(), String> {
    let now = now_secs();
    conn.execute(
        "INSERT INTO notes(id, title, content, pinned, created_at, updated_at)
         VALUES(?1, ?2, '', 0, ?3, ?3)",
        params![id, title, now],
    )
    .map_err(|err| format!("failed to create note: {err}"))?;
    Ok(())
}

fn delete_note_conn(conn: &Connection, id: &str) -> Result<(), String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|err| format!("failed to begin transaction: {err}"))?;
    tx.execute("DELETE FROM note_anchors WHERE note_id = ?1", params![id])
        .map_err(|err| format!("failed to delete anchors: {err}"))?;
    tx.execute("DELETE FROM note_revisions WHERE note_id = ?1", params![id])
        .map_err(|err| format!("failed to delete revisions: {err}"))?;
    tx.execute("DELETE FROM notes WHERE id = ?1", params![id])
        .map_err(|err| format!("failed to delete note: {err}"))?;
    tx.commit()
        .map_err(|err| format!("failed to commit delete: {err}"))
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// List rows with optional LIKE filtering — shared by the command and the
/// note agent's list_notes tool.
pub(crate) fn notes_list_internal(
    conn: &Connection,
    query: Option<String>,
) -> Result<Vec<NoteListRow>, String> {
    let filter = query
        .map(|q| q.trim().to_string())
        .filter(|q| !q.is_empty());

    let sql = match filter.is_some() {
        true => (
            "SELECT id, title, pinned, updated_at, length(content), content
             FROM notes
             WHERE title LIKE ?1 OR content LIKE ?1
             ORDER BY pinned DESC, updated_at DESC LIMIT ?2",
            2,
        ),
        false => (
            "SELECT id, title, pinned, updated_at, length(content), content
             FROM notes ORDER BY pinned DESC, updated_at DESC LIMIT ?1",
            1,
        ),
    };

    let mut statement = conn
        .prepare(sql.0)
        .map_err(|err| format!("failed to list notes: {err}"))?;

    let map_row = |row: &rusqlite::Row<'_>| -> rusqlite::Result<NoteListRow> {
        let content: String = row.get(5)?;
        let snippet: String = content
            .chars()
            .take(SNIPPET_CHARS)
            .flat_map(|c| {
                if c == '\n' || c == '\r' {
                    vec![' ']
                } else {
                    vec![c]
                }
            })
            .collect();
        Ok(NoteListRow {
            id: row.get(0)?,
            title: row.get(1)?,
            pinned: row.get::<_, i64>(2)? != 0,
            updated_at: row.get(3)?,
            char_count: row.get(4)?,
            snippet: snippet.trim().to_string(),
        })
    };

    let rows = if let Some(term) = &filter {
        let pattern = format!("%{}%", term.replace(['%', '_'], ""));
        statement
            .query_map(rusqlite::params![pattern, LIST_LIMIT], map_row)
            .map_err(|err| format!("failed to query notes: {err}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| format!("failed to read notes: {err}"))?
    } else {
        statement
            .query_map(rusqlite::params![LIST_LIMIT], map_row)
            .map_err(|err| format!("failed to query notes: {err}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| format!("failed to read notes: {err}"))?
    };
    Ok(rows)
}

#[tauri::command]
pub fn notes_list(db: State<'_, Db>, query: Option<String>) -> Result<Vec<NoteListRow>, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    notes_list_internal(&conn, query)
}

/// Create an empty note; returns its local id.
pub(crate) fn note_create_internal(conn: &Connection, title: &str) -> Result<String, String> {
    let id = db::local_id();
    insert_note_conn(conn, &id, title)?;
    Ok(id)
}

/// Current `updated_at` of one note — the concurrency baseline for saves.
pub(crate) fn note_updated_at(conn: &Connection, id: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT updated_at FROM notes WHERE id = ?1",
        params![id],
        |row| row.get(0),
    )
    .optional()
    .map_err(|err| format!("failed to read note: {err}"))?
    .ok_or_else(|| "笔记不存在".to_string())
}

/// Rename without touching content (used by the note agent's update tool).
pub(crate) fn rename_note_internal(
    conn: &Connection,
    id: &str,
    title: &str,
    now: i64,
) -> Result<(), String> {
    conn.execute(
        "UPDATE notes SET title = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, title, now],
    )
    .map_err(|err| format!("failed to rename note: {err}"))?;
    Ok(())
}

#[tauri::command]
pub fn note_create(db: State<'_, Db>, title: Option<String>) -> Result<NoteDetail, String> {
    let title = title
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "未命名笔记".to_string());
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    let id = note_create_internal(&conn, &title)?;
    get_detail_conn(&conn, &id)?.ok_or_else(|| "笔记创建失败".to_string())
}

#[tauri::command]
pub fn note_get(db: State<'_, Db>, id: String) -> Result<NoteDetail, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    get_detail_conn(&conn, &id)?.ok_or_else(|| "笔记不存在".to_string())
}

/// Shared save path: sanitize → concurrency check → snapshot policy → write.
/// `now` is injected so tests can drive the snapshot clock.
pub(crate) fn note_update_internal(
    conn: &Connection,
    id: &str,
    content: &str,
    expected_updated_at: i64,
    now: i64,
) -> Result<UpdateResult, String> {
    let sanitized = sanitize_markdown(content);
    let tx = conn
        .unchecked_transaction()
        .map_err(|err| format!("failed to begin transaction: {err}"))?;

    let (current_content, current_updated): (String, i64) = tx
        .query_row(
            "SELECT content, updated_at FROM notes WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|err| format!("failed to read note: {err}"))?
        .ok_or_else(|| "笔记不存在".to_string())?;

    if expected_updated_at != current_updated {
        return Err("该笔记已在别处被修改，请重新打开后再保存".to_string());
    }

    maybe_snapshot_conn(&tx, id, &current_content, &sanitized, now)?;
    tx.execute(
        "UPDATE notes SET content = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, sanitized, now],
    )
    .map_err(|err| format!("failed to update note: {err}"))?;
    tx.commit()
        .map_err(|err| format!("failed to commit update: {err}"))?;

    Ok(UpdateResult {
        updated_at: now,
        char_count: sanitized.chars().count() as i64,
    })
}

/// Save the body. `expected_updated_at` implements optimistic concurrency —
/// a mismatch means another window changed the note meanwhile.
#[tauri::command]
pub fn note_update(
    db: State<'_, Db>,
    id: String,
    content: String,
    expected_updated_at: i64,
) -> Result<UpdateResult, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    note_update_internal(&conn, &id, &content, expected_updated_at, now_secs())
}

/// Atomic UI save: title + body under ONE concurrency check.
///
/// The editor autosaves both fields on every debounce tick; doing that as
/// separate commands would let the first write bump `updated_at` and leave
/// the second one's baseline stale (rejected as a conflict on every save),
/// so both writes share one transaction, one guard and one timestamp.
pub(crate) fn note_save_internal(
    conn: &Connection,
    id: &str,
    title: &str,
    content: &str,
    expected_updated_at: i64,
    now: i64,
) -> Result<UpdateResult, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("标题不能为空".to_string());
    }
    let sanitized = sanitize_markdown(content);
    let tx = conn
        .unchecked_transaction()
        .map_err(|err| format!("failed to begin transaction: {err}"))?;

    let (current_content, current_updated): (String, i64) = tx
        .query_row(
            "SELECT content, updated_at FROM notes WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|err| format!("failed to read note: {err}"))?
        .ok_or_else(|| "笔记不存在".to_string())?;

    if expected_updated_at != current_updated {
        return Err("该笔记已在别处被修改，请重新打开后再保存".to_string());
    }

    maybe_snapshot_conn(&tx, id, &current_content, &sanitized, now)?;
    tx.execute(
        "UPDATE notes SET title = ?2, content = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, title, sanitized, now],
    )
    .map_err(|err| format!("failed to update note: {err}"))?;
    tx.commit()
        .map_err(|err| format!("failed to commit update: {err}"))?;

    Ok(UpdateResult {
        updated_at: now,
        char_count: sanitized.chars().count() as i64,
    })
}

/// Save title and body in one guarded write (used by the editor autosave).
#[tauri::command]
pub fn note_save(
    db: State<'_, Db>,
    id: String,
    title: String,
    content: String,
    expected_updated_at: i64,
) -> Result<UpdateResult, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    note_save_internal(&conn, &id, &title, &content, expected_updated_at, now_secs())
}

#[tauri::command]
pub fn note_rename(db: State<'_, Db>, id: String, title: String) -> Result<(), String> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("标题不能为空".to_string());
    }
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    let updated = conn
        .execute(
            "UPDATE notes SET title = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, title, now_secs()],
        )
        .map_err(|err| format!("failed to rename note: {err}"))?;
    if updated == 0 {
        return Err("笔记不存在".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn note_delete(db: State<'_, Db>, id: String) -> Result<(), String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    delete_note_conn(&conn, &id)
}

#[tauri::command]
pub fn note_toggle_pin(db: State<'_, Db>, id: String) -> Result<PinResult, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    // The bump floats the row within its group via updated_at, but it also
    // invalidates editors' concurrency baselines — return the new value so
    // open editors can adopt it instead of failing their next save.
    let now = now_secs();
    conn.execute(
        "UPDATE notes SET pinned = 1 - pinned, updated_at = ?2 WHERE id = ?1",
        params![id, now],
    )
    .map_err(|err| format!("failed to toggle pin: {err}"))?;
    let pinned: i64 = conn
        .query_row("SELECT pinned FROM notes WHERE id = ?1", params![id], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|err| format!("failed to read pin state: {err}"))?
        .ok_or_else(|| "笔记不存在".to_string())?;
    Ok(PinResult {
        pinned: pinned != 0,
        updated_at: now,
    })
}

#[tauri::command]
pub fn revisions_list(db: State<'_, Db>, note_id: String) -> Result<Vec<RevisionMeta>, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    let mut statement = conn
        .prepare(
            "SELECT id, note_id, char_count, created_at
             FROM note_revisions WHERE note_id = ?1 ORDER BY created_at DESC",
        )
        .map_err(|err| format!("failed to list revisions: {err}"))?;
    let rows = statement
        .query_map(params![note_id], |row| {
            Ok(RevisionMeta {
                id: row.get(0)?,
                note_id: row.get(1)?,
                char_count: row.get(2)?,
                created_at: row.get(3)?,
            })
        })
        .map_err(|err| format!("failed to query revisions: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("failed to read revisions: {err}"))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionContent {
    pub id: String,
    pub content: String,
    pub created_at: i64,
}

#[tauri::command]
pub fn revision_get(db: State<'_, Db>, revision_id: String) -> Result<RevisionContent, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    conn.query_row(
        "SELECT id, content, created_at FROM note_revisions WHERE id = ?1",
        params![revision_id],
        |row| {
            Ok(RevisionContent {
                id: row.get(0)?,
                content: row.get(1)?,
                created_at: row.get(2)?,
            })
        },
    )
    .optional()
    .map_err(|err| format!("failed to read revision: {err}"))?
    .ok_or_else(|| "修订不存在".to_string())
}

/// Roll a note back to a stored revision. The CURRENT content snapshots
/// unconditionally first (regardless of time/diff policy) so "undo my undo"
/// is always possible.
#[tauri::command]
pub fn revision_restore(db: State<'_, Db>, revision_id: String) -> Result<i64, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    let tx = conn
        .unchecked_transaction()
        .map_err(|err| format!("failed to begin transaction: {err}"))?;

    let (note_id, restored_content): (String, String) = tx
        .query_row(
            "SELECT note_id, content FROM note_revisions WHERE id = ?1",
            params![revision_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|err| format!("failed to read revision: {err}"))?
        .ok_or_else(|| "修订不存在".to_string())?;

    let current: String = tx
        .query_row(
            "SELECT content FROM notes WHERE id = ?1",
            params![note_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| format!("failed to read note: {err}"))?
        .ok_or_else(|| "笔记不存在".to_string())?;

    if current != restored_content && !current.trim().is_empty() {
        insert_revision_conn(&tx, &note_id, &current, now_secs())?;
        prune_revisions_conn(&tx, &note_id)?;
    }

    let now = now_secs();
    tx.execute(
        "UPDATE notes SET content = ?2, updated_at = ?3 WHERE id = ?1",
        params![note_id, restored_content, now],
    )
    .map_err(|err| format!("failed to restore revision: {err}"))?;
    tx.commit()
        .map_err(|err| format!("failed to commit restore: {err}"))?;
    Ok(now)
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
        let agent = crate::bilibili::build_agent()?;
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

use crate::bilibili::content as bili_content;

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory db");
        conn.execute_batch(crate::db::SCHEMA_SQL).expect("schema");
        conn
    }

    fn seed_note(conn: &Connection, id: &str, content: &str) {
        insert_note_conn(conn, id, "测试笔记").expect("seed");
        conn.execute(
            "UPDATE notes SET content = ?2 WHERE id = ?1",
            params![id, content],
        )
        .expect("seed content");
    }

    // -- sanitizer ----------------------------------------------------------

    #[test]
    fn dangerous_schemes_collapse_to_hash() {
        assert_eq!(
            sanitize_markdown("[点我](javascript:alert(1))"),
            "[点我](#)"
        );
        assert_eq!(sanitize_markdown("[x](data:text/html;base64,xxx)"), "[x](#)");
        assert_eq!(sanitize_markdown("[x](vbscript:x)"), "[x](#)");
        // Safe targets survive untouched, case preserved.
        assert_eq!(
            sanitize_markdown("[b站](https://www.bilibili.com/video/BVxx)"),
            "[b站](https://www.bilibili.com/video/BVxx)"
        );
    }

    #[test]
    fn script_and_iframe_blocks_are_removed_case_insensitive() {
        let payload = "<SCRIPT>alert(1)</script>正文继续";
        assert_eq!(sanitize_markdown(payload), "正文继续");
        let unterminated = "开头<iframe src=\"x\" 永远不结束";
        assert_eq!(sanitize_markdown(unterminated), "开头");
    }

    #[test]
    fn benign_markdown_passes_through_unchanged() {
        let md = "# 标题\n\n- 列表项\n- **加粗** 与 `代码`\n";
        assert_eq!(sanitize_markdown(md), md);
    }

    // -- atomic save ----------------------------------------------------------

    #[test]
    fn note_save_writes_title_content_and_new_baseline() {
        let conn = memory_db();
        seed_note(&conn, "n1", "旧内容");
        let baseline: i64 = conn
            .query_row("SELECT updated_at FROM notes WHERE id='n1'", [], |r| r.get(0))
            .unwrap();

        let result =
            note_save_internal(&conn, "n1", "新标题", "新内容", baseline, baseline + 5).unwrap();

        assert_eq!(result.updated_at, baseline + 5);
        let (title, content): (String, String) = conn
            .query_row("SELECT title, content FROM notes WHERE id='n1'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(title, "新标题");
        assert_eq!(content, "新内容");

        // Stale baseline → rejected like the single-field writers.
        assert!(note_save_internal(&conn, "n1", "再改", "再写", baseline, baseline + 6).is_err());
        // Empty title → rejected before any write lands.
        assert!(
            note_save_internal(&conn, "n1", "   ", "内容", result.updated_at, baseline + 7)
                .is_err()
        );
    }

    // -- snapshot policy ------------------------------------------------------

    #[test]
    fn diff_ratio_scores_identical_and_disjoint() {
        assert_eq!(diff_ratio("完全相同", "完全相同"), 0.0);
        let ratio = diff_ratio("aaaaaa", "bbbbbb");
        assert!(ratio > 0.9, "disjoint texts should differ strongly: {ratio}");
        // Empty vs non-empty is maximal change.
        assert!(diff_ratio("", "内容") > 0.9);
        assert_eq!(diff_ratio("", ""), 0.0);
    }

    #[test]
    fn snapshot_policy_respects_time_and_change_gates() {
        let conn = memory_db();
        seed_note(&conn, "n1", "第一版内容，足够长以产生差异。");
        let big_new = "完全不同的第二版内容。".repeat(10);

        // Same instant, tiny change → below threshold → no snapshot.
        maybe_snapshot_conn(&conn, "n1", "第一版内容，足够长以产生差异。", "第一版内容，足够长以产生差异！", 100).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM note_revisions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);

        // Big rewrite with no prior revision → baseline snapshot lands even
        // at the same instant (every note needs a base version).
        maybe_snapshot_conn(&conn, "n1", "第一版内容，足够长以产生差异。", &big_new, 100).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM note_revisions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1, "baseline snapshots immediately");

        // Another big rewrite within the interval → gated by time.
        maybe_snapshot_conn(&conn, "n1", &big_new, "第三版，同样大幅重写的内容。", 100).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM note_revisions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1, "time gate holds after baseline");

        // After the interval AND a real change → second snapshot lands.
        maybe_snapshot_conn(&conn, "n1", &big_new, "第三版，同样大幅重写的内容。", 100 + 601).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM note_revisions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2);

        // Empty old content never snapshots.
        seed_note(&conn, "n2", "");
        maybe_snapshot_conn(&conn, "n2", "", "全新内容", 999).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM note_revisions WHERE note_id='n2'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn pruning_keeps_only_the_newest_window() {
        let conn = memory_db();
        seed_note(&conn, "n1", "基线");
        for step in 0..30_i64 {
            let now = 1_000_000 + step * 700; // spaced beyond the interval
            let new_content = format!("第 {step} 次大改写，内容完全不同一些。{step}");
            maybe_snapshot_conn(&conn, "n1", "基线", &new_content, now).unwrap();
            conn.execute(
                "UPDATE notes SET content = ? WHERE id = 'n1'",
                rusqlite::params![new_content],
            )
            .unwrap();
        }
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM note_revisions WHERE note_id='n1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, MAX_REVISIONS_PER_NOTE);
    }

    #[test]
    fn restore_snapshots_current_then_swaps() {
        let conn = memory_db();
        seed_note(&conn, "n1", "当前内容");
        insert_revision_conn(&conn, "n1", "历史版本内容", 500).unwrap();

        let now = restore_via_internal(&conn, "n1", "历史版本内容", 900);

        let content: String = conn
            .query_row("SELECT content FROM notes WHERE id='n1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(content, "历史版本内容");
        assert!(now > 0);
        // The pre-restore content was preserved as a fresh revision.
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM note_revisions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2);
    }

    /// Mirror of revision_restore's internals without the Tauri wrapper.
    fn restore_via_internal(conn: &Connection, _rev_note: &str, restored: &str, now: i64) -> i64 {
        let current: String = conn
            .query_row("SELECT content FROM notes WHERE id='n1'", [], |r| r.get(0))
            .unwrap();
        if current != restored && !current.trim().is_empty() {
            insert_revision_conn(conn, "n1", &current, now).unwrap();
        }
        conn.execute(
            "UPDATE notes SET content = ?, updated_at = ? WHERE id = 'n1'",
            rusqlite::params![restored, now],
        )
        .unwrap();
        now
    }

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

    #[test]
    fn anchors_roundtrip_through_the_store() {
        let conn = memory_db();
        insert_note_conn(&conn, "n1", "带锚点的笔记").unwrap();
        conn.execute(
            "INSERT INTO note_anchors(id, note_id, bvid, page_index, seconds, label, created_at)
             VALUES('a1', 'n1', 'BV1AbCdEfGhI', 2, 95, '标题', 1)",
            [],
        )
        .unwrap();

        let detail = get_detail_conn(&conn, "n1").unwrap().unwrap();
        assert_eq!(detail.anchors.len(), 1);
        assert_eq!(detail.anchors[0].url, anchor_url("BV1AbCdEfGhI", 2, 95));

        // Deleting the note cascades.
        delete_note_conn(&conn, "n1").unwrap();
        let anchors: i64 = conn
            .query_row("SELECT COUNT(*) FROM note_anchors", [], |r| r.get(0))
            .unwrap();
        assert_eq!(anchors, 0);
    }

    #[test]
    fn local_ids_are_unique_across_calls() {
        let first = db::local_id();
        let second = db::local_id();
        assert_ne!(first, second);
        assert_eq!(first.len(), 32);
    }
}
