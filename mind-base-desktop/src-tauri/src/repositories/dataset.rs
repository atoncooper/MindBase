//! 数据集（datasets）与数据集事件 SQL。

use rusqlite::{params, Connection};

use super::{execute, query_all, query_optional, RepoResult};
use crate::workspace::dataset::DatasetRow;

/// 查询列顺序必须与 row_to_dataset 的索引一一对应。
const DATASET_COLS: &str =
    "id, name, path, sha256, rows, cols, privacy, schema_json, profile_json, created_at";

fn row_to_dataset(row: &rusqlite::Row<'_>) -> rusqlite::Result<DatasetRow> {
    Ok(DatasetRow {
        id: row.get(0)?,
        name: row.get(1)?,
        path: row.get(2)?,
        sha256: row.get(3)?,
        rows: row.get(4)?,
        cols: row.get(5)?,
        privacy: row.get(6)?,
        schema_json: row.get(7)?,
        profile_json: row.get(8)?,
        created_at: row.get(9)?,
    })
}

/// 研究项目是否存在（数据集命令的前置校验，业务层负责报错文案）。
pub(crate) fn project_exists(conn: &Connection, project_id: &str) -> RepoResult<bool> {
    let hit = query_optional(
        conn,
        "SELECT 1 FROM research_projects WHERE id = ?1",
        params![project_id],
        |_| Ok(()),
    )?;
    Ok(hit.is_some())
}

/// 项目数据集列表（最新在前）。
pub(crate) fn list(conn: &Connection, project_id: &str) -> RepoResult<Vec<DatasetRow>> {
    query_all(
        conn,
        &format!(
            "SELECT {DATASET_COLS} FROM datasets WHERE project_id = ?1 ORDER BY created_at DESC"
        ),
        params![project_id],
        row_to_dataset,
    )
}

/// 写入一条数据集记录（id / created_at 由业务层生成；project_id 不在行 DTO 里）。
pub(crate) fn insert(conn: &Connection, project_id: &str, row: &DatasetRow) -> RepoResult<usize> {
    execute(
        conn,
        "INSERT INTO datasets(
             id, project_id, name, path, sha256, rows, cols, privacy,
             schema_json, profile_json, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            row.id,
            project_id,
            row.name,
            row.path,
            row.sha256,
            row.rows,
            row.cols,
            row.privacy,
            row.schema_json,
            row.profile_json,
            row.created_at,
        ],
    )
}

/// 追加数据集审计事件；事件流是附加信息，写失败不影响业务写入（调用方忽略返回值）。
pub(crate) fn record_event(
    conn: &Connection,
    project_id: &str,
    kind: &str,
    payload_json: &str,
) -> RepoResult<usize> {
    execute(
        conn,
        "INSERT INTO project_events(project_id, ts, actor, type, payload_json) \
         VALUES (?1, ?2, 'user', ?3, ?4)",
        params![project_id, now_secs(), kind, payload_json],
    )
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|delta| delta.as_secs() as i64)
        .unwrap_or_default()
}
