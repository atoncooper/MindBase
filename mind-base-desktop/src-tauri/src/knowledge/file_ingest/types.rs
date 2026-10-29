//! 导入进度事件与跨子模块共享的数据载体。

use serde::Serialize;

// ---------------------------------------------------------------------------
// Progress events
// ---------------------------------------------------------------------------

/// One progress update pushed to the frontend during file ingestion.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum FileIngestEvent {
    Start { total: usize },
    FileStart { index: i64, file_name: String },
    /// `step`: parse | chunk | embed | store.
    FileStep { index: i64, step: String },
    FileDone {
        index: i64,
        doc_id: String,
        chunks: usize,
        chars: usize,
    },
    FileFailed { index: i64, error: String },
    /// File skipped by the content-hash dedup (already ingested, unchanged
    /// content or a byte-identical copy under another name/path).
    FileSkipped { index: i64, doc_id: String, reason: String },
    Done {
        ok: usize,
        failed: usize,
        skipped: usize,
    },
}

/// Text facts extracted from one file by `doc_extract.py`.
pub(super) struct Extracted {
    pub(super) title: String,
    pub(super) text: String,
}

/// Outcome summary of one file-ingestion run.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileIngestSummary {
    pub ok: usize,
    pub failed: usize,
    /// Files skipped by the content-hash dedup.
    pub skipped: usize,
}
