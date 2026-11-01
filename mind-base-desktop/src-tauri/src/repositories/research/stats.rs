//! 科研控制台「阶段资料」统计 + 助手简报只读摘要（跨表只读，不含业务校验）。

use rusqlite::{params, Connection, Row};

use crate::repositories::{count, query_all, query_one, RepoResult};
use crate::workspace::research::ResearchOverviewStats;

use super::{artifacts, guidance};

/// 阶段资料总览：各证据/稿件表按项目计数。
pub(crate) fn overview(
    conn: &Connection,
    project_id: &str,
) -> RepoResult<ResearchOverviewStats> {
    let literature_total = count(
        conn,
        "SELECT COUNT(*) FROM literature_refs WHERE project_id = ?1",
        params![project_id],
    )?;
    let literature_verified = count(
        conn,
        "SELECT COUNT(*) FROM literature_refs WHERE project_id = ?1 AND status = 'verified'",
        params![project_id],
    )?;
    let datasets = count(
        conn,
        "SELECT COUNT(*) FROM datasets WHERE project_id = ?1",
        params![project_id],
    )?;
    let experiments = count(
        conn,
        "SELECT COUNT(*) FROM experiment_runs WHERE project_id = ?1",
        params![project_id],
    )?;
    let artifacts = artifacts::count(conn, project_id)?;
    let (manuscript_sections, manuscript_words) = query_one(
        conn,
        "SELECT COUNT(*), COALESCE(SUM(words), 0) FROM manuscript_sections \
         WHERE project_id = ?1",
        params![project_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let advice_count = guidance::count(conn, project_id)?;
    Ok(ResearchOverviewStats {
        literature_total,
        literature_verified,
        datasets,
        experiments,
        artifacts,
        manuscript_sections,
        manuscript_words,
        advice_count,
    })
}

/// 简报用：最近导入的文献摘要（只读元数据，不读正文）。
#[derive(Debug)]
pub(crate) struct LiteratureBriefRow {
    pub title: String,
    pub year: Option<i64>,
    pub status: String,
    /// 发表期刊/会议（可能为空；用于论文目标期刊推荐）。
    pub venue: String,
}

pub(crate) fn recent_literature(
    conn: &Connection,
    project_id: &str,
    limit: i64,
) -> RepoResult<Vec<LiteratureBriefRow>> {
    query_all(
        conn,
        "SELECT title, year, status, venue FROM literature_refs WHERE project_id = ?1 \
         ORDER BY created_at DESC LIMIT ?2",
        params![project_id, limit],
        |row| {
            Ok(LiteratureBriefRow {
                title: row.get(0)?,
                year: row.get(1)?,
                status: row.get(2)?,
                venue: row.get(3)?,
            })
        },
    )
}

/// 简报用：最近数据集（只读画像摘要，不读原始行）。
#[derive(Debug)]
pub(crate) struct DatasetBriefRow {
    pub name: String,
    pub rows: Option<i64>,
    pub cols: Option<i64>,
    pub privacy: String,
}

pub(crate) fn recent_datasets(
    conn: &Connection,
    project_id: &str,
    limit: i64,
) -> RepoResult<Vec<DatasetBriefRow>> {
    query_all(
        conn,
        "SELECT name, rows, cols, privacy FROM datasets WHERE project_id = ?1 \
         ORDER BY created_at DESC LIMIT ?2",
        params![project_id, limit],
        |row| {
            Ok(DatasetBriefRow {
                name: row.get(0)?,
                rows: row.get(1)?,
                cols: row.get(2)?,
                privacy: row.get(3)?,
            })
        },
    )
}

/// 简报用：最近决策。
pub(crate) fn recent_decisions(
    conn: &Connection,
    project_id: &str,
    limit: i64,
) -> RepoResult<Vec<String>> {
    query_all(
        conn,
        "SELECT decision FROM decisions WHERE project_id = ?1 ORDER BY ts DESC LIMIT ?2",
        params![project_id, limit],
        |row: &Row<'_>| row.get(0),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repositories::research::projects;
    use crate::workspace::research::ResearchProject;

    fn seeded_conn() -> (Connection, String) {
        let conn = Connection::open_in_memory().expect("open in-memory sqlite");
        conn.execute_batch(crate::infra::db::SCHEMA_SQL)
            .expect("apply schema");
        let project_id = "stats-test".to_string();
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
        (conn, project_id)
    }

    #[test]
    fn overview_counts_project_rows() {
        let (conn, project_id) = seeded_conn();
        let now = 1_700_000_000_i64;
        // 2 条文献，其中 1 条已核验。
        for (id, status) in [("lit-1", "verified"), ("lit-2", "unverified")] {
            conn.execute(
                "INSERT INTO literature_refs(id, project_id, cite_key, title, status, created_at) \
                 VALUES(?1, ?2, ?1, ?1, ?3, ?4)",
                params![id, project_id, status, now],
            )
            .expect("insert literature ref");
        }
        conn.execute(
            "INSERT INTO datasets(id, project_id, name, created_at) \
             VALUES('ds-1', ?1, '数据集', ?2)",
            params![project_id, now],
        )
        .expect("insert dataset");
        conn.execute(
            "INSERT INTO experiment_runs(id, project_id, name, created_at) \
             VALUES('exp-1', ?1, '实验', ?2)",
            params![project_id, now],
        )
        .expect("insert experiment run");
        conn.execute(
            "INSERT INTO project_artifacts(id, project_id, title, created_at) \
             VALUES('art-1', ?1, '产物', ?2)",
            params![project_id, now],
        )
        .expect("insert project artifact");
        for (id, words) in [("sec-1", 10), ("sec-2", 20)] {
            conn.execute(
                "INSERT INTO manuscript_sections(id, project_id, section, words, updated_at) \
                 VALUES(?1, ?2, ?1, ?3, ?4)",
                params![id, project_id, words, now],
            )
            .expect("insert manuscript section");
        }
        for id in ["adv-1", "adv-2"] {
            conn.execute(
                "INSERT INTO guidance_notes(id, project_id, created_at) VALUES(?1, ?2, ?3)",
                params![id, project_id, now],
            )
            .expect("insert guidance note");
        }

        let stats = overview(&conn, &project_id).expect("overview stats");
        assert_eq!(stats.literature_total, 2);
        assert_eq!(stats.literature_verified, 1);
        assert_eq!(stats.datasets, 1);
        assert_eq!(stats.experiments, 1);
        assert_eq!(stats.artifacts, 1);
        assert_eq!(stats.manuscript_sections, 2);
        assert_eq!(stats.manuscript_words, 30);
        assert_eq!(stats.advice_count, 2);
    }
}
