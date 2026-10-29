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
mod workspace;

/// Entry point used by `main.rs` (and the mobile entry point).
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    app::run();
}
