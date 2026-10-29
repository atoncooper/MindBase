//! Local markdown notes: CRUD with optimistic concurrency, revision
//! snapshots (backend policy: ≥30% change after ≥10 minutes), URL-scheme
//! sanitization, and video anchors.
//!
//! Storage is plain markdown so the content stays portable and greppable —
//! the same source the web app edits. Rendering happens client-side through
//! react-markdown (no raw HTML), and the sanitizer here is the second line
//! of defense for anything that might smuggle a dangerous link in.
//!
//! Module layout:
//! - [`types`] — webview DTOs.
//! - [`markdown`] — URL-scheme sanitizer.
//! - [`revisions`] — snapshot policy (time + diff gates) and pruning.
//! - [`anchors`] — Bilibili target parsing and anchor CRUD.
//! - [`store`] — note CRUD SQL shared by commands and agent tools.
//! - [`commands`] — Tauri commands and the guarded save paths they share.

mod anchors;
mod commands;
mod markdown;
mod revisions;
mod store;
mod types;

pub(crate) use anchors::*;
pub(crate) use commands::*;
pub(crate) use markdown::sanitize_markdown;
pub(crate) use store::{
    get_detail_conn, note_create_internal, note_updated_at, notes_list_internal,
    rename_note_internal,
};
pub(crate) use types::{
    AnchorRow, NoteDetail, NoteListRow, PinResult, RevisionContent, RevisionMeta, UpdateResult,
};

// In-package helper that used to sit in the flat module; kept reachable for
// callers that still use the pre-split path.
#[allow(unused_imports)]
pub(crate) use revisions::diff_ratio;

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|delta| delta.as_secs() as i64)
        .unwrap_or_default()
}
