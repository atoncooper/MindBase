//! Tauri commands for research projects and the non-streaming research assistant.

use std::path::PathBuf;

use rusqlite::params;
use tauri::State;

use crate::infra::db::{self, Db};

use super::briefing::{build_briefing, stage_prompt_name};
use super::store::{
    detail_conn, get_project_conn, list_artifacts_conn, list_projects_conn, list_stages_conn,
    record_event_conn,
};
use super::{
    ChatTurnInput, ProjectCreateInput, ProjectDetail, ProjectUpdateInput, ResearchEvent,
    ResearchProject,
};
use super::{now_secs, ALLOWED_STATUS, STAGES};

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
        let client = crate::llm::client::chat_client_from_conn(&conn)?
            .ok_or_else(|| "未配置对话模型，请先在「API 设置」中填写提供方密钥".to_string())?;
        let dir = db
            .data_dir
            .lock()
            .map_err(|err| format!("failed to acquire data dir lock: {err}"))?
            .clone();
        (briefing, project.current_stage, client, dir)
    };

    let base = crate::agent::prompts::load_base(&data_dir, crate::agent::agents::AgentKind::Research);
    let stage_prompt = crate::agent::prompts::read_prompt_body(
        &data_dir,
        crate::agent::agents::AgentKind::Research,
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

    let mut messages: Vec<crate::llm::client::ChatMessage> =
        Vec::with_capacity(turns.len() + 2);
    messages.push(crate::llm::client::ChatMessage::new("system", system));
    for (role, content) in turns {
        messages.push(crate::llm::client::ChatMessage::new(&role, content));
    }
    messages.push(crate::llm::client::ChatMessage::new("user", question));

    let joined = tauri::async_runtime::spawn_blocking(move || {
        client.complete_turn(std::time::Duration::from_secs(180), &messages)
    })
    .await
    .map_err(|err| format!("研究助手执行失败：{err}"))?;
    joined
}
