//! Local media runtimes and caches.
//!
//! - [`asr`] — speech-to-text (cloud DashScope + realtime WebSocket).
//! - [`whisper_server`] — managed local faster-whisper sidecar.
//! - [`ocr_server`] — managed local OCR sidecar.
//! - [`ffmpeg`] — ffmpeg/ffprobe sidecar resolution and helpers.
//! - [`media_cache`] — audio cache quota + eviction.

pub(crate) mod asr;
pub(crate) mod ffmpeg;
pub(crate) mod media_cache;
pub(crate) mod ocr_server;
pub(crate) mod whisper_server;
