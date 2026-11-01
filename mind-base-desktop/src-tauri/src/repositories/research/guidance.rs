//! 阶段建议（guidance_notes）SQL。

use rusqlite::{params, Connection, Row};

use crate::repositories::{count as count_rows, execute, query_all, query_optional, RepoResult};
use crate::workspace::research::ResearchAdvice;

/// questions_json 里取第一个问题（无则空串），与前端展示口径一致。
fn first_question(questions_json: &str) -> String {
    serde_json::from_str::<Vec<String>>(questions_json)
        .ok()
        .and_then(|items| items.into_iter().next())
        .unwrap_or_default()
}

fn advice_from_row(row: &Row<'_>) -> rusqlite::Result<ResearchAdvice> {
    let questions: String = row.get(0)?;
    Ok(ResearchAdvice {
        question: first_question(&questions),
        notes: row.get(1)?,
        created_at: row.get(2)?,
    })
}

pub(crate) fn insert(
    conn: &Connection,
    id: &str,
    project_id: &str,
    questions_json: &str,
    notes: &str,
    created_at: i64,
) -> RepoResult<usize> {
    execute(
        conn,
        "INSERT INTO guidance_notes(id, project_id, session_date, questions_json, notes, created_at) \
         VALUES (?1, ?2, '', ?3, ?4, ?5)",
        params![id, project_id, questions_json, notes, created_at],
    )
}

pub(crate) fn latest(
    conn: &Connection,
    project_id: &str,
) -> RepoResult<Option<ResearchAdvice>> {
    query_optional(
        conn,
        "SELECT questions_json, notes, created_at FROM guidance_notes \
         WHERE project_id = ?1 ORDER BY created_at DESC LIMIT 1",
        params![project_id],
        advice_from_row,
    )
}

/// 建议历史，按时间倒序（created_at 相同用 id 兜底）。
pub(crate) fn list(
    conn: &Connection,
    project_id: &str,
    limit: i64,
) -> RepoResult<Vec<ResearchAdvice>> {
    query_all(
        conn,
        "SELECT questions_json, notes, created_at FROM guidance_notes \
         WHERE project_id = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2",
        params![project_id, limit],
        advice_from_row,
    )
}

pub(crate) fn count(conn: &Connection, project_id: &str) -> RepoResult<i64> {
    count_rows(
        conn,
        "SELECT COUNT(*) FROM guidance_notes WHERE project_id = ?1",
        params![project_id],
    )
}
