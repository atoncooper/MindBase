//! `literature_refs` / `citations` / `project_events` SQL access (all SQL lives here).

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::infra::db;

use super::types::{CrossrefMeta, LiteratureRef, ParsedRef, STATUS_UNVERIFIED, STATUS_VERIFIED};
use super::util::now_secs;

/// 查询列顺序必须与 `row_to_ref` 的索引一一对应（type 是 SQL 关键字，需加引号）。
const LIT_COLS: &str =
    "id, cite_key, doi, title, authors_json, year, venue, \"type\", url, status, note";

// ---------------------------------------------------------------------------
// 行映射与数据访问
// ---------------------------------------------------------------------------

fn row_to_ref(row: &Row<'_>) -> rusqlite::Result<LiteratureRef> {
    Ok(LiteratureRef {
        id: row.get(0)?,
        cite_key: row.get(1)?,
        doi: row.get(2)?,
        title: row.get(3)?,
        authors_json: row.get(4)?,
        year: row.get(5)?,
        venue: row.get(6)?,
        entry_type: row.get(7)?,
        url: row.get(8)?,
        status: row.get(9)?,
        note: row.get(10)?,
    })
}

pub(super) fn project_exists(conn: &Connection, project_id: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM research_projects WHERE id = ?1",
        params![project_id],
        |_| Ok(()),
    )
    .optional()
    .map(|hit| hit.is_some())
    .map_err(|err| format!("读取研究项目失败：{err}"))
}

pub(super) fn list_refs_conn(conn: &Connection, project_id: &str) -> Result<Vec<LiteratureRef>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {LIT_COLS} FROM literature_refs WHERE project_id = ?1 \
             ORDER BY created_at DESC, rowid DESC"
        ))
        .map_err(|err| format!("准备文献查询失败：{err}"))?;
    let rows = stmt
        .query_map(params![project_id], row_to_ref)
        .map_err(|err| format!("查询文献失败：{err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("读取文献失败：{err}"))
}

pub(super) fn get_ref_conn(
    conn: &Connection,
    project_id: &str,
    ref_id: &str,
) -> Result<Option<LiteratureRef>, String> {
    conn.query_row(
        &format!("SELECT {LIT_COLS} FROM literature_refs WHERE project_id = ?1 AND id = ?2"),
        params![project_id, ref_id],
        row_to_ref,
    )
    .optional()
    .map_err(|err| format!("读取文献失败：{err}"))
}

/// 批量写入导入条目，返回（新写入数、重复跳过数、新行）。
///
/// cite_key 在项目内唯一：ON CONFLICT DO NOTHING 让重复导入保持幂等，
/// 而不是报错或覆盖已有记录（已有记录可能已被核验/批注）。
pub(super) fn insert_parsed_conn(
    conn: &mut Connection,
    project_id: &str,
    parsed: Vec<ParsedRef>,
) -> Result<(usize, usize, Vec<LiteratureRef>), String> {
    let now = now_secs();
    let tx = conn
        .transaction()
        .map_err(|err| format!("开启数据库事务失败：{err}"))?;
    let mut imported = 0usize;
    let mut skipped = 0usize;
    let mut refs: Vec<LiteratureRef> = Vec::new();

    for entry in parsed {
        let id = db::local_id();
        let authors_json =
            serde_json::to_string(&entry.authors).unwrap_or_else(|_| "[]".to_string());
        let csl_json = entry.csl.to_string();
        let changed = tx
            .execute(
                "INSERT INTO literature_refs(
                     id, project_id, cite_key, doi, title, authors_json, year, venue,
                     \"type\", url, status, csl_json, note, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'unverified', ?11, '', ?12)
                 ON CONFLICT(project_id, cite_key) DO NOTHING",
                params![
                    id,
                    project_id,
                    entry.cite_key,
                    entry.doi,
                    entry.title,
                    authors_json,
                    entry.year,
                    entry.venue,
                    entry.entry_type,
                    entry.url,
                    csl_json,
                    now,
                ],
            )
            .map_err(|err| format!("写入文献失败：{err}"))?;
        if changed == 0 {
            skipped += 1;
            continue;
        }
        imported += 1;
        refs.push(LiteratureRef {
            id,
            cite_key: entry.cite_key,
            doi: entry.doi,
            title: entry.title,
            authors_json,
            year: entry.year,
            venue: entry.venue,
            entry_type: entry.entry_type,
            url: entry.url,
            status: STATUS_UNVERIFIED.to_string(),
            note: String::new(),
        });
    }

    tx.commit()
        .map_err(|err| format!("提交数据库事务失败：{err}"))?;
    Ok((imported, skipped, refs))
}

/// 删除文献，并级联清理 citations（该表没有外键约束，只能手动清）。
/// 幂等：目标不存在时也返回成功，避免前端重复点击报错。
pub(super) fn delete_ref_conn(conn: &mut Connection, project_id: &str, ref_id: &str) -> Result<(), String> {
    let tx = conn
        .transaction()
        .map_err(|err| format!("开启数据库事务失败：{err}"))?;
    tx.execute(
        "DELETE FROM citations WHERE project_id = ?1 AND ref_id = ?2",
        params![project_id, ref_id],
    )
    .map_err(|err| format!("清理文献引用失败：{err}"))?;
    tx.execute(
        "DELETE FROM literature_refs WHERE project_id = ?1 AND id = ?2",
        params![project_id, ref_id],
    )
    .map_err(|err| format!("删除文献失败：{err}"))?;
    tx.commit()
        .map_err(|err| format!("提交数据库事务失败：{err}"))?;
    Ok(())
}

pub(super) fn mark_status_conn(
    conn: &Connection,
    project_id: &str,
    ref_id: &str,
    status: &str,
) -> Result<LiteratureRef, String> {
    conn.execute(
        "UPDATE literature_refs SET status = ?1 WHERE project_id = ?2 AND id = ?3",
        params![status, project_id, ref_id],
    )
    .map_err(|err| format!("更新文献状态失败：{err}"))?;
    get_ref_conn(conn, project_id, ref_id)?.ok_or_else(|| format!("文献不存在：{ref_id}"))
}

/// 用 Crossref 元数据补全并置为 verified。只补空字段/以 Crossref 为准的字段：
/// title 采用 Crossref 的规范标题，DOI 仅在本地为空时回填（用户手填的 DOI 不覆盖）。
pub(super) fn apply_verified_conn(
    conn: &Connection,
    project_id: &str,
    ref_id: &str,
    existing: &LiteratureRef,
    meta: &CrossrefMeta,
) -> Result<LiteratureRef, String> {
    let title = if meta.title.trim().is_empty() {
        existing.title.clone()
    } else {
        meta.title.trim().to_string()
    };
    let venue = if meta.venue.trim().is_empty() {
        existing.venue.clone()
    } else {
        meta.venue.trim().to_string()
    };
    let url = if meta.url.trim().is_empty() {
        existing.url.clone()
    } else {
        meta.url.trim().to_string()
    };
    let doi = if existing.doi.trim().is_empty() {
        meta.doi.trim().to_string()
    } else {
        existing.doi.trim().to_string()
    };
    let year = meta.year.or(existing.year);

    conn.execute(
        "UPDATE literature_refs SET status = ?1, title = ?2, year = ?3, venue = ?4, url = ?5, \
             doi = ?6 WHERE project_id = ?7 AND id = ?8",
        params![
            STATUS_VERIFIED,
            title,
            year,
            venue,
            url,
            doi,
            project_id,
            ref_id
        ],
    )
    .map_err(|err| format!("更新文献核验结果失败：{err}"))?;
    get_ref_conn(conn, project_id, ref_id)?.ok_or_else(|| format!("文献不存在：{ref_id}"))
}

/// 写项目事件（时间线）。审计属于旁路：写失败不影响主流程。
pub(super) fn record_event_conn(conn: &Connection, project_id: &str, kind: &str, payload_json: &str) {
    let _ = conn.execute(
        "INSERT INTO project_events(project_id, ts, actor, type, payload_json) \
         VALUES (?1, ?2, 'user', ?3, ?4)",
        params![project_id, now_secs(), kind, payload_json],
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn duplicate_cite_keys_are_skipped() {
        let mut conn = Connection::open_in_memory().expect("内存数据库");
        conn.execute_batch(crate::infra::db::SCHEMA_SQL).expect("建表");

        let entry = ParsedRef {
            cite_key: "smith2020study".to_string(),
            title: "A Study of Things".to_string(),
            entry_type: "article-journal".to_string(),
            year: Some(2020),
            ..Default::default()
        };
        let (imported, skipped, refs) =
            insert_parsed_conn(&mut conn, "project-1", vec![entry.clone()]).expect("首次导入");
        assert_eq!((imported, skipped, refs.len()), (1, 0, 1));

        // 同一批次里的重复 + 与库内已有键重复，都应被跳过（导入幂等）。
        let (imported, skipped, refs) =
            insert_parsed_conn(&mut conn, "project-1", vec![entry.clone(), entry])
                .expect("重复导入");
        assert_eq!((imported, skipped, refs.len()), (0, 2, 0));

        // 换一个项目则不受唯一约束影响。
        let duplicate = ParsedRef {
            cite_key: "smith2020study".to_string(),
            title: "A Study of Things".to_string(),
            entry_type: "article-journal".to_string(),
            ..Default::default()
        };
        let (imported, skipped, _) =
            insert_parsed_conn(&mut conn, "project-2", vec![duplicate]).expect("跨项目导入");
        assert_eq!((imported, skipped), (1, 0));
    }
}
