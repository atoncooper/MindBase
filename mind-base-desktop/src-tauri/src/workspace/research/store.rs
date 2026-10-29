//! Research project/stage/artifact/event SQL scoped to a [`rusqlite::Connection`].

use rusqlite::{params, Connection, OptionalExtension, Row};

use super::{ProjectDetail, ResearchArtifact, ResearchProject, ResearchStage};
use super::{now_secs, STAGE_LABELS, STAGES};

fn project_from_row(row: &Row<'_>) -> rusqlite::Result<ResearchProject> {
    Ok(ResearchProject {
        id: row.get(0)?,
        title: row.get(1)?,
        paper_kind: row.get(2)?,
        field: row.get(3)?,
        language: row.get(4)?,
        target_venue: row.get(5)?,
        current_stage: row.get(6)?,
        privacy: row.get(7)?,
        deadline: row.get(8)?,
        meta_json: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

const PROJECT_COLS: &str = "id, title, paper_kind, field, language, target_venue, \
                            current_stage, privacy, deadline, meta_json, created_at, updated_at";

pub(super) fn get_project_conn(conn: &Connection, id: &str) -> Result<Option<ResearchProject>, String> {
    conn.query_row(
        &format!("SELECT {PROJECT_COLS} FROM research_projects WHERE id = ?1"),
        params![id],
        project_from_row,
    )
    .optional()
    .map_err(|err| format!("failed to load research project: {err}"))
}

pub(super) fn list_projects_conn(conn: &Connection) -> Result<Vec<ResearchProject>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {PROJECT_COLS} FROM research_projects ORDER BY updated_at DESC"
        ))
        .map_err(|err| format!("failed to prepare project list: {err}"))?;
    let rows = stmt
        .query_map([], project_from_row)
        .map_err(|err| format!("failed to query projects: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("failed to read projects: {err}"))
}

pub(super) fn list_stages_conn(conn: &Connection, project_id: &str) -> Result<Vec<ResearchStage>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT stage, status, entered_at, approved_at, gate_json \
             FROM research_stages WHERE project_id = ?1",
        )
        .map_err(|err| format!("failed to prepare stage list: {err}"))?;
    let mut rows = stmt
        .query_map(params![project_id], |row| {
            let stage: String = row.get(0)?;
            let label = STAGES
                .iter()
                .position(|candidate| candidate == &stage)
                .map(|index| STAGE_LABELS[index].to_string())
                .unwrap_or_else(|| stage.clone());
            Ok(ResearchStage {
                stage,
                label,
                status: row.get(1)?,
                entered_at: row.get(2)?,
                approved_at: row.get(3)?,
                gate_json: row.get(4)?,
            })
        })
        .map_err(|err| format!("failed to query stages: {err}"))?;

    let mut result: Vec<ResearchStage> = Vec::new();
    while let Some(row) = rows.next() {
        result.push(row.map_err(|err| format!("failed to read stages: {err}"))?);
    }
    result.sort_by_key(|stage| {
        STAGES
            .iter()
            .position(|candidate| candidate == &stage.stage)
            .unwrap_or(STAGES.len())
    });
    Ok(result)
}

pub(super) fn list_artifacts_conn(
    conn: &Connection,
    project_id: &str,
) -> Result<Vec<ResearchArtifact>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, stage, kind, title, path, version, status, created_at \
             FROM project_artifacts WHERE project_id = ?1 ORDER BY created_at DESC",
        )
        .map_err(|err| format!("failed to prepare artifact list: {err}"))?;
    let rows = stmt
        .query_map(params![project_id], |row| {
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
        })
        .map_err(|err| format!("failed to query artifacts: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("failed to read artifacts: {err}"))
}

pub(super) fn detail_conn(conn: &Connection, project_id: &str) -> Result<ProjectDetail, String> {
    let project = get_project_conn(conn, project_id)?
        .ok_or_else(|| format!("研究项目不存在：{project_id}"))?;
    Ok(ProjectDetail {
        stages: list_stages_conn(conn, project_id)?,
        artifacts: list_artifacts_conn(conn, project_id)?,
        project,
    })
}

pub(super) fn record_event_conn(
    conn: &Connection,
    project_id: &str,
    actor: &str,
    kind: &str,
    payload_json: &str,
) {
    // The event stream is audit-only: a failed append must never fail the
    // business write that preceded it.
    let _ = conn.execute(
        "INSERT INTO project_events(project_id, ts, actor, type, payload_json) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![project_id, now_secs(), actor, kind, payload_json],
    );
}
