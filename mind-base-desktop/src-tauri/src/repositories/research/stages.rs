//! 科研阶段（research_stages）SQL。

use rusqlite::{params, Connection, Row};

use crate::repositories::{count, execute, query_all, query_optional, RepoResult};

/// 阶段原始行（不含展示用 label；DTO 由 service 组装）。
#[derive(Debug, Clone)]
pub(crate) struct StageRow {
    pub stage: String,
    pub status: String,
    pub entered_at: Option<i64>,
    pub approved_at: Option<i64>,
    pub gate_json: String,
}

fn stage_from_row(row: &Row<'_>) -> rusqlite::Result<StageRow> {
    Ok(StageRow {
        stage: row.get(0)?,
        status: row.get(1)?,
        entered_at: row.get(2)?,
        approved_at: row.get(3)?,
        gate_json: row.get(4)?,
    })
}

pub(crate) fn list(conn: &Connection, project_id: &str) -> RepoResult<Vec<StageRow>> {
    query_all(
        conn,
        "SELECT stage, status, entered_at, approved_at, gate_json \
         FROM research_stages WHERE project_id = ?1",
        params![project_id],
        stage_from_row,
    )
}

pub(crate) fn status(
    conn: &Connection,
    project_id: &str,
    stage: &str,
) -> RepoResult<Option<String>> {
    query_optional(
        conn,
        "SELECT status FROM research_stages WHERE project_id = ?1 AND stage = ?2",
        params![project_id, stage],
        |row| row.get(0),
    )
}

pub(crate) fn insert(
    conn: &Connection,
    project_id: &str,
    stage: &str,
    status: &str,
    entered_at: Option<i64>,
    gate_json: &str,
) -> RepoResult<usize> {
    execute(
        conn,
        "INSERT INTO research_stages(project_id, stage, status, entered_at, approved_at, gate_json) \
         VALUES (?1, ?2, ?3, ?4, NULL, ?5)",
        params![project_id, stage, status, entered_at, gate_json],
    )
}

/// 更新阶段状态；entered_at / approved_at / gate_json 为 None 时保留原值。
pub(crate) fn set_status(
    conn: &Connection,
    project_id: &str,
    stage: &str,
    status: &str,
    entered_at: Option<i64>,
    approved_at: Option<i64>,
    gate_json: Option<&str>,
) -> RepoResult<usize> {
    execute(
        conn,
        "UPDATE research_stages SET status = ?3, \
             entered_at = COALESCE(?4, entered_at), \
             approved_at = COALESCE(?5, approved_at), \
             gate_json = COALESCE(?6, gate_json) \
         WHERE project_id = ?1 AND stage = ?2",
        params![project_id, stage, status, entered_at, approved_at, gate_json],
    )
}

/// 把其它 active 阶段置为 submitted（单 active 不变式的一半）。
pub(crate) fn pause_others(
    conn: &Connection,
    project_id: &str,
    keep_stage: &str,
) -> RepoResult<usize> {
    execute(
        conn,
        "UPDATE research_stages SET status = 'submitted' \
         WHERE project_id = ?1 AND stage <> ?2 AND status = 'active'",
        params![project_id, keep_stage],
    )
}

/// 读取某阶段当前的 gate_json（不存在返回 None）。
pub(crate) fn gate(
    conn: &Connection,
    project_id: &str,
    stage: &str,
) -> RepoResult<Option<String>> {
    query_optional(
        conn,
        "SELECT gate_json FROM research_stages WHERE project_id = ?1 AND stage = ?2",
        params![project_id, stage],
        |row| row.get(0),
    )
}

pub(crate) fn set_gate(
    conn: &Connection,
    project_id: &str,
    stage: &str,
    gate_json: &str,
) -> RepoResult<usize> {
    execute(
        conn,
        "UPDATE research_stages SET gate_json = ?3 WHERE project_id = ?1 AND stage = ?2",
        params![project_id, stage, gate_json],
    )
}

#[allow(dead_code)] // 契约 API：供单 active 不变式的自检/后续流程编排使用。
pub(crate) fn count_other_active(
    conn: &Connection,
    project_id: &str,
    except_stage: &str,
) -> RepoResult<i64> {
    count(
        conn,
        "SELECT COUNT(*) FROM research_stages \
         WHERE project_id = ?1 AND stage <> ?2 AND status = 'active'",
        params![project_id, except_stage],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repositories::research::projects;
    use crate::workspace::research::ResearchProject;

    fn seed_project(conn: &Connection) -> String {
        let project_id = "stages-test".to_string();
        let project = ResearchProject {
            id: project_id.clone(),
            title: "测试项目".to_string(),
            paper_kind: "journal".to_string(),
            field: String::new(),
            language: "zh".to_string(),
            target_venue: String::new(),
            current_stage: "topic".to_string(),
            privacy: "local".to_string(),
            deadline: String::new(),
            meta_json: "{}".to_string(),
            created_at: 1,
            updated_at: 1,
        };
        projects::insert(conn, &project).expect("insert project");
        for (index, stage) in ["topic", "design", "advise", "experiment", "writing", "submission"]
            .iter()
            .enumerate()
        {
            let status = if index == 0 { "active" } else { "locked" };
            insert(conn, &project_id, stage, status, None, "[]").expect("insert stage");
        }
        project_id
    }

    #[test]
    fn set_gate_updates_json_and_reports_rows() {
        let conn = Connection::open_in_memory().expect("open in-memory sqlite");
        conn.execute_batch(crate::infra::db::SCHEMA_SQL)
            .expect("apply schema");
        let project_id = seed_project(&conn);
        let gate = r#"{"checks":{"problem":true}}"#;

        assert_eq!(
            set_gate(&conn, &project_id, "topic", gate).expect("update gate"),
            1
        );
        let rows = list(&conn, &project_id).expect("list stages");
        let topic = rows
            .iter()
            .find(|row| row.stage == "topic")
            .expect("topic stage");
        assert_eq!(topic.gate_json, gate);

        // 未知阶段 / 未知项目：0 行受影响，由 service 转成业务错误。
        assert_eq!(
            set_gate(&conn, &project_id, "no-such-stage", "{}").expect("unknown stage rows"),
            0
        );
        assert_eq!(
            set_gate(&conn, "no-such-project", "topic", "{}").expect("unknown project rows"),
            0
        );
        assert_eq!(
            count_other_active(&conn, &project_id, "topic").expect("count other active"),
            0
        );
    }
}
