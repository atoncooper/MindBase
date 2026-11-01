//! 项目事件流（project_events）SQL：追加、分组分页。

use rusqlite::{params, Connection, Row};

use crate::repositories::{execute, query_all, RepoResult};
use crate::workspace::research::{ResearchEvent, ResearchEventPage};

/// 追加一条审计事件（调用方决定 ts；业务失败是否影响流程由 service 决定）。
pub(crate) fn append(
    conn: &Connection,
    project_id: &str,
    actor: &str,
    kind: &str,
    payload_json: &str,
    ts: i64,
) -> RepoResult<usize> {
    execute(
        conn,
        "INSERT INTO project_events(project_id, ts, actor, type, payload_json) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![project_id, ts, actor, kind, payload_json],
    )
}

const PAGE_SQL: &str = "WITH ordered AS (\
                 SELECT id, ts, actor, type, payload_json, ROW_NUMBER() OVER (ORDER BY id) AS rn \
                 FROM project_events WHERE project_id = ?1\
             ), marked AS (\
                 SELECT id, ts, actor, type, payload_json, \
                        CASE WHEN actor = LAG(actor) OVER (ORDER BY id) \
                              AND type = LAG(type) OVER (ORDER BY id) \
                              AND payload_json = LAG(payload_json) OVER (ORDER BY id) \
                             THEN 0 ELSE 1 END AS is_new \
                 FROM ordered\
             ), grouped AS (\
                 SELECT id, ts, actor, type, payload_json, \
                        SUM(is_new) OVER (ORDER BY id) AS grp \
                 FROM marked\
             )\
             SELECT MAX(id) AS id, MAX(ts) AS ts, MIN(ts) AS first_ts, \
                    actor, type, payload_json, COUNT(*) AS repeat \
             FROM grouped \
             GROUP BY grp, actor, type, payload_json \
             HAVING (?2 IS NULL OR MAX(id) < ?2) \
             ORDER BY MAX(id) DESC \
             LIMIT ?3";

fn event_from_row(row: &Row<'_>) -> rusqlite::Result<ResearchEvent> {
    Ok(ResearchEvent {
        id: row.get(0)?,
        ts: row.get(1)?,
        first_ts: row.get(2)?,
        actor: row.get(3)?,
        kind: row.get(4)?,
        payload_json: row.get(5)?,
        repeat: row.get(6)?,
    })
}

/// 事件流分页：以「连续相同事件分组」为单位，id 倒序游标。
///
/// 相邻且 (actor, type, payload_json) 相同的原始事件折叠成一行（repeat = 条数），
/// 否则历史里几十上百条重复的 stage.updated 会把第一页占满。分组内取 MAX(id)
/// 作为游标、MAX(ts) 作为最新时间、MIN(ts) 作为 first_ts；多取一条用于判定
/// has_more，再截断到 limit。
pub(crate) fn page(
    conn: &Connection,
    project_id: &str,
    limit: i64,
    before_id: Option<i64>,
) -> RepoResult<ResearchEventPage> {
    let fetch = limit.saturating_add(1);
    let mut events = query_all(
        conn,
        PAGE_SQL,
        params![project_id, before_id, fetch],
        event_from_row,
    )?;
    let has_more = events.len() as i64 > limit;
    events.truncate(limit.max(0) as usize);
    Ok(ResearchEventPage { events, has_more })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repositories::research::{projects, stages};
    use crate::workspace::research::ResearchProject;

    /// 内存库：1 个项目 + 6 个阶段 + 5 条不同 payload 的事件（id 1..=5）。
    fn seeded_conn() -> (Connection, String) {
        let conn = Connection::open_in_memory().expect("open in-memory sqlite");
        conn.execute_batch(crate::infra::db::SCHEMA_SQL)
            .expect("apply schema");
        let project_id = "research-test".to_string();
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
        projects::insert(&conn, &project).expect("insert project");
        for (index, stage) in ["topic", "design", "advise", "experiment", "writing", "submission"]
            .iter()
            .enumerate()
        {
            let status = if index == 0 { "active" } else { "locked" };
            stages::insert(&conn, &project_id, stage, status, None, "[]").expect("insert stage");
        }
        for index in 0..5 {
            let payload = serde_json::json!({"n": index}).to_string();
            append(&conn, &project_id, "user", "test.event", &payload, 1000 + index)
                .expect("insert project event");
        }
        (conn, project_id)
    }

    #[test]
    fn page_pages_backwards_with_id_cursor() {
        let (conn, project_id) = seeded_conn();

        let first = page(&conn, &project_id, 2, None).expect("first page");
        assert_eq!(first.events.len(), 2, "first page size");
        assert!(first.has_more, "first page must report more");
        assert_eq!(
            first.events.iter().map(|event| event.id).collect::<Vec<_>>(),
            vec![5, 4]
        );

        let cursor = first.events.last().map(|event| event.id);
        let second = page(&conn, &project_id, 2, cursor).expect("second page");
        assert_eq!(
            second.events.iter().map(|event| event.id).collect::<Vec<_>>(),
            vec![3, 2]
        );
        assert!(second.has_more, "second page must report more");

        let cursor = second.events.last().map(|event| event.id);
        let third = page(&conn, &project_id, 2, cursor).expect("third page");
        assert_eq!(third.events.len(), 1, "third page size");
        assert!(!third.has_more, "last page must not report more");
        assert_eq!(third.events[0].id, 1);
    }

    #[test]
    fn page_collapses_consecutive_identical_events() {
        let (conn, project_id) = seeded_conn();
        // 追加 3 条连续相同事件：分页单位是分组，应折叠成 1 组 repeat=3。
        let mut last_id = 5;
        for index in 0..3 {
            append(
                &conn,
                &project_id,
                "agent",
                "stage.updated",
                "{}",
                1010 + index,
            )
            .expect("insert repeated event");
            last_id += 1;
        }

        let grouped = page(&conn, &project_id, 10, None).expect("grouped page");
        assert!(!grouped.has_more, "all groups fit in one page");
        assert_eq!(grouped.events.len(), 6, "5 distinct + 1 collapsed group");

        let newest = &grouped.events[0];
        assert_eq!(newest.id, last_id, "group cursor is MAX(id)");
        assert_eq!(newest.repeat, 3, "consecutive identical events collapse");
        assert_eq!(newest.actor, "agent");
        assert_eq!(newest.kind, "stage.updated");
        assert_eq!(newest.payload_json, "{}");
        assert_eq!(newest.ts, 1012, "group ts is the newest event time");
        assert_eq!(newest.first_ts, 1010, "group first_ts is the earliest event time");

        // 原有 5 条不同 payload 的事件仍是 5 组、repeat 均为 1，顺序不变。
        assert_eq!(
            grouped.events[1..]
                .iter()
                .map(|event| event.id)
                .collect::<Vec<_>>(),
            vec![5, 4, 3, 2, 1]
        );
        assert!(
            grouped.events[1..].iter().all(|event| event.repeat == 1),
            "distinct payload events must not collapse"
        );
        assert!(
            grouped.events[1..]
                .iter()
                .all(|event| event.first_ts == event.ts),
            "single-event groups must have first_ts == ts"
        );

        // 游标用分组 MAX(id)：翻页从其余 5 组继续。
        let next = page(&conn, &project_id, 2, Some(newest.id)).expect("next page");
        assert_eq!(
            next.events.iter().map(|event| event.id).collect::<Vec<_>>(),
            vec![5, 4]
        );
        assert!(next.has_more, "next page must report more");
    }
}
