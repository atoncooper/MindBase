//! Knowledge pipeline: acquisition → transcription → chunking → vectors.
//!
//! - [`bilibili`] — Bilibili login, favorites and per-分P content acquisition
//!   (including WBI signing).
//! - [`ingest`] — video ingestion orchestration and knowledge search.
//! - [`file_ingest`] — local document import (text extraction + OCR).
//! - [`web_capture`] — URL capture into the knowledge base.
//! - [`chunker`] — rule-based semantic chunker.
//! - [`vectors`] — SQLite vector store with FTS hybrid retrieval.

pub(crate) mod bilibili;
pub(crate) mod chunker;
pub(crate) mod file_ingest;
pub(crate) mod ingest;
pub(crate) mod vectors;
pub(crate) mod web_capture;
