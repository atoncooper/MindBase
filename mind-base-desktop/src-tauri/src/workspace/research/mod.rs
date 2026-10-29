//! Research projects — Phase 0 vertical slice.
//!
//! Journal-first academic workspace. A project owns a fixed lifecycle
//! (topic → design → advise → experiment → writing → submission), artifacts,
//! evidence rows (literature / datasets / runs) and an append-only event log.
//! Phase 0 ships the data layer + the project workspace; the research agent and
//! the evidence importers land in Phase 1.
//!
//! Module layout:
//! - [`types`] — webview DTOs.
//! - [`store`] — project/stage/artifact/event SQL.
//! - [`briefing`] — assistant briefing and stage prompt selection.
//! - [`commands`] — Tauri commands.

mod briefing;
mod commands;
mod store;
mod types;

pub(crate) use briefing::project_briefing;
pub(crate) use commands::*;
pub(crate) use types::{
    ChatTurnInput, ProjectCreateInput, ProjectDetail, ProjectUpdateInput, ResearchArtifact,
    ResearchEvent, ResearchProject, ResearchStage,
};

/// Canonical stage order. Kept in sync with the frontend RESEARCH_STAGES.
pub(crate) const STAGES: [&str; 6] = [
    "topic",
    "design",
    "advise",
    "experiment",
    "writing",
    "submission",
];

const STAGE_LABELS: [&str; 6] = ["选题", "研究设计", "指导", "实验", "写作", "投稿"];

const ALLOWED_STATUS: [&str; 6] = [
    "locked",
    "active",
    "submitted",
    "approved",
    "frozen",
    "rework",
];

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|delta| delta.as_secs() as i64)
        .unwrap_or_default()
}
