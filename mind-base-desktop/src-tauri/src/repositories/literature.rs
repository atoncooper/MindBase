//! 文献库（literature_refs / citations）与文献事件 SQL。
//!
//! ParsedRef / CrossrefMeta 是 workspace::literature 的解析中间类型；
//! 本文件只负责落库，解析与联网核验仍留在 workspace::literature。

use rusqlite::{params, Connection};

use super::{execute, query_all, query_optional, RepoError, RepoResult};
use crate::infra::db;
use crate::workspace::literature::{CrossrefMeta, LiteratureRef, ParsedRef};

/// 查询列顺序必须与 row_to_ref 的索引一一对应（type 是 SQL 关键字，需加引号）。
const LIT_COLS: &str =
    "id, cite_key, doi, title, authors_json, year, venue, \"type\", url, status, note";

/// 存储层的状态字面量（与 workspace::literature::types 的常量保持同值）。
const STATUS_UNVERIFIED: &str = "unverified";
const STATUS_VERIFIED: &str = "verified";

fn row_to_ref(row: &rusqlite::Row<'_>) -> rusqlite::Result<LiteratureRef> {
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

/// 研究项目是否存在（文献写入前的前置校验，业务层负责报错文案）。
pub(crate) fn project_exists(conn: &Connection, project_id: &str) -> RepoResult<bool> {
    let hit = query_optional(
        conn,
        "SELECT 1 FROM research_projects WHERE id = ?1",
        params![project_id],
        |_| Ok(()),
    )?;
    Ok(hit.is_some())
}

/// 项目文献列表（导入时间倒序）。
pub(crate) fn list_refs_conn(
    conn: &Connection,
    project_id: &str,
) -> RepoResult<Vec<LiteratureRef>> {
    query_all(
        conn,
        &format!(
            "SELECT {LIT_COLS} FROM literature_refs WHERE project_id = ?1 \
             ORDER BY created_at DESC, rowid DESC"
        ),
        params![project_id],
        row_to_ref,
    )
}

/// 按 (project_id, id) 查一条文献。
pub(crate) fn get_ref_conn(
    conn: &Connection,
    project_id: &str,
    ref_id: &str,
) -> RepoResult<Option<LiteratureRef>> {
    query_optional(
        conn,
        &format!("SELECT {LIT_COLS} FROM literature_refs WHERE project_id = ?1 AND id = ?2"),
        params![project_id, ref_id],
        row_to_ref,
    )
}

/// 批量写入导入条目，返回（新写入数、重复跳过数、新行）。
///
/// cite_key 在项目内唯一：ON CONFLICT DO NOTHING 让重复导入保持幂等，
/// 而不是报错或覆盖已有记录（已有记录可能已被核验/批注）。
pub(crate) fn insert_parsed_conn(
    conn: &mut Connection,
    project_id: &str,
    parsed: Vec<ParsedRef>,
) -> RepoResult<(usize, usize, Vec<LiteratureRef>)> {
    let now = now_secs();
    let tx = conn
        .transaction()
        .map_err(|err| RepoError::new(format!("开启数据库事务失败：{err}")))?;
    let mut imported = 0usize;
    let mut skipped = 0usize;
    let mut refs: Vec<LiteratureRef> = Vec::new();

    for entry in parsed {
        let id = db::local_id();
        let authors_json =
            serde_json::to_string(&entry.authors).unwrap_or_else(|_| "[]".to_string());
        let csl_json = entry.csl.to_string();
        let changed = execute(
            &tx,
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
        )?;
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
        .map_err(|err| RepoError::new(format!("提交数据库事务失败：{err}")))?;
    Ok((imported, skipped, refs))
}

/// 删除文献，并级联清理 citations（该表没有外键约束，只能手动清）。
/// 幂等：目标不存在时也返回成功，避免前端重复点击报错。
pub(crate) fn delete_ref_conn(
    conn: &mut Connection,
    project_id: &str,
    ref_id: &str,
) -> RepoResult<()> {
    let tx = conn
        .transaction()
        .map_err(|err| RepoError::new(format!("开启数据库事务失败：{err}")))?;
    execute(
        &tx,
        "DELETE FROM citations WHERE project_id = ?1 AND ref_id = ?2",
        params![project_id, ref_id],
    )?;
    execute(
        &tx,
        "DELETE FROM literature_refs WHERE project_id = ?1 AND id = ?2",
        params![project_id, ref_id],
    )?;
    tx.commit()
        .map_err(|err| RepoError::new(format!("提交数据库事务失败：{err}")))?;
    Ok(())
}

/// 更新文献状态并回读（unverified / verified / missing）。
pub(crate) fn mark_status_conn(
    conn: &Connection,
    project_id: &str,
    ref_id: &str,
    status: &str,
) -> RepoResult<LiteratureRef> {
    execute(
        conn,
        "UPDATE literature_refs SET status = ?1 WHERE project_id = ?2 AND id = ?3",
        params![status, project_id, ref_id],
    )?;
    get_ref_conn(conn, project_id, ref_id)?
        .ok_or_else(|| RepoError::new(format!("文献不存在：{ref_id}")))
}

/// 用 Crossref 元数据补全并置为 verified。只补空字段/以 Crossref 为准的字段：
/// title 采用 Crossref 的规范标题，DOI 仅在本地为空时回填（用户手填的 DOI 不覆盖）。
pub(crate) fn apply_verified_conn(
    conn: &Connection,
    project_id: &str,
    ref_id: &str,
    existing: &LiteratureRef,
    meta: &CrossrefMeta,
) -> RepoResult<LiteratureRef> {
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

    execute(
        conn,
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
    )?;
    get_ref_conn(conn, project_id, ref_id)?
        .ok_or_else(|| RepoError::new(format!("文献不存在：{ref_id}")))
}

/// 写项目事件（时间线）。审计属于旁路：写失败不影响主流程（调用方忽略返回值）。
pub(crate) fn record_event_conn(
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

/// DOCX 导出 payload 需要的参考文献子集。
#[derive(Debug, Clone)]
pub(crate) struct ReferenceRow {
    pub title: String,
    pub authors_json: String,
    pub year: Option<i64>,
    pub venue: String,
    pub doi: String,
}

/// 项目参考文献（按导入时间正序，DOCX 导出用）。
pub(crate) fn references_for_export(
    conn: &Connection,
    project_id: &str,
) -> RepoResult<Vec<ReferenceRow>> {
    query_all(
        conn,
        "SELECT title, authors_json, year, venue, doi FROM literature_refs \
         WHERE project_id = ?1 ORDER BY created_at ASC",
        params![project_id],
        |row| {
            Ok(ReferenceRow {
                title: row.get(0)?,
                authors_json: row.get(1)?,
                year: row.get(2)?,
                venue: row.get(3)?,
                doi: row.get(4)?,
            })
        },
    )
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|delta| delta.as_secs() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::literature::ParsedRef;

    #[test]
    fn duplicate_cite_keys_are_skipped() {
        let mut conn = crate::repositories::manuscript::open_test_connection();

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
