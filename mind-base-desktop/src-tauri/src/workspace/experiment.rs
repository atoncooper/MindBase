//! 实验运行记录（experiment_runs）：AI 做实验/调参时登记配置、指标与结论。

use rusqlite::{params, Connection};

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
    conn.query_row(
        "SELECT 1 FROM research_projects WHERE id = ?1",
        params![project_id],
        |_| Ok(()),
    )
    .map_err(|_| format!("研究项目不存在：{project_id}"))?;
    Ok(())
}

pub(crate) fn list(conn: &Connection, project_id: &str) -> Result<Vec<ExperimentRun>, String> {
    ensure_project(conn, project_id)?;
    let mut statement = conn
        .prepare(
            "SELECT id, project_id, name, dataset_ids, config_json, script_path,
                    metrics_json, status, conclusion, created_at
             FROM experiment_runs WHERE project_id = ?1 ORDER BY created_at DESC",
        )
        .map_err(|err| format!("读取实验记录失败：{err}"))?;
    let rows = statement
        .query_map(params![project_id], |row| {
            Ok(ExperimentRun {
                id: row.get(0)?,
                project_id: row.get(1)?,
                name: row.get(2)?,
                dataset_ids: row.get(3)?,
                config_json: row.get(4)?,
                script_path: row.get(5)?,
                metrics_json: row.get(6)?,
                status: row.get(7)?,
                conclusion: row.get(8)?,
                created_at: row.get(9)?,
            })
        })
        .map_err(|err| format!("读取实验记录失败：{err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("读取实验记录失败：{err}"))
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
    let id = crate::infra::db::local_id();
    conn.execute(
        "INSERT INTO experiment_runs(id, project_id, name, dataset_ids, config_json,
             script_path, script_sha256, env_json, metrics_json, status, conclusion, created_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, '', '{}', ?7, ?8, ?9, ?10)",
        params![
            id,
            project_id,
            name,
            dataset_ids,
            config_json,
            script_path,
            metrics_json,
            status,
            conclusion,
            now
        ],
    )
    .map_err(|err| format!("写入实验记录失败：{err}"))?;
    conn.execute(
        "UPDATE research_projects SET updated_at = ?2 WHERE id = ?1",
        params![project_id, now],
    )
    .map_err(|err| format!("更新项目时间失败：{err}"))?;
    Ok(ExperimentRun {
        id,
        project_id: project_id.to_string(),
        name: name.to_string(),
        dataset_ids: dataset_ids.to_string(),
        config_json: config_json.to_string(),
        script_path: script_path.to_string(),
        metrics_json: metrics_json.to_string(),
        status: status.to_string(),
        conclusion: conclusion.to_string(),
        created_at: now,
    })
}
