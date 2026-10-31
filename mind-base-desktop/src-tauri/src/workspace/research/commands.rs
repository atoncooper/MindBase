//! Tauri commands for research projects and the non-streaming research assistant.

use std::path::PathBuf;

use rusqlite::{params, OptionalExtension};
use tauri::State;

use crate::infra::db::{self, Db};

use super::briefing::{build_briefing, stage_prompt_name};
use super::store::{
    detail_conn, get_project_conn, list_artifacts_conn, list_projects_conn, list_stages_conn,
    record_event_conn, update_stage_conn,
};
use super::{
    ChatTurnInput, ProjectCreateInput, ProjectDetail, ProjectUpdateInput, ResearchAdvice,
    ResearchEvent, ResearchProject,
};
use super::{now_secs, STAGES};

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
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    let now = now_secs();
    update_stage_conn(
        &conn,
        &project_id,
        &stage,
        &status,
        gate_json.as_deref(),
        now,
    )?;
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
    app: tauri::AppHandle,
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

    let (briefing, current_stage, client, embed_client, data_dir) = {
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
        let embed_client = crate::llm::embeddings::embed_client_from_conn_opt(&conn)?;
        let dir = db
            .data_dir
            .lock()
            .map_err(|err| format!("failed to acquire data dir lock: {err}"))?
            .clone();
        (briefing, project.current_stage, client, embed_client, dir)
    };

    let base = crate::agent::prompts::load_base(&data_dir, crate::agent::agents::AgentKind::Research);
    let stage_prompt = crate::agent::prompts::read_prompt_body(
        &data_dir,
        crate::agent::agents::AgentKind::Research,
        stage_prompt_name(&current_stage),
    )
    .unwrap_or_default();

    // 科研助手升级为 ReAct：带工具（文献/项目/稿件/证据/检索/委托），
    // 不再是一次性的「嘴说」。项目简报 + 阶段 prompt + 最近对话都放进任务上下文。
    let mut task = String::new();
    task.push_str("【项目简报】\n");
    task.push_str(&briefing);
    if !stage_prompt.trim().is_empty() {
        task.push_str("\n\n【当前阶段指引】\n");
        task.push_str(stage_prompt.trim());
    }
    if !turns.is_empty() {
        task.push_str("\n\n【最近对话】\n");
        for (role, content) in &turns {
            task.push_str(&format!(
                "{}：{}\n",
                if role == "user" { "用户" } else { "助手" },
                content
            ));
        }
    }
    task.push_str("\n\n【当前问题】\n");
    task.push_str(&question);
    task.push_str(
        "\n\n要求：结论先行；引用项目文献时给出 [cite_key]；实验数字只能来自已登记数据集/实验，\
         没有就写「待补」；需要改项目/稿件时用工具完成，不要只给建议；\
         只有「阶段建议/决策」才调用 academic_project(action=save_advice) 保存到控制台，\
         文献/数据/稿件操作不要保存成建议。",
    );

    let session_id = format!("research-{project_id}");
    let prompt_for_run = format!("{base}\n\n{task}");
    let app_for_run = app.clone();
    let client_for_run = client.clone();
    let embed_for_run = embed_client.clone();
    let answer = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let mut noop_step = |_: u32, _: &str, _: &str| {};
        let (answer, _steps, _usage) = crate::agent::harness::run_sub_agent(
            crate::agent::agents::AgentKind::Research,
            &app_for_run,
            &client_for_run,
            embed_for_run.as_ref(),
            &session_id,
            &prompt_for_run,
            &mut noop_step,
        )?;
        Ok(answer)
    })
    .await
    .map_err(|err| format!("科研助手执行失败：{err}"))??;
    if answer.trim().is_empty() {
        return Err("科研助手没有产出内容（可能达到步数/时间上限），请重试或缩小问题范围".to_string());
    }
    Ok(answer)
}

/// 读取控制台展示的最新 AI 阶段建议（guidance_notes 最新一条）。
#[tauri::command]
pub fn research_advice_latest(
    db: State<'_, Db>,
    project_id: String,
) -> Result<Option<ResearchAdvice>, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    if get_project_conn(&conn, &project_id)?.is_none() {
        return Err(format!("研究项目不存在：{project_id}"));
    }
    conn.query_row(
        "SELECT questions_json, notes, created_at FROM guidance_notes \
         WHERE project_id = ?1 ORDER BY created_at DESC LIMIT 1",
        params![project_id],
        |row| {
            let questions: String = row.get(0)?;
            let question = serde_json::from_str::<Vec<String>>(&questions)
                .ok()
                .and_then(|items| items.into_iter().next())
                .unwrap_or_default();
            Ok(ResearchAdvice {
                question,
                notes: row.get(1)?,
                created_at: row.get(2)?,
            })
        },
    )
    .optional()
    .map_err(|err| format!("读取最新建议失败：{err}"))
}
