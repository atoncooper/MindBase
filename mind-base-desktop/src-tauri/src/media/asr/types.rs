//! Shared ASR types: the stage-log callback, protocol mode and task state.

use std::sync::Arc;

/// Stage-log callback that reports granular ASR progress (ffmpeg transcode,
/// WebSocket connect, protocol probe, per-chunk, per-chunk errors) so the
/// ingest UI can render a detailed process. Thread-safe + cloneable so it can
/// move into the WebSocket runtime.
pub(crate) type StageLog = Arc<dyn Fn(&str) + Send + Sync + 'static>;

/// A no-op stage log for callers that don't surface ASR progress.
pub(crate) fn noop_stage() -> StageLog {
    Arc::new(|_| {})
}

/// Which transcription protocol to speak, derived from the Base URL.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AsrMode {
    DashScope,
    OpenAICompatible,
    /// A `ws://` / `wss://` streaming endpoint (e.g. DashScope `api-ws`).
    WebSocket,
}

/// Outcome of one task-status poll.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum TaskState {
    Pending,
    Running,
    Succeeded,
    Failed(String),
}

impl TaskState {
    pub(super) fn from_status(status: &str, error_message: Option<String>) -> TaskState {
        match status {
            "SUCCEEDED" => TaskState::Succeeded,
            "FAILED" => TaskState::Failed(error_message.unwrap_or_else(|| "未知错误".to_string())),
            "RUNNING" => TaskState::Running,
            // PENDING / unknown → keep waiting.
            _ => TaskState::Pending,
        }
    }
}
