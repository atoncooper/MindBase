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
    pub ts: i64,
    pub actor: String,
    pub kind: String,
    pub payload_json: String,
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
