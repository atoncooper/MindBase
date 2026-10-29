//! Dataset table helpers: project existence check, audit events and row mapping.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::Value;

use super::now_secs;
use super::DatasetRow;

/// 校验研究项目存在（和 research.rs 的报错口径一致）。
pub(super) fn ensure_project(conn: &Connection, project_id: &str) -> Result<(), String> {
    conn.query_row(
        "SELECT 1 FROM research_projects WHERE id = ?1",
        params![project_id],
        |_| Ok(()),
    )
    .optional()
    .map_err(|err| format!("查询研究项目失败：{err}"))?
    .ok_or_else(|| format!("研究项目不存在：{project_id}"))
}

/// 追加审计事件；事件流是附加信息，写失败不能影响业务写入。
pub(super) fn record_event(conn: &Connection, project_id: &str, kind: &str, payload: &Value) {
    let _ = conn.execute(
        "INSERT INTO project_events(project_id, ts, actor, type, payload_json) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![project_id, now_secs(), "user", kind, payload.to_string()],
    );
}

pub(super) fn dataset_from_row(row: &Row<'_>) -> rusqlite::Result<DatasetRow> {
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

pub(super) const DATASET_COLS: &str = "id, name, path, sha256, rows, cols, privacy, schema_json, \
                            profile_json, created_at";
