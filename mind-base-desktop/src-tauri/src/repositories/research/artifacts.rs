//! 阶段产物（project_artifacts）SQL。

use rusqlite::{params, Connection, Row};

use crate::repositories::{count as count_rows, execute, query_all, RepoResult};
use crate::workspace::research::ResearchArtifact;

fn artifact_from_row(row: &Row<'_>) -> rusqlite::Result<ResearchArtifact> {
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
}

pub(crate) fn list(conn: &Connection, project_id: &str) -> RepoResult<Vec<ResearchArtifact>> {
    query_all(
        conn,
        "SELECT id, stage, kind, title, path, version, status, created_at \
         FROM project_artifacts WHERE project_id = ?1 ORDER BY created_at DESC",
        params![project_id],
        artifact_from_row,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn insert(
    conn: &Connection,
    id: &str,
    project_id: &str,
    stage: &str,
    kind: &str,
    title: &str,
    path: &str,
    created_at: i64,
) -> RepoResult<usize> {
    execute(
        conn,
        "INSERT INTO project_artifacts(\
             id, project_id, stage, kind, title, path, version, sha256, status, meta_json, created_at\
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, '', 'draft', '{}', ?7)",
        params![id, project_id, stage, kind, title, path, created_at],
    )
}

pub(crate) fn count(conn: &Connection, project_id: &str) -> RepoResult<i64> {
    count_rows(
        conn,
        "SELECT COUNT(*) FROM project_artifacts WHERE project_id = ?1",
        params![project_id],
    )
}
