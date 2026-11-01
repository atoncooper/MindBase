//! Webview DTOs for research projects and the research assistant.

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchProject {
    pub id: String,
    pub title: String,
    pub paper_kind: String,
    pub field: String,
    pub language: String,
    pub target_venue: String,
    pub current_stage: String,
    pub privacy: String,
    pub deadline: String,
    pub meta_json: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchStage {
    pub stage: String,
    pub label: String,
    pub status: String,
    pub entered_at: Option<i64>,
    pub approved_at: Option<i64>,
    pub gate_json: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchArtifact {
    pub id: String,
    pub stage: String,
    pub kind: String,
    pub title: String,
    pub path: String,
    pub version: i64,
    pub status: String,
    pub created_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDetail {
    pub project: ResearchProject,
    pub stages: Vec<ResearchStage>,
    pub artifacts: Vec<ResearchArtifact>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchEvent {
    pub id: i64,
    /// 折叠组内最新一条的时间。
    pub ts: i64,
    /// 折叠组内最早一条的时间（未折叠时等于 ts）。
    pub first_ts: i64,
    pub actor: String,
    pub kind: String,
    pub payload_json: String,
    /// 连续相同事件（actor/type/payload 一致）折叠后的条数，>= 1。
    pub repeat: i64,
}

/// 事件流一页：游标分页用 id 倒序，has_more 由「多取一条」判定。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchEventPage {
    pub events: Vec<ResearchEvent>,
    pub has_more: bool,
}

/// 科研控制台「阶段资料」总览统计。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchOverviewStats {
    pub literature_total: i64,
    pub literature_verified: i64,
    pub datasets: i64,
    pub experiments: i64,
    pub artifacts: i64,
    pub manuscript_sections: i64,
    pub manuscript_words: i64,
    pub advice_count: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCreateInput {
    pub title: String,
    pub paper_kind: Option<String>,
    pub field: Option<String>,
    pub language: Option<String>,
    pub target_venue: Option<String>,
    pub privacy: Option<String>,
    pub deadline: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectUpdateInput {
    pub title: Option<String>,
    pub paper_kind: Option<String>,
    pub field: Option<String>,
    pub language: Option<String>,
    pub target_venue: Option<String>,
    pub privacy: Option<String>,
    pub deadline: Option<String>,
    pub meta_json: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTurnInput {
    pub role: String,
    pub content: String,
}

/// 控制台里展示的最新 AI 阶段建议（guidance_notes 最新一条）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchAdvice {
    pub question: String,
    pub notes: String,
    pub created_at: i64,
}

/// AI 目标期刊/会议推荐的一条候选。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VenueSuggestion {
    pub venue: String,
    pub reason: String,
    /// 匹配度 0-100（超出范围由后端夹取）。
    pub match_score: i64,
}

/// 研究计划里的一项可勾选任务（id 由后端生成 t1..tN）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlanTask {
    pub id: String,
    pub label: String,
}

/// AI 生成的研究计划（持久化在 research_projects.meta_json 的 plans.<stage>）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchPlan {
    pub stage: String,
    pub goal: String,
    pub tasks: Vec<PlanTask>,
    pub deliverables: Vec<String>,
    pub acceptance: Vec<String>,
    pub risks: Vec<String>,
    pub prompts: Vec<String>,
    pub generated_at: i64,
    /// 生成来源：目前固定 ai（预留 manual 等）。
    pub source: String,
}
