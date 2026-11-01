//! 写作文档（manuscript_documents）与章节（manuscript_sections）SQL。
//!
//! 写作从「单篇稿件」升级为「文档类型 + 每类独立章节/导出」：一个项目下可以有
//! 多份文档（开题报告 / 初稿 / 修改稿 / 投稿信 / 自定义），章节通过 document_id
//! 归属到文档。章节正文落在 path 指向的 .md 文件里，本表只存元数据；项目元信息、
//! 项目 touch 与导出产物登记也放在这里（DOCX / LaTeX 两条导出链路共用）。

use rusqlite::{params, Connection};

use super::{execute, query_all, query_one, query_optional, RepoError, RepoResult};
use crate::infra::db;

// ---------------------------------------------------------------------------
// 文档
// ---------------------------------------------------------------------------

/// manuscript_documents 一行（完整行映射；部分字段供后续命令/agent 使用）。
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub(crate) struct DocumentRow {
    pub id: String,
    pub project_id: String,
    pub kind: String,
    pub title: String,
    /// 导入的原始文件（项目根内相对路径；空串=非导入文档）。
    pub source_path: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 文档列表行：按文档聚合章节数与字数。
#[derive(Debug, Clone)]
pub(crate) struct DocumentSummaryRow {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub section_count: i64,
    pub words: i64,
    pub updated_at: i64,
    /// 导入的原始文件（项目根内相对路径；空串=非导入文档）。
    pub source_path: String,
}

const DOCUMENT_COLS: &str = "id, project_id, kind, title, source_path, created_at, updated_at";

fn row_to_document(row: &rusqlite::Row<'_>) -> rusqlite::Result<DocumentRow> {
    Ok(DocumentRow {
        id: row.get(0)?,
        project_id: row.get(1)?,
        kind: row.get(2)?,
        title: row.get(3)?,
        source_path: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

/// 项目文档列表（最近更新的在前），带章节数 / 字数。
pub(crate) fn documents_list(
    conn: &Connection,
    project_id: &str,
) -> RepoResult<Vec<DocumentSummaryRow>> {
    query_all(
        conn,
        "SELECT d.id, d.kind, d.title,
                COUNT(s.id) AS section_count,
                COALESCE(SUM(s.words), 0) AS words,
                d.updated_at, d.source_path
         FROM manuscript_documents d
         LEFT JOIN manuscript_sections s
                ON s.project_id = d.project_id AND s.document_id = d.id
         WHERE d.project_id = ?1
         GROUP BY d.id, d.kind, d.title, d.source_path, d.created_at, d.updated_at, d.rowid
         ORDER BY d.updated_at DESC, d.created_at DESC, d.rowid DESC",
        params![project_id],
        |row| {
            Ok(DocumentSummaryRow {
                id: row.get(0)?,
                kind: row.get(1)?,
                title: row.get(2)?,
                section_count: row.get(3)?,
                words: row.get(4)?,
                updated_at: row.get(5)?,
                source_path: row.get(6)?,
            })
        },
    )
}

/// 按 (project_id, id) 查文档。
pub(crate) fn documents_find(
    conn: &Connection,
    project_id: &str,
    document_id: &str,
) -> RepoResult<Option<DocumentRow>> {
    query_optional(
        conn,
        &format!(
            "SELECT {DOCUMENT_COLS} FROM manuscript_documents \
             WHERE project_id = ?1 AND id = ?2"
        ),
        params![project_id, document_id],
        row_to_document,
    )
}

/// 项目最近更新的文档（agent 缺省 document_id 时使用）。
pub(crate) fn documents_latest(
    conn: &Connection,
    project_id: &str,
) -> RepoResult<Option<DocumentRow>> {
    query_optional(
        conn,
        &format!(
            "SELECT {DOCUMENT_COLS} FROM manuscript_documents \
             WHERE project_id = ?1 ORDER BY updated_at DESC, created_at DESC, rowid DESC LIMIT 1"
        ),
        params![project_id],
        row_to_document,
    )
}

/// 新建文档（id / 时间由业务层生成）。
#[allow(clippy::too_many_arguments)]
pub(crate) fn documents_insert(
    conn: &Connection,
    id: &str,
    project_id: &str,
    kind: &str,
    title: &str,
    created_at: i64,
    updated_at: i64,
) -> RepoResult<usize> {
    execute(
        conn,
        "INSERT INTO manuscript_documents(id, project_id, kind, title, source_path, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, '', ?5, ?6)",
        params![id, project_id, kind, title, created_at, updated_at],
    )
}

/// 重命名文档并触碰更新时间。
pub(crate) fn documents_update_title(
    conn: &Connection,
    project_id: &str,
    document_id: &str,
    title: &str,
    now: i64,
) -> RepoResult<usize> {
    execute(
        conn,
        "UPDATE manuscript_documents SET title = ?3, updated_at = ?4 \
         WHERE project_id = ?1 AND id = ?2",
        params![project_id, document_id, title, now],
    )
}

/// 记录导入文档的原始文件路径（项目根内相对路径；空串=清除）。
pub(crate) fn documents_set_source(
    conn: &Connection,
    project_id: &str,
    document_id: &str,
    source_path: &str,
    now: i64,
) -> RepoResult<usize> {
    execute(
        conn,
        "UPDATE manuscript_documents SET source_path = ?3, updated_at = ?4 \
         WHERE project_id = ?1 AND id = ?2",
        params![project_id, document_id, source_path, now],
    )
}

/// 触碰文档更新时间（章节保存后，文档列表据此排序）。
pub(crate) fn documents_touch(
    conn: &Connection,
    project_id: &str,
    document_id: &str,
    now: i64,
) -> RepoResult<usize> {
    execute(
        conn,
        "UPDATE manuscript_documents SET updated_at = ?3 WHERE project_id = ?1 AND id = ?2",
        params![project_id, document_id, now],
    )
}

/// 删除文档并级联删除它的章节行（章节正文文件保留，旧路径继续可读）。
pub(crate) fn documents_delete(
    conn: &mut Connection,
    project_id: &str,
    document_id: &str,
) -> RepoResult<usize> {
    let tx = conn
        .transaction()
        .map_err(|err| RepoError::new(format!("开启数据库事务失败：{err}")))?;
    execute(
        &tx,
        "DELETE FROM manuscript_sections WHERE project_id = ?1 AND document_id = ?2",
        params![project_id, document_id],
    )?;
    let removed = execute(
        &tx,
        "DELETE FROM manuscript_documents WHERE project_id = ?1 AND id = ?2",
        params![project_id, document_id],
    )?;
    tx.commit()
        .map_err(|err| RepoError::new(format!("提交数据库事务失败：{err}")))?;
    Ok(removed)
}

// ---------------------------------------------------------------------------
// 章节（document_id 维度）
// ---------------------------------------------------------------------------

/// manuscript_sections 一行（不含正文，正文由业务层按 path 读取）。
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub(crate) struct SectionRow {
    pub id: String,
    pub document_id: String,
    pub section: String,
    pub ord: i64,
    pub path: String,
    pub words: i64,
    pub status: String,
    pub updated_at: i64,
}

/// 查询列顺序必须与 row_to_section 的索引一一对应。
const SECTION_COLS: &str = "id, document_id, section, ord, path, words, status, updated_at";

fn row_to_section(row: &rusqlite::Row<'_>) -> rusqlite::Result<SectionRow> {
    Ok(SectionRow {
        id: row.get(0)?,
        document_id: row.get(1)?,
        section: row.get(2)?,
        ord: row.get(3)?,
        path: row.get(4)?,
        words: row.get(5)?,
        status: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

/// 文档章节列表（按 ord、更新时间升序）。
pub(crate) fn list(
    conn: &Connection,
    project_id: &str,
    document_id: &str,
) -> RepoResult<Vec<SectionRow>> {
    query_all(
        conn,
        &format!(
            "SELECT {SECTION_COLS} FROM manuscript_sections \
             WHERE project_id = ?1 AND document_id = ?2 ORDER BY ord ASC, updated_at ASC"
        ),
        params![project_id, document_id],
        row_to_section,
    )
}

/// 按 (project_id, document_id, section) 查章节（章节名在文档内唯一）。
pub(crate) fn find(
    conn: &Connection,
    project_id: &str,
    document_id: &str,
    section: &str,
) -> RepoResult<Option<SectionRow>> {
    query_optional(
        conn,
        &format!(
            "SELECT {SECTION_COLS} FROM manuscript_sections \
             WHERE project_id = ?1 AND document_id = ?2 AND section = ?3"
        ),
        params![project_id, document_id, section],
        row_to_section,
    )
}

/// 按主键查章节（保存后回读用）。
pub(crate) fn find_by_id(conn: &Connection, id: &str) -> RepoResult<Option<SectionRow>> {
    query_optional(
        conn,
        &format!("SELECT {SECTION_COLS} FROM manuscript_sections WHERE id = ?1"),
        params![id],
        row_to_section,
    )
}

/// 新建章节（path 初始为空，正文落盘后再 set_path）。
#[allow(clippy::too_many_arguments)]
pub(crate) fn insert(
    conn: &Connection,
    id: &str,
    project_id: &str,
    document_id: &str,
    section: &str,
    ord: i64,
    words: i64,
    status: &str,
    updated_at: i64,
) -> RepoResult<usize> {
    execute(
        conn,
        "INSERT INTO manuscript_sections(
             id, project_id, document_id, section, ord, path, words, status, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, '', ?6, ?7, ?8)",
        params![
            id,
            project_id,
            document_id,
            section,
            ord,
            words,
            status,
            updated_at
        ],
    )
}

/// 更新已有章节正文的元数据（字数 / 状态 / 时间）。
pub(crate) fn update_body(
    conn: &Connection,
    project_id: &str,
    document_id: &str,
    section: &str,
    words: i64,
    updated_at: i64,
) -> RepoResult<usize> {
    execute(
        conn,
        "UPDATE manuscript_sections SET words = ?4, status = 'draft', updated_at = ?5 \
         WHERE project_id = ?1 AND document_id = ?2 AND section = ?3",
        params![project_id, document_id, section, words, updated_at],
    )
}

/// 记录章节正文文件路径。
pub(crate) fn set_path(conn: &Connection, id: &str, path: &str) -> RepoResult<usize> {
    execute(
        conn,
        "UPDATE manuscript_sections SET path = ?2 WHERE id = ?1",
        params![id, path],
    )
}

/// 删除章节（不存在也视为成功，幂等）。
pub(crate) fn delete(
    conn: &Connection,
    project_id: &str,
    document_id: &str,
    section: &str,
) -> RepoResult<usize> {
    execute(
        conn,
        "DELETE FROM manuscript_sections \
         WHERE project_id = ?1 AND document_id = ?2 AND section = ?3",
        params![project_id, document_id, section],
    )
}

/// 导出用章节（标题, 正文文件路径, ord），按写入顺序。
pub(crate) fn export_sections(
    conn: &Connection,
    project_id: &str,
    document_id: &str,
) -> RepoResult<Vec<(String, String, i64)>> {
    query_all(
        conn,
        "SELECT section, path, ord FROM manuscript_sections \
         WHERE project_id = ?1 AND document_id = ?2 ORDER BY ord ASC, updated_at ASC",
        params![project_id, document_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )
}

/// 文档的章节数与总字数（文档列表统计 / 概览统计口径；供概览统计复用）。
#[allow(dead_code)]
pub(crate) fn count_and_words(
    conn: &Connection,
    project_id: &str,
    document_id: &str,
) -> RepoResult<(i64, i64)> {
    query_one(
        conn,
        "SELECT COUNT(*), COALESCE(SUM(words), 0) FROM manuscript_sections \
         WHERE project_id = ?1 AND document_id = ?2",
        params![project_id, document_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
}

// ---------------------------------------------------------------------------
// 写作导出共用的项目元信息 / 产物登记
// ---------------------------------------------------------------------------

/// 稿件导出需要的项目元信息（research_projects 子集；标题用文档 title）。
#[derive(Debug, Clone)]
pub(crate) struct ProjectMeta {
    pub paper_kind: String,
    pub target_venue: String,
}

/// 读取项目元信息；项目不存在返回 None（业务层决定报错文案）。
pub(crate) fn project_meta(conn: &Connection, project_id: &str) -> RepoResult<Option<ProjectMeta>> {
    query_optional(
        conn,
        "SELECT paper_kind, target_venue FROM research_projects WHERE id = ?1",
        params![project_id],
        |row| {
            Ok(ProjectMeta {
                paper_kind: row.get(0)?,
                target_venue: row.get(1)?,
            })
        },
    )
}

/// 触碰项目更新时间（写作/导出成功后记录活动时间）。
pub(crate) fn touch_project(conn: &Connection, project_id: &str, now: i64) -> RepoResult<usize> {
    execute(
        conn,
        "UPDATE research_projects SET updated_at = ?2 WHERE id = ?1",
        params![project_id, now],
    )
}

/// 把导出文件登记为写作产物（project_artifacts，stage=writing / kind=export）。
pub(crate) fn insert_export_artifact(
    conn: &Connection,
    project_id: &str,
    title: &str,
    path: &str,
    created_at: i64,
) -> RepoResult<usize> {
    execute(
        conn,
        "INSERT INTO project_artifacts(id, project_id, stage, kind, title, path, version, sha256, status, meta_json, created_at) \
         VALUES (?1, ?2, 'writing', 'export', ?3, ?4, 1, '', 'confirmed', '{}', ?5)",
        params![db::local_id(), project_id, title, path, created_at],
    )
}

// ---------------------------------------------------------------------------
// 测试辅助（仅测试编译；其它模块的单测可复用内存库 + schema）
// ---------------------------------------------------------------------------

#[cfg(test)]
pub(crate) fn open_test_connection() -> Connection {
    let conn = Connection::open_in_memory().expect("内存数据库");
    conn.execute_batch(crate::infra::db::SCHEMA_SQL)
        .expect("建表");
    conn
}

/// 测试用：直接插入一个 research_projects 行（生产写入属于 research repo）。
#[cfg(test)]
pub(crate) fn insert_project_for_test(
    conn: &Connection,
    id: &str,
    title: &str,
    stage: &str,
    now: i64,
) -> RepoResult<usize> {
    execute(
        conn,
        "INSERT INTO research_projects(id, title, current_stage, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?4)",
        params![id, title, stage, now],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed() -> Connection {
        let conn = open_test_connection();
        insert_project_for_test(&conn, "project-1", "测试项目", "writing", 1_000)
            .expect("insert project");
        conn
    }

    fn insert_document(conn: &Connection, id: &str, kind: &str, title: &str, time: i64) {
        documents_insert(conn, id, "project-1", kind, title, time, time).expect("insert document");
    }

    #[test]
    fn documents_scope_sections_and_delete_cascades() {
        let mut conn = seed();
        insert_document(&conn, "doc-draft", "draft", "初稿", 1_000);
        insert_document(&conn, "doc-letter", "cover_letter", "投稿信", 1_000);

        insert(
            &conn,
            "sec-1",
            "project-1",
            "doc-draft",
            "摘要",
            0,
            10,
            "draft",
            1_000,
        )
        .expect("insert section");
        insert(
            &conn,
            "sec-2",
            "project-1",
            "doc-draft",
            "1 引言",
            1,
            20,
            "draft",
            1_000,
        )
        .expect("insert section");
        insert(
            &conn,
            "sec-3",
            "project-1",
            "doc-letter",
            "投稿信正文",
            0,
            5,
            "draft",
            1_000,
        )
        .expect("insert section");

        // 章节按文档隔离。
        assert_eq!(
            list(&conn, "project-1", "doc-draft")
                .expect("draft list")
                .len(),
            2
        );
        assert_eq!(
            list(&conn, "project-1", "doc-letter")
                .expect("letter list")
                .len(),
            1
        );
        assert!(find(&conn, "project-1", "doc-letter", "摘要")
            .expect("find")
            .is_none());
        assert_eq!(
            count_and_words(&conn, "project-1", "doc-draft").expect("count"),
            (2, 30)
        );

        // 文档列表聚合章节数与字数。
        let summaries = documents_list(&conn, "project-1").expect("documents");
        assert_eq!(summaries.len(), 2);
        let draft = summaries
            .iter()
            .find(|row| row.id == "doc-draft")
            .expect("draft summary");
        assert_eq!((draft.section_count, draft.words), (2, 30));
        let letter = summaries
            .iter()
            .find(|row| row.id == "doc-letter")
            .expect("letter summary");
        assert_eq!((letter.section_count, letter.words), (1, 5));

        // 删除文档级联删章节行，其它文档不受影响。
        assert_eq!(
            documents_delete(&mut conn, "project-1", "doc-draft").expect("delete"),
            1
        );
        assert!(documents_find(&conn, "project-1", "doc-draft")
            .expect("find deleted")
            .is_none());
        assert_eq!(
            list(&conn, "project-1", "doc-draft")
                .expect("orphan list")
                .len(),
            0
        );
        assert_eq!(
            list(&conn, "project-1", "doc-letter")
                .expect("letter list")
                .len(),
            1
        );
    }

    #[test]
    fn latest_document_prefers_most_recently_touched() {
        let conn = seed();
        insert_document(&conn, "doc-old", "draft", "初稿", 1_000);
        insert_document(&conn, "doc-new", "revision", "修改稿", 1_000);
        // 同秒创建时按 rowid 兜底；显式触碰 doc-old 验证时间优先。
        documents_touch(&conn, "project-1", "doc-old", 2_000).expect("touch");
        let latest = documents_latest(&conn, "project-1")
            .expect("latest")
            .expect("some document");
        assert_eq!(latest.id, "doc-old");
        assert_eq!(latest.kind, "draft");
        assert_eq!(latest.title, "初稿");
    }

    #[test]
    fn document_title_update_and_touch() {
        let conn = seed();
        insert_document(&conn, "doc-1", "proposal", "开题报告", 1_000);
        documents_update_title(&conn, "project-1", "doc-1", "开题报告（终版）", 2_000)
            .expect("rename");
        let document = documents_find(&conn, "project-1", "doc-1")
            .expect("find")
            .expect("document");
        assert_eq!(document.title, "开题报告（终版）");
        assert_eq!(document.updated_at, 2_000);
    }
}
