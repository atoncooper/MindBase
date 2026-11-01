//! 实验运行（experiment_runs）SQL。

use rusqlite::{params, Connection};

use super::{execute, query_all, query_optional, RepoResult};
use crate::workspace::experiment::ExperimentRun;

/// 查询列顺序必须与 row_to_run 的索引一一对应。
const EXPERIMENT_COLS: &str = "id, project_id, name, dataset_ids, config_json, script_path, \
                              metrics_json, status, conclusion, created_at";

fn row_to_run(row: &rusqlite::Row<'_>) -> rusqlite::Result<ExperimentRun> {
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
}

/// 研究项目是否存在（实验命令的前置校验，业务层负责报错文案）。
pub(crate) fn project_exists(conn: &Connection, project_id: &str) -> RepoResult<bool> {
    let hit = query_optional(
        conn,
        "SELECT 1 FROM research_projects WHERE id = ?1",
        params![project_id],
        |_| Ok(()),
    )?;
    Ok(hit.is_some())
}

/// 项目实验记录（最新在前）。
pub(crate) fn list(conn: &Connection, project_id: &str) -> RepoResult<Vec<ExperimentRun>> {
    query_all(
        conn,
        &format!(
            "SELECT {EXPERIMENT_COLS} FROM experiment_runs \
             WHERE project_id = ?1 ORDER BY created_at DESC"
        ),
        params![project_id],
        row_to_run,
    )
}

/// 写入一条实验记录（id / created_at 由业务层生成）。
pub(crate) fn insert(conn: &Connection, run: &ExperimentRun) -> RepoResult<usize> {
    execute(
        conn,
        "INSERT INTO experiment_runs(id, project_id, name, dataset_ids, config_json,
             script_path, script_sha256, env_json, metrics_json, status, conclusion, created_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, '', '{}', ?7, ?8, ?9, ?10)",
        params![
            run.id,
            run.project_id,
            run.name,
            run.dataset_ids,
            run.config_json,
            run.script_path,
            run.metrics_json,
            run.status,
            run.conclusion,
            run.created_at,
        ],
    )
}

/// 触碰项目更新时间（登记实验后记录活动时间）。
pub(crate) fn touch_project(conn: &Connection, project_id: &str, now: i64) -> RepoResult<usize> {
    execute(
        conn,
        "UPDATE research_projects SET updated_at = ?2 WHERE id = ?1",
        params![project_id, now],
    )
}
