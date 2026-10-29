//! Local ASR server lifecycle management.
//!
//! When the user selects the local ASR mode in API 设置, ingestion routes
//! ASR to a locally run, OpenAI-compatible whisper server, which
//! [`crate::media::asr`] already consumes - so **no transcription code changes are
//! needed**, only this process manager that provides the local base URL.
//!
//! The server itself is `scripts/whisper_server.py` (faster-whisper +
//! FastAPI) running under the app's self-contained embedded Python (provision
//! on first use): dependencies are pip-installed automatically and the
//! whisper model is downloaded from HuggingFace (hf-mirror when
//! huggingface.co is unreachable) into `<data_dir>/whisper-models`. Nothing
//! needs to be installed by hand and no cloud API key is required.
//!
//! Lifecycle rules (idempotent, safe to call at startup and on every
//! ingestion run):
//!
//! 1. A port already serving **our** server (the `/health` marker, see
//!    below) is reused - the app will not spawn a second one and will not
//!    shut it down on exit. A port serving anything else is a conflict and
//!    reported as an error (the old behavior of blindly reusing any HTTP
//!    listener silently misrouted ASR to an unrelated local service, e.g. a
//!    dev backend on the same port).
//! 2. Otherwise spawn `python whisper_server.py --host 127.0.0.1 --port <p>
//!    --model <m> --hf-home <data>/whisper-models` as a detached child, then
//!    poll `/health` until it responds (or the readiness timeout elapses).
//!    `/health` answers as soon as the HTTP listener is up; the whisper
//!    model keeps loading/downloading in the background and transcription
//!    requests wait for it (bounded) server-side.
//! 3. The spawned child handle is kept in a process-global registry and
//!    killed on app exit ([`shutdown`]) - the model download dir persists,
//!    so the next start needs no re-download.
//!
//! Only one instance of the desktop app is expected to run at a time, so a
//! process-wide registry (rather than threading state through `AsrClient`)
//! is the simplest correct home for the child handle.

mod commands;
mod download;
mod models;
mod process;

#[cfg(test)]
mod tests;

pub(crate) use self::commands::{
    __cmd__local_asr_model_download, __cmd__local_asr_model_status,
    __tauri_command_name_local_asr_model_download, __tauri_command_name_local_asr_model_status,
};
pub use self::commands::{local_asr_model_download, local_asr_model_status, startup_spawn};
pub(crate) use self::download::{download_agents, download_file};
pub(crate) use self::process::health_snapshot;
pub use self::process::{ensure_running, shutdown};
