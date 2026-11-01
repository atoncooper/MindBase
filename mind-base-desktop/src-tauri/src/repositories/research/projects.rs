//! 科研项目（research_projects）SQL。

use rusqlite::{params, Connection, Row};

use crate::repositories::{count, execute, query_all, query_optional, RepoResult};
use crate::workspace::research::ResearchProject;

const PROJECT_COLS: &str = "id, title, paper_kind, field, language, target_venue, \
                            current_stage, privacy, deadline, meta_json, created_at, updated_at";

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

/// 按 id 取项目（不存在返回 None，由 service 决定业务错误）。
pub(crate) fn find(conn: &Connection, id: &str) -> RepoResult<Option<ResearchProject>> {
    query_optional(
        conn,
        &format!("SELECT {PROJECT_COLS} FROM research_projects WHERE id = ?1"),
        params![id],
        project_from_row,
    )
}

/// 全部项目，按最近更新倒序。
pub(crate) fn list(conn: &Connection) -> RepoResult<Vec<ResearchProject>> {
    query_all(
        conn,
        &format!("SELECT {PROJECT_COLS} FROM research_projects ORDER BY updated_at DESC"),
        [],
        project_from_row,
    )
}

pub(crate) fn exists(conn: &Connection, id: &str) -> RepoResult<bool> {
    Ok(count(
        conn,
        "SELECT COUNT(*) FROM research_projects WHERE id = ?1",
        params![id],
    )? > 0)
}

pub(crate) fn insert(conn: &Connection, project: &ResearchProject) -> RepoResult<()> {
    execute(
        conn,
        "INSERT INTO research_projects(\
             id, title, paper_kind, field, language, target_venue, current_stage, \
             privacy, deadline, meta_json, created_at, updated_at\
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            project.id,
            project.title,
            project.paper_kind,
            project.field,
            project.language,
            project.target_venue,
            project.current_stage,
            project.privacy,
            project.deadline,
            project.meta_json,
            project.created_at,
            project.updated_at,
        ],
    )?;
    Ok(())
}

/// 可更新的项目资料字段（不含当前阶段与创建时间）。
pub(crate) struct ProjectProfile<'a> {
    pub title: &'a str,
    pub paper_kind: &'a str,
    pub field: &'a str,
    pub language: &'a str,
    pub target_venue: &'a str,
    pub privacy: &'a str,
    pub deadline: &'a str,
    pub meta_json: &'a str,
    pub updated_at: i64,
}

pub(crate) fn update_profile(
    conn: &Connection,
    id: &str,
    profile: &ProjectProfile<'_>,
) -> RepoResult<usize> {
    execute(
        conn,
        "UPDATE research_projects SET title = ?2, paper_kind = ?3, field = ?4, language = ?5, \
             target_venue = ?6, privacy = ?7, deadline = ?8, meta_json = ?9, updated_at = ?10 \
         WHERE id = ?1",
        params![
            id,
            profile.title,
            profile.paper_kind,
            profile.field,
            profile.language,
            profile.target_venue,
            profile.privacy,
            profile.deadline,
            profile.meta_json,
            profile.updated_at,
        ],
    )
}

/// 只更新 meta_json（研究计划等结构化扩展字段；保留调用方传入的完整 JSON）。
pub(crate) fn set_meta_json(
    conn: &Connection,
    id: &str,
    meta_json: &str,
    now: i64,
) -> RepoResult<usize> {
    execute(
        conn,
        "UPDATE research_projects SET meta_json = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, meta_json, now],
    )
}

/// 只刷新 updated_at（产物/阶段等子表变更后标记项目活跃）。
pub(crate) fn touch(conn: &Connection, id: &str, now: i64) -> RepoResult<usize> {
    execute(
        conn,
        "UPDATE research_projects SET updated_at = ?2 WHERE id = ?1",
        params![id, now],
    )
}

/// 切换项目当前阶段并刷新 updated_at（stage active 时由 service 调用）。
pub(crate) fn set_current_stage(
    conn: &Connection,
    id: &str,
    stage: &str,
    now: i64,
) -> RepoResult<usize> {
    execute(
        conn,
        "UPDATE research_projects SET current_stage = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, stage, now],
    )
}
