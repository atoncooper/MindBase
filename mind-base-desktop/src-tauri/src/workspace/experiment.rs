//! 实验运行记录（experiment_runs）：AI 做实验/调参时登记配置、指标与结论。

use rusqlite::Connection;

use crate::repositories::experiment as experiment_repo;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExperimentRun {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub dataset_ids: String,
    pub config_json: String,
    pub script_path: String,
    pub metrics_json: String,
    pub status: String,
    pub conclusion: String,
    pub created_at: i64,
}

fn ensure_project(conn: &Connection, project_id: &str) -> Result<(), String> {
    if experiment_repo::project_exists(conn, project_id)? {
        Ok(())
    } else {
        Err(format!("研究项目不存在：{project_id}"))
    }
}

pub(crate) fn list(conn: &Connection, project_id: &str) -> Result<Vec<ExperimentRun>, String> {
    ensure_project(conn, project_id)?;
    experiment_repo::list(conn, project_id).map_err(Into::into)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn add(
    conn: &Connection,
    project_id: &str,
    name: &str,
    dataset_ids: &str,
    config_json: &str,
    script_path: &str,
    metrics_json: &str,
    status: &str,
    conclusion: &str,
    now: i64,
) -> Result<ExperimentRun, String> {
    ensure_project(conn, project_id)?;
    let name = name.trim();
    if name.is_empty() {
        return Err("实验名称不能为空".to_string());
    }
    let run = ExperimentRun {
        id: crate::infra::db::local_id(),
        project_id: project_id.to_string(),
        name: name.to_string(),
        dataset_ids: dataset_ids.to_string(),
        config_json: config_json.to_string(),
        script_path: script_path.to_string(),
        metrics_json: metrics_json.to_string(),
        status: status.to_string(),
        conclusion: conclusion.to_string(),
        created_at: now,
    };
    experiment_repo::insert(conn, &run)?;
    experiment_repo::touch_project(conn, project_id, now)?;
    Ok(run)
}
