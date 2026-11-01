//! Research projects — Phase 0 vertical slice.
//!
//! Journal-first academic workspace. A project owns a fixed lifecycle
//! (topic → design → advise → experiment → writing → submission), artifacts,
//! evidence rows (literature / datasets / runs) and an append-only event log.
//!
//! Module layout:
//! - [`types`] — webview DTOs.
//! - [`service`] — business layer (stage invariants, project lifecycle); all
//!   SQL lives in `crate::repositories::research`.
//! - [`briefing`] — assistant briefing and stage prompt selection.
//! - [`ai`] — AI 期刊推荐与研究计划生成（LLM 编排；解析/持久化在 service）。
//! - [`commands`] — thin Tauri command wrappers over service.

mod ai;
mod briefing;
mod commands;
mod files;
// 论文/文件导入命令待 Lead 在 app/commands.rs 注册；注册后可移除 allow。
#[allow(dead_code)]
mod import;
mod service;
mod types;

pub(crate) use ai::generate_plan as generate_ai_plan;
pub(crate) use briefing::project_briefing;
pub(crate) use commands::*;
pub(crate) use files::*;
/// 文件字节命令宏待 Lead 注册。
#[allow(unused_imports)]
pub(crate) use files::{__cmd__research_file_bytes, __tauri_command_name_research_file_bytes};
#[allow(unused_imports)]
pub(crate) use import::{research_file_import, research_import_paper};
/// 命令宏由 Lead 在 app/commands.rs 注册；注册前 crate 内暂无引用。
#[allow(unused_imports)]
pub(crate) use import::{
    __cmd__research_file_import, __cmd__research_import_paper,
    __tauri_command_name_research_file_import, __tauri_command_name_research_import_paper,
};
pub(crate) use service::{
    list_projects, plan_get, plan_task_set, save_advice, update_stage,
};
pub(crate) use types::{
    ChatTurnInput, PlanTask, ProjectCreateInput, ProjectDetail, ProjectUpdateInput, ResearchAdvice,
    ResearchArtifact, ResearchEvent, ResearchEventPage, ResearchOverviewStats, ResearchPlan,
    ResearchProject, ResearchStage, VenueSuggestion,
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
