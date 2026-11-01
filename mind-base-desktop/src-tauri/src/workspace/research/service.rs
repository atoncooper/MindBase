//! 科研域业务层：组合 repository，承载校验与业务不变式（不含 SQL）。
//!
//! - 阶段流转：STAGES/ALLOWED_STATUS 校验、单 active 不变式、no-op 不写事件；
//! - 项目创建/更新：字段归一化、只记录真正变化的字段；
//! - 产物/建议：默认值填充 + 审计事件（事件失败不影响业务写）。
//!
//! 数据访问一律走 crate::repositories::research::*。

use rusqlite::Connection;

use crate::repositories::research::{artifacts, events, guidance, projects, stages, stats};

use super::{
    ProjectCreateInput, ProjectDetail, ProjectUpdateInput, ResearchAdvice, ResearchEventPage,
    ResearchOverviewStats, ResearchPlan, ResearchProject, ResearchStage,
};
use super::{ALLOWED_STATUS, STAGE_LABELS, STAGES};

fn ensure_project(conn: &Connection, project_id: &str) -> Result<(), String> {
    if projects::exists(conn, project_id)? {
        Ok(())
    } else {
        Err(format!("研究项目不存在：{project_id}"))
    }
}

fn stage_order(stage: &str) -> usize {
    STAGES
        .iter()
        .position(|candidate| *candidate == stage)
        .unwrap_or(STAGES.len())
}

fn stage_from_row(row: stages::StageRow) -> ResearchStage {
    let label = STAGES
        .iter()
        .position(|candidate| candidate == &row.stage)
        .map(|index| STAGE_LABELS[index].to_string())
        .unwrap_or_else(|| row.stage.clone());
    ResearchStage {
        stage: row.stage,
        label,
        status: row.status,
        entered_at: row.entered_at,
        approved_at: row.approved_at,
        gate_json: row.gate_json,
    }
}

/// 项目详情（项目 + 按生命周期排序的阶段 + 产物）。
pub(crate) fn detail(conn: &Connection, project_id: &str) -> Result<ProjectDetail, String> {
    let project = projects::find(conn, project_id)?
        .ok_or_else(|| format!("研究项目不存在：{project_id}"))?;
    let mut stage_dtos: Vec<ResearchStage> = stages::list(conn, project_id)?
        .into_iter()
        .map(stage_from_row)
        .collect();
    stage_dtos.sort_by_key(|stage| stage_order(&stage.stage));
    Ok(ProjectDetail {
        project,
        stages: stage_dtos,
        artifacts: artifacts::list(conn, project_id)?,
    })
}

pub(crate) fn list_projects(conn: &Connection) -> Result<Vec<ResearchProject>, String> {
    Ok(projects::list(conn)?)
}

/// 创建项目：字段归一化 → 插项目 → 插 6 个阶段（topic active，其余 locked）
/// → 记 project.created 事件。目录创建等 I/O 由命令层负责。
pub(crate) fn create_project(
    conn: &Connection,
    id: &str,
    input: ProjectCreateInput,
    now: i64,
) -> Result<(), String> {
    let title = input.title.trim();
    if title.is_empty() {
        return Err("项目名称不能为空".to_string());
    }
    let pick = |value: Option<&str>, fallback: &str| -> String {
        value
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .unwrap_or(fallback)
            .to_string()
    };
    let project = ResearchProject {
        id: id.to_string(),
        title: title.to_string(),
        paper_kind: pick(input.paper_kind.as_deref(), "journal"),
        field: input.field.as_deref().unwrap_or("").to_string(),
        language: pick(input.language.as_deref(), "zh"),
        target_venue: input.target_venue.as_deref().unwrap_or("").to_string(),
        current_stage: "topic".to_string(),
        privacy: pick(input.privacy.as_deref(), "local"),
        deadline: input.deadline.as_deref().unwrap_or("").to_string(),
        meta_json: "{}".to_string(),
        created_at: now,
        updated_at: now,
    };
    projects::insert(conn, &project)?;
    for (index, stage) in STAGES.iter().enumerate() {
        let status = if index == 0 { "active" } else { "locked" };
        let entered_at = if index == 0 { Some(now) } else { None };
        stages::insert(conn, id, stage, status, entered_at, "[]")?;
    }
    let _ = events::append(
        conn,
        id,
        "user",
        "project.created",
        &serde_json::json!({"title": title}).to_string(),
        now,
    );
    Ok(())
}

/// 更新项目资料：只落真正变化的字段，无变化时不写 project.updated 事件。
pub(crate) fn update_project(
    conn: &Connection,
    project_id: &str,
    input: ProjectUpdateInput,
    now: i64,
) -> Result<ResearchProject, String> {
    let current = projects::find(conn, project_id)?
        .ok_or_else(|| format!("研究项目不存在：{project_id}"))?;
    let title = input
        .title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| current.title.clone());
    let paper_kind = input
        .paper_kind
        .as_deref()
        .unwrap_or(&current.paper_kind)
        .to_string();
    let field = input.field.as_deref().unwrap_or(&current.field).to_string();
    let language = input
        .language
        .as_deref()
        .unwrap_or(&current.language)
        .to_string();
    let target_venue = input
        .target_venue
        .as_deref()
        .unwrap_or(&current.target_venue)
        .to_string();
    let privacy = input
        .privacy
        .as_deref()
        .unwrap_or(&current.privacy)
        .to_string();
    let deadline = input
        .deadline
        .as_deref()
        .unwrap_or(&current.deadline)
        .to_string();
    let meta_json = input
        .meta_json
        .as_deref()
        .unwrap_or(&current.meta_json)
        .to_string();
    // 只把真正变了的字段记进事件，避免 update 空转刷屏。
    let mut changed: Vec<&str> = Vec::new();
    if title != current.title {
        changed.push("title");
    }
    if paper_kind != current.paper_kind {
        changed.push("paperKind");
    }
    if field != current.field {
        changed.push("field");
    }
    if language != current.language {
        changed.push("language");
    }
    if target_venue != current.target_venue {
        changed.push("targetVenue");
    }
    if privacy != current.privacy {
        changed.push("privacy");
    }
    if deadline != current.deadline {
        changed.push("deadline");
    }
    if meta_json != current.meta_json {
        changed.push("metaJson");
    }
    projects::update_profile(
        conn,
        project_id,
        &projects::ProjectProfile {
            title: &title,
            paper_kind: &paper_kind,
            field: &field,
            language: &language,
            target_venue: &target_venue,
            privacy: &privacy,
            deadline: &deadline,
            meta_json: &meta_json,
            updated_at: now,
        },
    )?;
    if !changed.is_empty() {
        let _ = events::append(
            conn,
            project_id,
            "user",
            "project.updated",
            &serde_json::json!({"changed": changed}).to_string(),
            now,
        );
    }
    projects::find(conn, project_id)?
        .ok_or_else(|| format!("研究项目不存在：{project_id}"))
}

/// 阶段状态流转（命令与 agent 工具共用）：只允许一个 active 阶段。
///
/// UPDATE 始终执行（保持幂等 / 单 active 不变式），但事件只在阶段状态真的
/// 变化（或带上了新的 gate_json）时才写：agent 反复调用 stage_update 不再刷屏。
pub(crate) fn update_stage(
    conn: &Connection,
    project_id: &str,
    stage: &str,
    status: &str,
    gate_json: Option<&str>,
    actor: &str,
    now: i64,
) -> Result<(), String> {
    if !STAGES.contains(&stage) {
        return Err(format!("未知阶段：{stage}"));
    }
    if !ALLOWED_STATUS.contains(&status) {
        return Err(format!("未知阶段状态：{status}"));
    }
    ensure_project(conn, project_id)?;
    let current = stages::status(conn, project_id, stage)?
        .ok_or_else(|| format!("阶段不存在：{stage}"))?;
    let changed = current != status || gate_json.is_some();
    let entered_at = if status == "active" { Some(now) } else { None };
    let approved_at = if status == "approved" || status == "frozen" {
        Some(now)
    } else {
        None
    };
    stages::set_status(
        conn,
        project_id,
        stage,
        status,
        entered_at,
        approved_at,
        gate_json,
    )?;
    if status == "active" {
        stages::pause_others(conn, project_id, stage)?;
        projects::set_current_stage(conn, project_id, stage, now)?;
    }
    if changed {
        let _ = events::append(
            conn,
            project_id,
            actor,
            "stage.updated",
            &serde_json::json!({"stage": stage, "from": current, "to": status}).to_string(),
            now,
        );
    }
    Ok(())
}

/// 更新阶段门禁勾选（纯 UI 状态，不写事件流）。
pub(crate) fn set_stage_gate(
    conn: &Connection,
    project_id: &str,
    stage: &str,
    gate_json: &str,
) -> Result<(), String> {
    if !STAGES.contains(&stage) {
        return Err(format!("未知阶段：{stage}"));
    }
    ensure_project(conn, project_id)?;
    let updated = stages::set_gate(conn, project_id, stage, gate_json)?;
    if updated == 0 {
        return Err(format!("阶段不存在：{stage}"));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn add_artifact(
    conn: &Connection,
    id: &str,
    project_id: &str,
    stage: Option<&str>,
    kind: Option<&str>,
    title: &str,
    path: Option<&str>,
    now: i64,
) -> Result<(), String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("产物标题不能为空".to_string());
    }
    let project = projects::find(conn, project_id)?
        .ok_or_else(|| format!("研究项目不存在：{project_id}"))?;
    let stage = stage
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| project.current_stage.clone());
    let kind = kind
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("doc")
        .to_string();
    artifacts::insert(
        conn,
        id,
        project_id,
        &stage,
        &kind,
        title,
        path.unwrap_or(""),
        now,
    )?;
    projects::touch(conn, project_id, now)?;
    let _ = events::append(
        conn,
        project_id,
        "user",
        "artifact.added",
        &serde_json::json!({
            "artifactId": id,
            "title": title,
            "stage": stage,
            "kind": kind,
        })
        .to_string(),
        now,
    );
    Ok(())
}

/// 保存阶段建议（agent 工具用）：写 guidance_notes + ai.advice 审计事件。
pub(crate) fn save_advice(
    conn: &Connection,
    id: &str,
    project_id: &str,
    question: &str,
    notes: &str,
    now: i64,
) -> Result<(), String> {
    let notes = notes.trim();
    if notes.is_empty() {
        return Err("建议正文不能为空".to_string());
    }
    let question = question.trim();
    let question = if question.is_empty() {
        "阶段建议"
    } else {
        question
    };
    ensure_project(conn, project_id)?;
    guidance::insert(
        conn,
        id,
        project_id,
        &serde_json::json!([question]).to_string(),
        notes,
        now,
    )?;
    let _ = events::append(
        conn,
        project_id,
        "agent",
        "ai.advice",
        &serde_json::json!({"chars": notes.chars().count()}).to_string(),
        now,
    );
    Ok(())
}

pub(crate) fn events_page(
    conn: &Connection,
    project_id: &str,
    limit: i64,
    before_id: Option<i64>,
) -> Result<ResearchEventPage, String> {
    Ok(events::page(conn, project_id, limit, before_id)?)
}

pub(crate) fn advice_latest(
    conn: &Connection,
    project_id: &str,
) -> Result<Option<ResearchAdvice>, String> {
    ensure_project(conn, project_id)?;
    Ok(guidance::latest(conn, project_id)?)
}

pub(crate) fn advice_list(
    conn: &Connection,
    project_id: &str,
    limit: i64,
) -> Result<Vec<ResearchAdvice>, String> {
    ensure_project(conn, project_id)?;
    Ok(guidance::list(conn, project_id, limit)?)
}

pub(crate) fn overview_stats(
    conn: &Connection,
    project_id: &str,
) -> Result<ResearchOverviewStats, String> {
    ensure_project(conn, project_id)?;
    Ok(stats::overview(conn, project_id)?)
}

/// 目标期刊推荐用：最近文献里出现过的期刊/会议（去重、保持最新顺序）。
pub(crate) fn literature_venues(
    conn: &Connection,
    project_id: &str,
    limit: i64,
) -> Result<Vec<String>, String> {
    ensure_project(conn, project_id)?;
    let mut venues: Vec<String> = Vec::new();
    for row in stats::recent_literature(conn, project_id, limit)? {
        let venue = row.venue.trim();
        if !venue.is_empty() && !venues.iter().any(|existing| existing == venue) {
            venues.push(venue.to_string());
        }
    }
    Ok(venues)
}

// ---------------------------------------------------------------------------
// AI 研究计划（meta_json.plans.<stage> 持久化 + gate_json.checks 勾选）
// ---------------------------------------------------------------------------

/// 把一个阶段计划合并进 meta_json（保留其它 meta 字段与其它阶段计划）。
pub(crate) fn merge_plan_meta(meta_json: &str, plan: &ResearchPlan) -> Result<String, String> {
    let mut root = match serde_json::from_str::<serde_json::Value>(meta_json) {
        Ok(serde_json::Value::Object(map)) => serde_json::Value::Object(map),
        _ => serde_json::json!({}),
    };
    let object = root
        .as_object_mut()
        .ok_or_else(|| "项目 meta_json 不是 JSON 对象".to_string())?;
    let plans = object
        .entry("plans")
        .or_insert_with(|| serde_json::json!({}));
    if !plans.is_object() {
        *plans = serde_json::json!({});
    }
    let plan_value = serde_json::to_value(plan)
        .map_err(|err| format!("研究计划序列化失败：{err}"))?;
    plans
        .as_object_mut()
        .ok_or_else(|| "项目 meta_json.plans 不是 JSON 对象".to_string())?
        .insert(plan.stage.clone(), plan_value);
    Ok(root.to_string())
}

fn plan_by_stage(meta_json: &str, stage: &str) -> Option<ResearchPlan> {
    let root = serde_json::from_str::<serde_json::Value>(meta_json).ok()?;
    let plan = root.get("plans")?.get(stage)?;
    serde_json::from_value::<ResearchPlan>(plan.clone()).ok()
}

/// 读取某阶段已持久化的研究计划。
pub(crate) fn plan_get(
    conn: &Connection,
    project_id: &str,
    stage: &str,
) -> Result<Option<ResearchPlan>, String> {
    if !STAGES.contains(&stage) {
        return Err(format!("未知阶段：{stage}"));
    }
    let project = projects::find(conn, project_id)?
        .ok_or_else(|| format!("研究项目不存在：{project_id}"))?;
    Ok(plan_by_stage(&project.meta_json, stage))
}

/// 持久化 AI 生成的研究计划，并记 plan.generated 事件。
pub(crate) fn save_plan(
    conn: &Connection,
    project_id: &str,
    plan: &ResearchPlan,
    now: i64,
) -> Result<(), String> {
    if !STAGES.contains(&plan.stage.as_str()) {
        return Err(format!("未知阶段：{}", plan.stage));
    }
    let project = projects::find(conn, project_id)?
        .ok_or_else(|| format!("研究项目不存在：{project_id}"))?;
    let meta_json = merge_plan_meta(&project.meta_json, plan)?;
    projects::set_meta_json(conn, project_id, &meta_json, now)?;
    let _ = events::append(
        conn,
        project_id,
        "agent",
        "plan.generated",
        &serde_json::json!({"stage": plan.stage}).to_string(),
        now,
    );
    Ok(())
}

/// 勾选/取消一项计划任务：写入 gate_json.checks[task_id] 并记 plan.task 事件。
pub(crate) fn merge_task_check(
    gate_json: &str,
    task_id: &str,
    done: bool,
) -> Result<String, String> {
    let mut root = match serde_json::from_str::<serde_json::Value>(gate_json) {
        Ok(serde_json::Value::Object(map)) => serde_json::Value::Object(map),
        // 历史阶段用 "[]" 初始化 gate_json：升级为对象结构。
        _ => serde_json::json!({}),
    };
    let object = root
        .as_object_mut()
        .ok_or_else(|| "阶段 gate_json 不是 JSON 对象".to_string())?;
    let checks = object
        .entry("checks")
        .or_insert_with(|| serde_json::json!({}));
    if !checks.is_object() {
        *checks = serde_json::json!({});
    }
    checks
        .as_object_mut()
        .ok_or_else(|| "阶段 gate_json.checks 不是 JSON 对象".to_string())?
        .insert(task_id.to_string(), serde_json::json!(done));
    Ok(root.to_string())
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn plan_task_set(
    conn: &Connection,
    project_id: &str,
    stage: &str,
    task_id: &str,
    done: bool,
    actor: &str,
    now: i64,
) -> Result<(), String> {
    if !STAGES.contains(&stage) {
        return Err(format!("未知阶段：{stage}"));
    }
    let task_id = task_id.trim();
    if task_id.is_empty() {
        return Err("计划任务 id 不能为空".to_string());
    }
    ensure_project(conn, project_id)?;
    let current = stages::gate(conn, project_id, stage)?
        .ok_or_else(|| format!("阶段不存在：{stage}"))?;
    let gate_json = merge_task_check(&current, task_id, done)?;
    stages::set_gate(conn, project_id, stage, &gate_json)?;
    let _ = events::append(
        conn,
        project_id,
        actor,
        "plan.task",
        &serde_json::json!({"stage": stage, "taskId": task_id, "done": done}).to_string(),
        now,
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repositories::research::events;
    use crate::workspace::research::ProjectCreateInput;

    fn seeded_conn() -> (Connection, String) {
        let conn = crate::repositories::research::in_memory_conn();
        let project_id = "service-test".to_string();
        create_project(
            &conn,
            &project_id,
            ProjectCreateInput {
                title: "服务层测试项目".to_string(),
                paper_kind: None,
                field: None,
                language: None,
                target_venue: None,
                privacy: None,
                deadline: None,
            },
            1000,
        )
        .expect("create project");
        (conn, project_id)
    }

    #[test]
    fn update_stage_keeps_single_active_and_writes_only_on_change() {
        let (conn, project_id) = seeded_conn();

        // 创建时 topic=active；再置 active 是 no-op，不应新增事件。
        update_stage(&conn, &project_id, "topic", "active", None, "user", 1001)
            .expect("no-op stage update");
        let page = events::page(&conn, &project_id, 20, None).expect("events");
        assert_eq!(page.events.len(), 1, "only project.created: {:?}", page.events);
        assert_eq!(page.events[0].kind, "project.created");

        // design → active：topic 被置 submitted，项目当前阶段切到 design，写 1 条事件。
        update_stage(
            &conn,
            &project_id,
            "design",
            "active",
            None,
            "agent",
            1002,
        )
        .expect("activate design stage");
        let detail = detail(&conn, &project_id).expect("detail");
        assert_eq!(detail.project.current_stage, "design");
        let topic = detail
            .stages
            .iter()
            .find(|stage| stage.stage == "topic")
            .expect("topic stage");
        assert_eq!(topic.status, "submitted");
        let design = detail
            .stages
            .iter()
            .find(|stage| stage.stage == "design")
            .expect("design stage");
        assert_eq!(design.status, "active");

        let page = events::page(&conn, &project_id, 20, None).expect("events");
        assert_eq!(page.events.len(), 2, "project.created + stage.updated");
        let latest = &page.events[0];
        assert_eq!(latest.kind, "stage.updated");
        assert_eq!(latest.actor, "agent");
        assert!(latest.payload_json.contains(r#""from":"locked""#));
        assert!(latest.payload_json.contains(r#""to":"active""#));

        // 重复同样的 active：no-op，不再写事件。
        update_stage(&conn, &project_id, "design", "active", None, "agent", 1003)
            .expect("repeat stage update");
        let page = events::page(&conn, &project_id, 20, None).expect("events");
        assert_eq!(page.events.len(), 2, "no-op update must not append events");
    }

    #[test]
    fn update_stage_validates_stage_status_and_project() {
        let (conn, project_id) = seeded_conn();
        let err = update_stage(&conn, &project_id, "no-such", "active", None, "user", 2)
            .expect_err("unknown stage");
        assert!(err.contains("未知阶段"), "unexpected: {err}");
        let err = update_stage(&conn, &project_id, "topic", "no-such", None, "user", 2)
            .expect_err("unknown status");
        assert!(err.contains("未知阶段状态"), "unexpected: {err}");
        let err = update_stage(&conn, "no-such-project", "topic", "active", None, "user", 2)
            .expect_err("unknown project");
        assert!(err.contains("研究项目不存在"), "unexpected: {err}");
    }

    #[test]
    fn set_stage_gate_updates_json_and_validates() {
        let (conn, project_id) = seeded_conn();
        let gate = r#"{"checks":{"problem":true}}"#;
        set_stage_gate(&conn, &project_id, "topic", gate).expect("update gate");
        let detail = detail(&conn, &project_id).expect("detail");
        let topic = detail
            .stages
            .iter()
            .find(|stage| stage.stage == "topic")
            .expect("topic stage");
        assert_eq!(topic.gate_json, gate);

        let err = set_stage_gate(&conn, &project_id, "no-such-stage", "{}")
            .expect_err("unknown stage");
        assert!(err.contains("未知阶段"), "unexpected: {err}");
        let err = set_stage_gate(&conn, "no-such-project", "topic", "{}")
            .expect_err("unknown project");
        assert!(err.contains("研究项目不存在"), "unexpected: {err}");
    }

    #[test]
    fn plan_meta_roundtrip_and_task_check_events() {
        let (conn, project_id) = seeded_conn();
        use crate::repositories::research::{projects, stages};
        use crate::workspace::research::PlanTask;

        // 预置其它 meta 字段与旧 plans.topic，验证合并时保留。
        let existing_meta = r#"{"note":"keep","plans":{"topic":{"stage":"topic","goal":"旧计划","tasks":[],"deliverables":[],"acceptance":[],"risks":[],"prompts":[],"generatedAt":1,"source":"ai"}}}"#;
        projects::set_meta_json(&conn, &project_id, existing_meta, 2).expect("seed meta");

        let plan = ResearchPlan {
            stage: "design".to_string(),
            goal: "拆解研究设计".to_string(),
            tasks: vec![PlanTask {
                id: "t1".to_string(),
                label: "写方法初稿".to_string(),
            }],
            deliverables: vec!["方法章节".to_string()],
            acceptance: Vec::new(),
            risks: Vec::new(),
            prompts: Vec::new(),
            generated_at: 100,
            source: "ai".to_string(),
        };
        save_plan(&conn, &project_id, &plan, 3).expect("save plan");
        let loaded = plan_get(&conn, &project_id, "design")
            .expect("plan get")
            .expect("plan exists");
        assert_eq!(loaded.goal, "拆解研究设计");
        assert_eq!(loaded.tasks.len(), 1);
        assert_eq!(loaded.tasks[0].id, "t1");

        let project = projects::find(&conn, &project_id)
            .expect("project")
            .expect("project row");
        let meta: serde_json::Value = serde_json::from_str(&project.meta_json).expect("meta json");
        assert_eq!(meta["note"], "keep", "其它 meta 字段必须保留");
        assert!(meta["plans"]["topic"].is_object(), "其它阶段计划必须保留");
        assert_eq!(meta["plans"]["design"]["goal"], "拆解研究设计");

        let page = events::page(&conn, &project_id, 20, None).expect("events");
        assert!(
            page.events
                .iter()
                .any(|event| event.kind == "plan.generated"
                    && event.payload_json.contains("\"stage\":\"design\"")),
            "{:?}",
            page.events
        );

        // 旧 gate_json 是 "[]"：task_set 应升级成对象并写入 checks。
        plan_task_set(&conn, &project_id, "design", "t1", true, "agent", 5)
            .expect("plan task set");
        let gate = stages::gate(&conn, &project_id, "design")
            .expect("gate")
            .expect("gate exists");
        let gate_value: serde_json::Value = serde_json::from_str(&gate).expect("gate json");
        assert_eq!(gate_value["checks"]["t1"], serde_json::json!(true));
        plan_task_set(&conn, &project_id, "design", "t1", false, "user", 6)
            .expect("plan task unset");
        let gate = stages::gate(&conn, &project_id, "design")
            .expect("gate")
            .expect("gate exists");
        let gate_value: serde_json::Value = serde_json::from_str(&gate).expect("gate json");
        assert_eq!(gate_value["checks"]["t1"], serde_json::json!(false));

        let page = events::page(&conn, &project_id, 20, None).expect("events");
        let task_events: Vec<_> = page
            .events
            .iter()
            .filter(|event| event.kind == "plan.task")
            .collect();
        assert_eq!(task_events.len(), 2, "{task_events:?}");
        assert!(task_events
            .iter()
            .any(|event| event.payload_json.contains("\"taskId\":\"t1\"")));
    }

    #[test]
    fn plan_operations_validate_stage_and_project() {
        let (conn, project_id) = seeded_conn();
        let err = plan_get(&conn, &project_id, "no-such-stage").expect_err("bad stage");
        assert!(err.contains("未知阶段"), "unexpected: {err}");
        let err = plan_get(&conn, "no-such-project", "design").expect_err("missing project");
        assert!(err.contains("研究项目不存在"), "unexpected: {err}");
        let err = plan_task_set(&conn, &project_id, "design", "  ", true, "agent", 1)
            .expect_err("empty task id");
        assert!(err.contains("不能为空"), "unexpected: {err}");
    }

    #[test]
    fn overview_stats_and_advice_require_existing_project() {
        let (conn, project_id) = seeded_conn();
        let stats = overview_stats(&conn, &project_id).expect("overview stats");
        assert_eq!(stats.literature_total, 0);
        let err = overview_stats(&conn, "no-such-project").expect_err("missing project");
        assert!(err.contains("研究项目不存在"), "unexpected: {err}");
        let err = advice_list(&conn, "no-such-project", 5).expect_err("missing project");
        assert!(err.contains("研究项目不存在"), "unexpected: {err}");
    }
}
