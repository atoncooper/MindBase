//! Research projects — Phase 0 vertical slice.
//!
//! Journal-first academic workspace. A project owns a fixed lifecycle
//! (topic → design → advise → experiment → writing → submission), artifacts,
//! evidence rows (literature / datasets / runs) and an append-only event log.
//! Phase 0 ships the data layer + the project workspace; the research agent and
//! the evidence importers land in Phase 1.

use std::path::PathBuf;

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::{self, Db};

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

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

fn project_from_row(row: &Row<'_>) -> rusqlite::Result<ResearchProject> {
    Ok(ResearchProject {
        id: row.get(0)?,
        title: row.get(1)?,
        paper_kind: row.get(2)?,
        field: row.get(3)?,
        language: row.get(4)?,
        target_venue: row.get(5)?,
        current_stage: row.get(6)?,
        privacy: row.get(7)?,
        deadline: row.get(8)?,
        meta_json: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

const PROJECT_COLS: &str = "id, title, paper_kind, field, language, target_venue, \
                            current_stage, privacy, deadline, meta_json, created_at, updated_at";

fn get_project_conn(conn: &Connection, id: &str) -> Result<Option<ResearchProject>, String> {
    conn.query_row(
        &format!("SELECT {PROJECT_COLS} FROM research_projects WHERE id = ?1"),
        params![id],
        project_from_row,
    )
    .optional()
    .map_err(|err| format!("failed to load research project: {err}"))
}

fn list_projects_conn(conn: &Connection) -> Result<Vec<ResearchProject>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {PROJECT_COLS} FROM research_projects ORDER BY updated_at DESC"
        ))
        .map_err(|err| format!("failed to prepare project list: {err}"))?;
    let rows = stmt
        .query_map([], project_from_row)
        .map_err(|err| format!("failed to query projects: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("failed to read projects: {err}"))
}

fn list_stages_conn(conn: &Connection, project_id: &str) -> Result<Vec<ResearchStage>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT stage, status, entered_at, approved_at, gate_json \
             FROM research_stages WHERE project_id = ?1",
        )
        .map_err(|err| format!("failed to prepare stage list: {err}"))?;
    let mut rows = stmt
        .query_map(params![project_id], |row| {
            let stage: String = row.get(0)?;
            let label = STAGES
                .iter()
                .position(|candidate| candidate == &stage)
                .map(|index| STAGE_LABELS[index].to_string())
                .unwrap_or_else(|| stage.clone());
            Ok(ResearchStage {
                stage,
                label,
                status: row.get(1)?,
                entered_at: row.get(2)?,
                approved_at: row.get(3)?,
                gate_json: row.get(4)?,
            })
        })
        .map_err(|err| format!("failed to query stages: {err}"))?;

    let mut result: Vec<ResearchStage> = Vec::new();
    while let Some(row) = rows.next() {
        result.push(row.map_err(|err| format!("failed to read stages: {err}"))?);
    }
    result.sort_by_key(|stage| {
        STAGES
            .iter()
            .position(|candidate| candidate == &stage.stage)
            .unwrap_or(STAGES.len())
    });
    Ok(result)
}

fn list_artifacts_conn(
    conn: &Connection,
    project_id: &str,
) -> Result<Vec<ResearchArtifact>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, stage, kind, title, path, version, status, created_at \
             FROM project_artifacts WHERE project_id = ?1 ORDER BY created_at DESC",
        )
        .map_err(|err| format!("failed to prepare artifact list: {err}"))?;
    let rows = stmt
        .query_map(params![project_id], |row| {
            Ok(ResearchArtifact {
                id: row.get(0)?,
                stage: row.get(1)?,
                kind: row.get(2)?,
                title: row.get(3)?,
                path: row.get(4)?,
                version: row.get(5)?,
                status: row.get(6)?,
                created_at: row.get(7)?,
            })
        })
        .map_err(|err| format!("failed to query artifacts: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("failed to read artifacts: {err}"))
}

fn detail_conn(conn: &Connection, project_id: &str) -> Result<ProjectDetail, String> {
    let project = get_project_conn(conn, project_id)?
        .ok_or_else(|| format!("研究项目不存在：{project_id}"))?;
    Ok(ProjectDetail {
        stages: list_stages_conn(conn, project_id)?,
        artifacts: list_artifacts_conn(conn, project_id)?,
        project,
    })
}

fn record_event_conn(
    conn: &Connection,
    project_id: &str,
    actor: &str,
    kind: &str,
    payload_json: &str,
) {
    // The event stream is audit-only: a failed append must never fail the
    // business write that preceded it.
    let _ = conn.execute(
        "INSERT INTO project_events(project_id, ts, actor, type, payload_json) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![project_id, now_secs(), actor, kind, payload_json],
    );
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn research_projects_list(db: State<'_, Db>) -> Result<Vec<ResearchProject>, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    list_projects_conn(&conn)
}

#[tauri::command]
pub fn research_project_create(
    db: State<'_, Db>,
    input: ProjectCreateInput,
) -> Result<ProjectDetail, String> {
    let title = input.title.trim();
    if title.is_empty() {
        return Err("项目名称不能为空".to_string());
    }
    let id = db::local_id();
    let now = now_secs();
    let paper_kind = input
        .paper_kind
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("journal")
        .to_string();
    let language = input
        .language
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("zh")
        .to_string();
    let privacy = input
        .privacy
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("local")
        .to_string();

    {
        let conn = db
            .conn
            .lock()
            .map_err(|err| format!("failed to acquire database lock: {err}"))?;
        conn.execute(
            "INSERT INTO research_projects(
                 id, title, paper_kind, field, language, target_venue, current_stage,
                 privacy, deadline, meta_json, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'topic', ?7, ?8, '{}', ?9, ?9)",
            params![
                id,
                title,
                paper_kind,
                input.field.as_deref().unwrap_or(""),
                language,
                input.target_venue.as_deref().unwrap_or(""),
                privacy,
                input.deadline.as_deref().unwrap_or(""),
                now,
            ],
        )
        .map_err(|err| format!("failed to insert research project: {err}"))?;

        for (index, stage) in STAGES.iter().enumerate() {
            let status = if index == 0 { "active" } else { "locked" };
            let entered_at = if index == 0 { Some(now) } else { None };
            conn.execute(
                "INSERT INTO research_stages(project_id, stage, status, entered_at, approved_at, gate_json) \
                 VALUES (?1, ?2, ?3, ?4, NULL, '[]')",
                params![id, stage, status, entered_at],
            )
            .map_err(|err| format!("failed to insert research stage: {err}"))?;
        }

        record_event_conn(&conn, &id, "user", "project.created", "{}");
    }

    // Project directory is a convenience: a failure here (e.g. read-only disk)
    // must not lose the database row.
    if let Ok(data_dir) = db.data_dir.lock() {
        let root = PathBuf::from(&*data_dir).join("research").join(&id);
        for sub in [
            "literature/pdf",
            "literature/inbox",
            "data/original",
            "data/derived",
            "analysis/scripts",
            "analysis/outputs",
            "analysis/figures",
            "experiments/runs",
            "manuscript/sections",
            "exports",
            "memory",
        ] {
            let _ = std::fs::create_dir_all(root.join(sub));
        }
    }

    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    detail_conn(&conn, &id)
}

#[tauri::command]
pub fn research_project_get(db: State<'_, Db>, project_id: String) -> Result<ProjectDetail, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    detail_conn(&conn, &project_id)
}

#[tauri::command]
pub fn research_project_update(
    db: State<'_, Db>,
    project_id: String,
    input: ProjectUpdateInput,
) -> Result<ResearchProject, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    let current = get_project_conn(&conn, &project_id)?
        .ok_or_else(|| format!("研究项目不存在：{project_id}"))?;
    let title = input
        .title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or(current.title);
    let paper_kind = input.paper_kind.unwrap_or(current.paper_kind);
    let field = input.field.unwrap_or(current.field);
    let language = input.language.unwrap_or(current.language);
    let target_venue = input.target_venue.unwrap_or(current.target_venue);
    let privacy = input.privacy.unwrap_or(current.privacy);
    let deadline = input.deadline.unwrap_or(current.deadline);
    let meta_json = input.meta_json.unwrap_or(current.meta_json);
    let now = now_secs();
    conn.execute(
        "UPDATE research_projects SET title = ?2, paper_kind = ?3, field = ?4, language = ?5, \
             target_venue = ?6, privacy = ?7, deadline = ?8, meta_json = ?9, updated_at = ?10 \
         WHERE id = ?1",
        params![
            project_id, title, paper_kind, field, language, target_venue, privacy, deadline,
            meta_json, now
        ],
    )
    .map_err(|err| format!("failed to update research project: {err}"))?;
    record_event_conn(&conn, &project_id, "user", "project.updated", "{}");
    get_project_conn(&conn, &project_id)?
        .ok_or_else(|| format!("研究项目不存在：{project_id}"))
}

#[tauri::command]
pub fn research_stage_update(
    db: State<'_, Db>,
    project_id: String,
    stage: String,
    status: String,
    gate_json: Option<String>,
) -> Result<ProjectDetail, String> {
    if !STAGES.contains(&stage.as_str()) {
        return Err(format!("未知阶段：{stage}"));
    }
    if !ALLOWED_STATUS.contains(&status.as_str()) {
        return Err(format!("未知阶段状态：{status}"));
    }
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    if get_project_conn(&conn, &project_id)?.is_none() {
        return Err(format!("研究项目不存在：{project_id}"));
    }
    let now = now_secs();
    let entered_at = if status == "active" { Some(now) } else { None };
    let approved_at = if status == "approved" || status == "frozen" {
        Some(now)
    } else {
        None
    };
    conn.execute(
        "UPDATE research_stages SET status = ?3, \
             entered_at = COALESCE(?4, entered_at), \
             approved_at = COALESCE(?5, approved_at), \
             gate_json = COALESCE(?6, gate_json) \
         WHERE project_id = ?1 AND stage = ?2",
        params![project_id, stage, status, entered_at, approved_at, gate_json],
    )
    .map_err(|err| format!("failed to update research stage: {err}"))?;
    if status == "active" {
        // 只允许一个“进行中”阶段：切到新阶段时，旧的进行中降为待审核。
        conn.execute(
            "UPDATE research_stages SET status = 'submitted' WHERE project_id = ?1 AND stage <> ?2 AND status = 'active'",
            params![project_id, stage],
        )
        .map_err(|err| format!("failed to pause previous stage: {err}"))?;
        conn.execute(
            "UPDATE research_projects SET current_stage = ?2, updated_at = ?3 WHERE id = ?1",
            params![project_id, stage, now],
        )
        .map_err(|err| format!("failed to update current stage: {err}"))?;
    }
    record_event_conn(&conn, &project_id, "user", "stage.updated", "{}");
    detail_conn(&conn, &project_id)
}

#[tauri::command]
pub fn research_artifact_add(
    db: State<'_, Db>,
    project_id: String,
    stage: Option<String>,
    kind: Option<String>,
    title: String,
    path: Option<String>,
) -> Result<ProjectDetail, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("产物标题不能为空".to_string());
    }
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    let project = get_project_conn(&conn, &project_id)?
        .ok_or_else(|| format!("研究项目不存在：{project_id}"))?;
    let stage = stage
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&project.current_stage)
        .to_string();
    let kind = kind
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("doc")
        .to_string();
    let id = db::local_id();
    let now = now_secs();
    conn.execute(
        "INSERT INTO project_artifacts(id, project_id, stage, kind, title, path, version, sha256, status, meta_json, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, '', 'draft', '{}', ?7)",
        params![id, project_id, stage, kind, title, path.as_deref().unwrap_or(""), now],
    )
    .map_err(|err| format!("failed to insert artifact: {err}"))?;
    conn.execute(
        "UPDATE research_projects SET updated_at = ?2 WHERE id = ?1",
        params![project_id, now],
    )
    .map_err(|err| format!("failed to touch project: {err}"))?;
    record_event_conn(&conn, &project_id, "user", "artifact.added", "{}");
    detail_conn(&conn, &project_id)
}

#[tauri::command]
pub fn research_events_list(
    db: State<'_, Db>,
    project_id: String,
    limit: Option<i64>,
) -> Result<Vec<ResearchEvent>, String> {
    let limit = limit.unwrap_or(50).clamp(1, 500);
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    let mut stmt = conn
        .prepare(
            "SELECT id, ts, actor, type, payload_json FROM project_events \
             WHERE project_id = ?1 ORDER BY id DESC LIMIT ?2",
        )
        .map_err(|err| format!("failed to prepare event list: {err}"))?;
    let rows = stmt
        .query_map(params![project_id, limit], |row| {
            Ok(ResearchEvent {
                id: row.get(0)?,
                ts: row.get(1)?,
                actor: row.get(2)?,
                kind: row.get(3)?,
                payload_json: row.get(4)?,
            })
        })
        .map_err(|err| format!("failed to query events: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("failed to read events: {err}"))
}

// ---------------------------------------------------------------------------
// Research assistant (Phase 1, non-streaming)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTurnInput {
    pub role: String,
    pub content: String,
}

fn stage_prompt_name(stage: &str) -> &'static str {
    match stage {
        "topic" => "选题",
        "design" => "研究设计",
        "advise" => "指导",
        "experiment" => "实验",
        "writing" => "写作",
        "submission" => "投稿",
        _ => "指导",
    }
}

fn build_briefing(
    conn: &Connection,
    project: &ResearchProject,
    stages: &[ResearchStage],
    artifacts: &[ResearchArtifact],
) -> Result<String, String> {
    let mut out = String::new();
    out.push_str(&format!(
        "- 项目：{}（类型：{}；目标期刊：{}；截止：{}）\n",
        project.title,
        project.paper_kind,
        if project.target_venue.is_empty() {
            "未填写"
        } else {
            &project.target_venue
        },
        if project.deadline.is_empty() {
            "未填写"
        } else {
            &project.deadline
        },
    ));
    if !project.field.is_empty() {
        out.push_str(&format!("- 研究方向：{}\n", project.field));
    }
    out.push_str(&format!(
        "- 数据边界：{}（local=不出本机；summary_ok=仅发摘要；cloud_ok=可发正文）\n",
        project.privacy
    ));

    let stage_line = stages
        .iter()
        .map(|stage| format!("{}({})", stage.label, stage.status))
        .collect::<Vec<_>>()
        .join(" → ");
    out.push_str(&format!("- 阶段状态：{stage_line}\n"));
    let stage_label = STAGES
        .iter()
        .position(|candidate| candidate == &project.current_stage)
        .map(|index| STAGE_LABELS[index])
        .unwrap_or(project.current_stage.as_str());
    out.push_str(&format!("- 当前阶段：{stage_label}\n"));

    if artifacts.is_empty() {
        out.push_str("- 已有产物：无\n");
    } else {
        out.push_str("- 已有产物：\n");
        for artifact in artifacts.iter().take(12) {
            out.push_str(&format!(
                "  - [{}] {}（{}，v{}，{}）\n",
                artifact.stage, artifact.title, artifact.kind, artifact.version, artifact.status
            ));
        }
    }

    // Literature (metadata only — never bodies).
    let mut stmt = conn
        .prepare(
            "SELECT title, year, status FROM literature_refs WHERE project_id = ?1 \
             ORDER BY created_at DESC LIMIT 15",
        )
        .map_err(|err| format!("failed to prepare literature brief: {err}"))?;
    let rows = stmt
        .query_map(params![&project.id], |row| {
            let title: String = row.get(0)?;
            let year: Option<i64> = row.get(1)?;
            let status: String = row.get(2)?;
            Ok((title, year, status))
        })
        .map_err(|err| format!("failed to query literature brief: {err}"))?;
    let literature: Vec<(String, Option<i64>, String)> = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("failed to read literature brief: {err}"))?;
    if literature.is_empty() {
        out.push_str("- 文献：尚未导入（提示用户用「文献」页导入 BibTeX/CSL）\n");
    } else {
        out.push_str(&format!("- 文献（最近 {} 条）：\n", literature.len()));
        for (index, (title, year, status)) in literature.iter().enumerate() {
            out.push_str(&format!(
                "  - [{}] {} ({}) {}\n",
                index + 1,
                title,
                year.map(|value| value.to_string()).unwrap_or_else(|| "n.d.".to_string()),
                status
            ));
        }
    }

    // Datasets (profile summary only — never raw rows).
    let mut stmt = conn
        .prepare(
            "SELECT name, rows, cols, privacy FROM datasets WHERE project_id = ?1 \
             ORDER BY created_at DESC LIMIT 8",
        )
        .map_err(|err| format!("failed to prepare dataset brief: {err}"))?;
    let rows = stmt
        .query_map(params![&project.id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|err| format!("failed to query dataset brief: {err}"))?;
    let datasets: Vec<(String, Option<i64>, Option<i64>, String)> = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("failed to read dataset brief: {err}"))?;
    if !datasets.is_empty() {
        out.push_str("- 数据集：\n");
        for (name, row_count, col_count, privacy) in datasets {
            out.push_str(&format!(
                "  - {}（{} 行 × {} 列，{}）\n",
                name,
                row_count.map(|value| value.to_string()).unwrap_or_else(|| "?".to_string()),
                col_count.map(|value| value.to_string()).unwrap_or_else(|| "?".to_string()),
                privacy
            ));
        }
    }

    // Recent decisions.
    let mut stmt = conn
        .prepare(
            "SELECT decision FROM decisions WHERE project_id = ?1 ORDER BY ts DESC LIMIT 8",
        )
        .map_err(|err| format!("failed to prepare decision brief: {err}"))?;
    let rows = stmt
        .query_map(params![&project.id], |row| row.get::<_, String>(0))
        .map_err(|err| format!("failed to query decision brief: {err}"))?;
    let decisions: Vec<String> = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("failed to read decision brief: {err}"))?;
    if !decisions.is_empty() {
        out.push_str("- 最近决策：\n");
        for decision in decisions {
            out.push_str(&format!("  - {decision}\n"));
        }
    }

    Ok(out)
}

/// 主聊天用：拼装一个项目的简报（阶段/产物/文献/数据/决策摘要）。
/// 只读、不写事件；项目不存在时返回错误。
pub(crate) fn project_briefing(conn: &Connection, project_id: &str) -> Result<String, String> {
    let project = get_project_conn(conn, project_id)?
        .ok_or_else(|| format!("研究项目不存在：{project_id}"))?;
    let stages = list_stages_conn(conn, project_id)?;
    let artifacts = list_artifacts_conn(conn, project_id)?;
    build_briefing(conn, &project, &stages, &artifacts)
}

#[tauri::command]
pub async fn research_ask(
    db: State<'_, Db>,
    project_id: String,
    question: String,
    history: Option<Vec<ChatTurnInput>>,
) -> Result<String, String> {
    let question = question.trim().to_string();
    if question.is_empty() {
        return Err("问题不能为空".to_string());
    }

    // Normalise the client-side transcript: roles whitelisted, length capped,
    // oldest turns dropped first.
    let mut turns: Vec<(String, String)> = Vec::new();
    if let Some(items) = history {
        let mut kept: Vec<ChatTurnInput> = items.into_iter().rev().take(12).collect();
        kept.reverse();
        for item in kept {
            let role = match item.role.trim() {
                "user" => "user",
                "assistant" => "assistant",
                _ => continue,
            };
            let content = item.content.trim();
            if content.is_empty() {
                continue;
            }
            turns.push((role.to_string(), content.chars().take(4000).collect()));
        }
    }

    let (briefing, current_stage, client, data_dir) = {
        let conn = db
            .conn
            .lock()
            .map_err(|err| format!("failed to acquire database lock: {err}"))?;
        let project = get_project_conn(&conn, &project_id)?
            .ok_or_else(|| format!("研究项目不存在：{project_id}"))?;
        let stages = list_stages_conn(&conn, &project_id)?;
        let artifacts = list_artifacts_conn(&conn, &project_id)?;
        let briefing = build_briefing(&conn, &project, &stages, &artifacts)?;
        let client = crate::llm_chat::chat_client_from_conn(&conn)?
            .ok_or_else(|| "未配置对话模型，请先在「API 设置」中填写提供方密钥".to_string())?;
        let dir = db
            .data_dir
            .lock()
            .map_err(|err| format!("failed to acquire data dir lock: {err}"))?
            .clone();
        (briefing, project.current_stage, client, dir)
    };

    let base = crate::prompts::load_base(&data_dir, crate::agents::AgentKind::Research);
    let stage_prompt = crate::prompts::read_prompt_body(
        &data_dir,
        crate::agents::AgentKind::Research,
        stage_prompt_name(&current_stage),
    )
    .unwrap_or_default();

    let system = format!(
        "{base}\n\n{stage_prompt}\n\n## 项目简报\n{briefing}\n\n\
         ## 输出纪律\n\
         - 结论先行，再给依据与下一步；不要复述项目简报。\n\
         - 引用项目文献时用 [n] 编号并对应上面的文献列表；未核实/不存在就明说。\n\
         - 实验数字只能来自已登记的数据与分析结果；没有就写「待补」。\n\
         - 需要用户补信息时，最多问 2 个最关键的问题。\n"
    );

    let mut messages: Vec<crate::llm_chat::ChatMessage> =
        Vec::with_capacity(turns.len() + 2);
    messages.push(crate::llm_chat::ChatMessage::new("system", system));
    for (role, content) in turns {
        messages.push(crate::llm_chat::ChatMessage::new(&role, content));
    }
    messages.push(crate::llm_chat::ChatMessage::new("user", question));

    let joined = tauri::async_runtime::spawn_blocking(move || {
        client.complete_turn(std::time::Duration::from_secs(180), &messages)
    })
    .await
    .map_err(|err| format!("研究助手执行失败：{err}"))?;
    joined
}
