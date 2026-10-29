//! Webview DTOs returned by the note commands.

use serde::Serialize;

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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionContent {
    pub id: String,
    pub content: String,
    pub created_at: i64,
}
