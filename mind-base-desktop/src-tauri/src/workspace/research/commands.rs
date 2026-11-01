//! Tauri commands for research projects and the non-streaming research assistant.
//!
//! 命令层只做参数解析、DB 锁、目录 I/O 与错误转换；业务规则在
//! [`super::service`]，SQL 在 `crate::repositories::research`。

use std::path::PathBuf;
use std::sync::MutexGuard;

use rusqlite::Connection;
use tauri::State;

use crate::infra::db::{self, Db};

use super::briefing::{build_briefing, stage_prompt_name};
use super::{ai, service};
use super::{
    ChatTurnInput, ProjectCreateInput, ProjectDetail, ProjectUpdateInput, ResearchAdvice,
    ResearchEventPage, ResearchOverviewStats, ResearchPlan, ResearchProject, VenueSuggestion,
};
use super::now_secs;

fn conn_guard<'a>(db: &'a State<'_, Db>) -> Result<MutexGuard<'a, Connection>, String> {
    db.conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))
}

#[tauri::command]
pub fn research_projects_list(db: State<'_, Db>) -> Result<Vec<ResearchProject>, String> {
    let conn = conn_guard(&db)?;
    service::list_projects(&conn)
}

#[tauri::command]
pub fn research_project_create(
    db: State<'_, Db>,
    input: ProjectCreateInput,
) -> Result<ProjectDetail, String> {
    let id = db::local_id();
    let now = now_secs();
    {
        let conn = conn_guard(&db)?;
        service::create_project(&conn, &id, input, now)?;
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

    let conn = conn_guard(&db)?;
    service::detail(&conn, &id)
}

#[tauri::command]
pub fn research_project_get(db: State<'_, Db>, project_id: String) -> Result<ProjectDetail, String> {
    let conn = conn_guard(&db)?;
    service::detail(&conn, &project_id)
}

#[tauri::command]
pub fn research_project_update(
    db: State<'_, Db>,
    project_id: String,
    input: ProjectUpdateInput,
) -> Result<ResearchProject, String> {
    let conn = conn_guard(&db)?;
    service::update_project(&conn, &project_id, input, now_secs())
}

#[tauri::command]
pub fn research_stage_update(
    db: State<'_, Db>,
    project_id: String,
    stage: String,
    status: String,
    gate_json: Option<String>,
) -> Result<ProjectDetail, String> {
    let conn = conn_guard(&db)?;
    service::update_stage(
        &conn,
        &project_id,
        &stage,
        &status,
        gate_json.as_deref(),
        "user",
        now_secs(),
    )?;
    service::detail(&conn, &project_id)
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
    let conn = conn_guard(&db)?;
    service::add_artifact(
        &conn,
        &db::local_id(),
        &project_id,
        stage.as_deref(),
        kind.as_deref(),
        &title,
        path.as_deref(),
        now_secs(),
    )?;
    service::detail(&conn, &project_id)
}

#[tauri::command]
pub fn research_events_list(
    db: State<'_, Db>,
    project_id: String,
    limit: Option<i64>,
    before_id: Option<i64>,
) -> Result<ResearchEventPage, String> {
    let limit = limit.unwrap_or(20).clamp(1, 100);
    let conn = conn_guard(&db)?;
    service::events_page(&conn, &project_id, limit, before_id)
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
        let conn = conn_guard(&db)?;
        let detail = service::detail(&conn, &project_id)?;
        let briefing = build_briefing(&conn, &detail.project, &detail.stages, &detail.artifacts)?;
        let client = crate::llm::client::chat_client_from_conn(&conn)?
            .ok_or_else(|| "未配置对话模型，请先在「API 设置」中填写提供方密钥".to_string())?;
        let embed_client = crate::llm::embeddings::embed_client_from_conn_opt(&conn)?;
        let dir = db
            .data_dir
            .lock()
            .map_err(|err| format!("failed to acquire data dir lock: {err}"))?
            .clone();
        (
            briefing,
            detail.project.current_stage,
            client,
            embed_client,
            dir,
        )
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
    let conn = conn_guard(&db)?;
    service::advice_latest(&conn, &project_id)
}

/// 读取阶段建议历史（控制台「阶段建议」列表用），按时间倒序。
#[tauri::command]
pub fn research_advice_list(
    db: State<'_, Db>,
    project_id: String,
    limit: Option<i64>,
) -> Result<Vec<ResearchAdvice>, String> {
    let limit = limit.unwrap_or(5).clamp(1, 20);
    let conn = conn_guard(&db)?;
    service::advice_list(&conn, &project_id, limit)
}

/// 更新阶段门禁勾选（UI 状态，不写事件），返回最新项目详情。
#[tauri::command]
pub fn research_stage_gate_set(
    db: State<'_, Db>,
    project_id: String,
    stage: String,
    gate_json: String,
) -> Result<ProjectDetail, String> {
    if gate_json.chars().count() > 20_000 {
        return Err("阶段门禁内容过长（上限 20000 字符）".to_string());
    }
    let parsed: serde_json::Value = serde_json::from_str(&gate_json)
        .map_err(|err| format!("阶段门禁 JSON 解析失败：{err}"))?;
    if !parsed.is_object() {
        return Err("阶段门禁必须是 JSON 对象".to_string());
    }
    let conn = conn_guard(&db)?;
    service::set_stage_gate(&conn, &project_id, &stage, &gate_json)?;
    service::detail(&conn, &project_id)
}

/// 阶段资料总览统计（文献/数据集/实验/产物/稿件/建议计数）。
#[tauri::command]
pub fn research_overview_stats(
    db: State<'_, Db>,
    project_id: String,
) -> Result<ResearchOverviewStats, String> {
    let conn = conn_guard(&db)?;
    service::overview_stats(&conn, &project_id)
}

/// AI 推荐 3-5 个目标期刊/会议（结合项目信息与近期文献渠道），并记事件。
// 命令由 Lead 在 app/commands.rs 注册；注册前暂无 crate 内调用方。
#[allow(dead_code)]
#[tauri::command]
pub async fn research_venue_recommend(
    db: State<'_, Db>,
    project_id: String,
) -> Result<Vec<VenueSuggestion>, String> {
    let conn = db.conn.clone();
    tauri::async_runtime::spawn_blocking(move || {
        ai::recommend_venues(&conn, &project_id, now_secs())
    })
    .await
    .map_err(|err| format!("期刊推荐任务执行失败：{err}"))?
}

/// 读取某阶段已生成的 AI 研究计划（没有返回 None）。
#[allow(dead_code)]
#[tauri::command]
pub fn research_plan_get(
    db: State<'_, Db>,
    project_id: String,
    stage: String,
) -> Result<Option<ResearchPlan>, String> {
    let conn = conn_guard(&db)?;
    service::plan_get(&conn, &project_id, &stage)
}

/// AI 生成并持久化某阶段研究计划（事件 plan.generated）。
#[allow(dead_code)]
#[tauri::command]
pub async fn research_plan_generate(
    db: State<'_, Db>,
    project_id: String,
    stage: String,
) -> Result<ResearchPlan, String> {
    let conn = db.conn.clone();
    tauri::async_runtime::spawn_blocking(move || {
        ai::generate_plan(&conn, &project_id, &stage, now_secs())
    })
    .await
    .map_err(|err| format!("研究计划生成任务执行失败：{err}"))?
}

/// 勾选/取消计划任务：写 gate_json.checks + plan.task 事件，返回最新项目详情。
#[allow(dead_code)]
#[tauri::command]
pub fn research_plan_task_set(
    db: State<'_, Db>,
    project_id: String,
    stage: String,
    task_id: String,
    done: bool,
) -> Result<ProjectDetail, String> {
    let conn = conn_guard(&db)?;
    service::plan_task_set(
        &conn,
        &project_id,
        &stage,
        &task_id,
        done,
        "user",
        now_secs(),
    )?;
    service::detail(&conn, &project_id)
}
