//! MindBase desktop — Tauri application library.
//!
//! Package layout (each directory is one package with a `mod.rs` front door):
//!
//! | package | responsibility |
//! |---------|----------------|
//! | `app` | Tauri shell: builder, startup wiring, tray, IPC registration |
//! | `agent` | local AgentHarness, agent kinds, chat sessions, skills, tools |
//! | `knowledge` | Bilibili acquisition, ingestion, chunking, vector search |
//! | `media` | ASR (cloud + local whisper), OCR, ffmpeg, media cache |
//! | `sandbox` | OS-level sandboxed process execution (AppContainer / bubblewrap / seatbelt) |
//! | `toolkit` | agent-free command execution: process capture, shell, git, gh |
//! | `llm` | provider catalog, credentials, chat client, embeddings, rerank |
//! | `workspace` | notes, quiz, mind map, research, manuscript, literature, dataset |
//! | `infra` | SQLite, config, logging, embedded Python, updater |
//!
//! Cross-package calls only ever go "downhill": `app` → `workspace`/`agent` →
//! `knowledge`/`media` → `llm` → `infra`, so a package can be read — and later
//! extracted into its own crate — without pulling in the UI.

mod agent;
mod app;
mod infra;
mod knowledge;
mod llm;
mod media;
pub mod automation;
pub mod sandbox;
#[doc(hidden)]
pub mod testing;
pub mod toolkit;
mod workspace;

#[doc(hidden)]
pub use testing::TestHarness;

/// Entry point used by `main.rs` (and the mobile entry point).
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    app::run();
}
