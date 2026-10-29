//! ASR transcription — provider-agnostic, configurable via the "asr" slot's
//! Base URL / model in API settings.
//!
//! Three protocol families are supported, auto-detected from the Base URL:
//!
//! 1. **DashScope** (`host` contains `dashscope.aliyuncs.com`) — async
//!    **Transcription** (`paraformer-v2`) is the primary path for every
//!    duration (reliable, no ffmpeg needed): upload the real audio to the
//!    provider's temp OSS, submit a task, poll every 1.5s until
//!    SUCCEEDED/FAILED, then download the result JSON and join
//!    `transcripts[].text`. Only if that fails do we fall back to the
//!    real-time **Recognition** WebSocket (`paraformer-realtime-v2`, timed
//!    PCM chunks) — the backend's `_transcribe_local_via_transcription`
//!    primary with `_transcribe_local_chunked` as backup.
//! 2. **WebSocket** (`ws://` / `wss://`) — real-time streaming recognition
//!    (DashScope `api-ws`), including the same timed PCM chunking for long audio.
//! 3. **OpenAI-compatible** (anything else, e.g. OpenRouter
//!    `…/v1/audio/transcriptions`) — a single synchronous multipart
//!    `POST` carrying the audio bytes + `model`, returning `{"text": …}`.
//!
//! In DashScope mode `transcribe_url` lets the provider fetch a reachable
//! `https://` (CDN) or `oss://` link itself (async Transcription). In
//! OpenAI-compatible / WebSocket mode the client downloads the bytes and posts
//! or streams them (local files are read directly).

mod client;
mod config;
mod local;
mod parse;
mod realtime;
mod types;
mod upload;
mod wav;

#[cfg(test)]
mod tests;

pub(crate) use self::client::AsrClient;
pub(crate) use self::config::{
    detect_mode, resolve_api_key, resolve_base_url, resolve_default_base, resolve_model,
};
pub(crate) use self::types::{AsrMode, StageLog};
