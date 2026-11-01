//! Additive column and data migrations for databases created by older builds.

use rusqlite::Connection;

/// Additive column migrations for databases created by older builds.
///
/// `ALTER TABLE … ADD COLUMN` fails once the column exists, so each statement
/// runs on its own and "duplicate column" failures are silently accepted —
/// that error *is* the success state for an already-migrated database.
/// Anything else is logged but never fatal (startup must self-heal).
const COLUMN_MIGRATIONS: [&str; 9] = [
    "ALTER TABLE api_keys ADD COLUMN base_url TEXT NOT NULL DEFAULT '';",
    "ALTER TABLE api_keys ADD COLUMN model TEXT NOT NULL DEFAULT '';",
    "ALTER TABLE documents ADD COLUMN source_type TEXT NOT NULL DEFAULT 'video';",
    "ALTER TABLE documents ADD COLUMN file_path TEXT NOT NULL DEFAULT '';",
    "ALTER TABLE documents ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';",
    "ALTER TABLE mind_maps ADD COLUMN kind TEXT NOT NULL DEFAULT 'mindmap';",
    "ALTER TABLE manuscript_sections ADD COLUMN document_id TEXT NOT NULL DEFAULT '';",
    "ALTER TABLE chat_messages ADD COLUMN reasoning TEXT NOT NULL DEFAULT '';",
    "ALTER TABLE manuscript_documents ADD COLUMN source_path TEXT NOT NULL DEFAULT '';",
];

/// Apply [`COLUMN_MIGRATIONS`], tolerating already-applied ones.
pub(super) fn run_column_migrations(conn: &Connection) {
    for statement in COLUMN_MIGRATIONS {
        if let Err(err) = conn.execute_batch(statement) {
            let text = err.to_string();
            if text.contains("duplicate column") {
                continue;
            }
            eprintln!("[db] column migration failed ({statement}): {text}");
        }
    }
}

/// 创建依赖迁移列 `document_id` 的索引。
///
/// 这条语句不能放在 SCHEMA_SQL 里：SCHEMA_SQL 在列迁移之前执行，旧库的
/// `manuscript_sections` 还没有 `document_id`，`CREATE INDEX` 会报
/// `no such column` 并让整个启动 setup hook 失败。失败只记录日志，不阻塞启动。
pub(super) fn ensure_manuscript_document_index(conn: &Connection) {
    if let Err(err) = conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_manuscript_sections_document \
         ON manuscript_sections(project_id, document_id, ord);",
    ) {
        eprintln!("[db] manuscript document index migration failed: {err}");
    }
}

/// True when the `chat_messages` table already carries the `usage` column.
pub(super) fn chat_messages_has_usage_column(conn: &Connection) -> bool {
    let mut statement = match conn.prepare("PRAGMA table_info(chat_messages)") {
        Ok(statement) => statement,
        Err(_) => return false,
    };
    let names = statement.query_map([], |row| row.get::<_, String>(1));
    match names {
        Ok(names) => names.filter_map(Result::ok).any(|name| name == "usage"),
        Err(_) => false,
    }
}

/// Idempotent migration for `chat_messages.usage` (token accounting JSON).
///
/// SCHEMA_SQL covers fresh databases; existing data directories predate
/// the column, so a PRAGMA-guarded `ADD COLUMN` runs on every launch and
/// self-heals old installs exactly once. Failures are logged, never fatal
/// (startup must not break because of a migration hiccup).
pub(super) fn ensure_chat_message_usage_column(conn: &Connection) {
    if chat_messages_has_usage_column(conn) {
        return;
    }
    if let Err(err) = conn.execute_batch(
        "ALTER TABLE chat_messages ADD COLUMN usage TEXT NOT NULL DEFAULT '{}';",
    ) {
        eprintln!("[db] chat_messages.usage migration failed: {err}");
    }
}

/// One-time data migration: graded sessions previously stored only in
/// `quiz_records` become read-only rows in `quiz_sets`, so the quiz history
/// keeps one source of truth. Question bodies were never persisted for those,
/// so they render from their stored results only. Deterministic ids
/// (`rec-<old id>`) + INSERT OR IGNORE keep this idempotent.
pub(super) fn migrate_quiz_records_to_sets(conn: &Connection) {
    // An interim dev build created a single-row quiz_draft table; the
    // superseding quiz_sets design dropped it. The table never shipped.
    let _ = conn.execute_batch("DROP TABLE IF EXISTS quiz_draft;");
    let mut rows = match conn.prepare(
        "SELECT id, created_at, difficulty, question_count, total_score, total_max, details
         FROM quiz_records",
    ) {
        Ok(statement) => statement,
        Err(err) => {
            eprintln!("[db] quiz record migration failed to prepare: {err}");
            return;
        }
    };
    let records = match rows.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, f64>(4)?,
            row.get::<_, f64>(5)?,
            row.get::<_, String>(6)?,
        ))
    }) {
        Ok(rows) => rows.filter_map(Result::ok).collect::<Vec<_>>(),
        Err(err) => {
            eprintln!("[db] quiz record migration failed to read: {err}");
            return;
        }
    };
    for (id, created_at, difficulty, question_count, total_score, total_max, details) in records {
        let config = format!(
            "{{\"count\":{question_count},\"types\":[],\"difficulty\":{difficulty:?},\"topic\":null}}"
        );
        if let Err(err) = conn.execute(
            "INSERT OR IGNORE INTO quiz_sets(
                 id, created_at, difficulty, question_count, config,
                 questions, answers, results, graded, total_score, total_max)
             VALUES(?1, ?2, ?3, ?4, ?5, '[]', '{}', ?6, 1, ?7, ?8)",
            rusqlite::params![
                format!("rec-{id}"),
                created_at,
                difficulty,
                question_count,
                config,
                details,
                total_score,
                total_max
            ],
        ) {
            eprintln!("[db] quiz record migration failed to insert ({id}): {err}");
        }
    }
}

/// One-time data migration: sections written by pre-document builds have no
/// `document_id`; each such project gets a default 「初稿」 document and its
/// legacy sections are attached to it. Idempotent: projects whose sections all
/// carry a document_id are skipped (no rows match).
pub(super) fn migrate_manuscript_documents(conn: &Connection) {
    let projects: Vec<String> = {
        let mut statement = match conn
            .prepare("SELECT DISTINCT project_id FROM manuscript_sections WHERE document_id = ''")
        {
            Ok(statement) => statement,
            Err(err) => {
                eprintln!("[db] manuscript document migration failed to prepare: {err}");
                return;
            }
        };
        let mut projects: Vec<String> = Vec::new();
        match statement.query_map([], |row| row.get::<_, String>(0)) {
            Ok(rows) => {
                for project in rows.filter_map(Result::ok) {
                    projects.push(project);
                }
            }
            Err(err) => {
                eprintln!("[db] manuscript document migration failed to read: {err}");
                return;
            }
        }
        projects
    };
    for project_id in projects {
        let document_id = super::local_id();
        let now = now_secs();
        let migrate = || -> Result<(), rusqlite::Error> {
            let tx = conn.unchecked_transaction()?;
            tx.execute(
                "INSERT INTO manuscript_documents(id, project_id, kind, title, created_at, updated_at) \
                 VALUES (?1, ?2, 'draft', '初稿', ?3, ?3)",
                rusqlite::params![document_id, project_id, now],
            )?;
            tx.execute(
                "UPDATE manuscript_sections SET document_id = ?1 \
                 WHERE project_id = ?2 AND document_id = ''",
                rusqlite::params![document_id, project_id],
            )?;
            tx.commit()
        };
        if let Err(err) = migrate() {
            eprintln!(
                "[db] manuscript document migration failed for project {project_id}: {err}"
            );
        }
    }
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

    #[test]
    fn legacy_manuscript_sections_gain_default_document_idempotently() {
        let conn = Connection::open_in_memory().expect("in-memory db");
        // Pre-document schema: sections exist but carry no document_id.
        conn.execute_batch(
            "CREATE TABLE manuscript_documents(
                 id         TEXT PRIMARY KEY,
                 project_id TEXT NOT NULL,
                 kind       TEXT NOT NULL DEFAULT 'draft',
                 title      TEXT NOT NULL DEFAULT '初稿',
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL
             );
             CREATE TABLE manuscript_sections(
                 id         TEXT PRIMARY KEY,
                 project_id TEXT NOT NULL,
                 section    TEXT NOT NULL,
                 ord        INTEGER NOT NULL DEFAULT 0,
                 path       TEXT NOT NULL DEFAULT '',
                 words      INTEGER NOT NULL DEFAULT 0,
                 status     TEXT NOT NULL DEFAULT 'draft',
                 updated_at INTEGER NOT NULL
             );
             INSERT INTO manuscript_sections(id, project_id, section, ord, updated_at)
             VALUES('s1', 'p1', '摘要', 0, 1), ('s2', 'p1', '1 引言', 1, 1), ('s3', 'p2', '正文', 0, 1);",
        )
        .expect("legacy schema");

        run_column_migrations(&conn);
        migrate_manuscript_documents(&conn);
        // Second run must be a no-op (no duplicate default documents).
        migrate_manuscript_documents(&conn);

        let documents: i64 = conn
            .query_row("SELECT COUNT(*) FROM manuscript_documents", [], |row| row.get(0))
            .expect("document count");
        assert_eq!(documents, 2, "one default document per project");
        let kinds: Vec<(String, String)> = conn
            .prepare("SELECT kind, title FROM manuscript_documents ORDER BY title")
            .expect("prepare")
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .expect("query")
            .filter_map(Result::ok)
            .collect();
        assert_eq!(kinds.len(), 2);
        assert!(kinds.iter().all(|(kind, title)| kind == "draft" && title == "初稿"));
        let unassigned: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM manuscript_sections WHERE document_id = ''",
                [],
                |row| row.get(0),
            )
            .expect("unassigned count");
        assert_eq!(unassigned, 0, "all legacy sections attached");
        let per_document: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM manuscript_sections s                  JOIN manuscript_documents d ON d.id = s.document_id AND d.project_id = s.project_id",
                [],
                |row| row.get(0),
            )
            .expect("joined count");
        assert_eq!(per_document, 3);
    }

    #[test]
    fn legacy_chat_messages_gain_usage_column_idempotently() {
        let conn = Connection::open_in_memory().expect("in-memory db");
        // Pre-usage schema: rows written by older builds must survive.
        conn.execute_batch(
            "CREATE TABLE chat_messages(
                 msg_id          TEXT PRIMARY KEY,
                 chat_session_id TEXT NOT NULL,
                 role            TEXT NOT NULL,
                 content         TEXT NOT NULL,
                 status          TEXT NOT NULL DEFAULT 'completed',
                 sources         TEXT NOT NULL DEFAULT '[]',
                 model           TEXT NOT NULL DEFAULT '',
                 error           TEXT NOT NULL DEFAULT '',
                 created_at      INTEGER NOT NULL
             );
             INSERT INTO chat_messages(msg_id, chat_session_id, role, content, created_at)
             VALUES('old', 's1', 'assistant', 'legacy answer', 1);",
        )
        .expect("legacy schema");
        assert!(!chat_messages_has_usage_column(&conn));

        ensure_chat_message_usage_column(&conn);
        // Second run is a no-op (no duplicate-column error, no data loss).
        ensure_chat_message_usage_column(&conn);

        assert!(chat_messages_has_usage_column(&conn));
        let (content, usage): (String, String) = conn
            .query_row(
                "SELECT content, usage FROM chat_messages WHERE msg_id = 'old'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("legacy row readable");
        assert_eq!(content, "legacy answer");
        assert_eq!(usage, "{}");
    }

    #[test]
    fn legacy_chat_messages_gain_reasoning_column() {
        let conn = Connection::open_in_memory().expect("in-memory db");
        conn.execute_batch(
            "CREATE TABLE chat_messages(
                 msg_id          TEXT PRIMARY KEY,
                 chat_session_id TEXT NOT NULL,
                 role            TEXT NOT NULL,
                 content         TEXT NOT NULL,
                 status          TEXT NOT NULL DEFAULT 'completed',
                 sources         TEXT NOT NULL DEFAULT '[]',
                 model           TEXT NOT NULL DEFAULT '',
                 error           TEXT NOT NULL DEFAULT '',
                 usage           TEXT NOT NULL DEFAULT '{}',
                 created_at      INTEGER NOT NULL
             );
             INSERT INTO chat_messages(msg_id, chat_session_id, role, content, created_at)
             VALUES('old', 's1', 'assistant', 'legacy answer', 1);",
        )
        .expect("legacy schema");

        // 其它表的 ALTER 会因缺表失败并被容忍；chat_messages 的 reasoning 生效。
        run_column_migrations(&conn);
        run_column_migrations(&conn);

        let has_reasoning = {
            let mut statement = conn
                .prepare("PRAGMA table_info(chat_messages)")
                .expect("pragma");
            let columns: Vec<String> = statement
                .query_map([], |row| row.get::<_, String>(1))
                .expect("columns")
                .filter_map(Result::ok)
                .collect();
            columns.iter().any(|name| name == "reasoning")
        };
        assert!(has_reasoning, "旧库应通过列迁移补上 reasoning");
        let reasoning: String = conn
            .query_row(
                "SELECT reasoning FROM chat_messages WHERE msg_id = 'old'",
                [],
                |row| row.get(0),
            )
            .expect("legacy row reasoning");
        assert_eq!(reasoning, "", "历史行默认空 reasoning");
    }

    #[test]
    fn legacy_manuscript_documents_gain_source_path_column() {
        let conn = Connection::open_in_memory().expect("in-memory db");
        conn.execute_batch(
            "CREATE TABLE manuscript_documents(
                 id         TEXT PRIMARY KEY,
                 project_id TEXT NOT NULL,
                 kind       TEXT NOT NULL DEFAULT 'draft',
                 title      TEXT NOT NULL DEFAULT '初稿',
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL
             );
             INSERT INTO manuscript_documents(id, project_id, created_at, updated_at)
             VALUES('old', 'p1', 1, 1);",
        )
        .expect("legacy schema");

        run_column_migrations(&conn);
        run_column_migrations(&conn);

        let has_source_path = {
            let mut statement = conn
                .prepare("PRAGMA table_info(manuscript_documents)")
                .expect("pragma");
            let columns: Vec<String> = statement
                .query_map([], |row| row.get::<_, String>(1))
                .expect("columns")
                .filter_map(Result::ok)
                .collect();
            columns.iter().any(|name| name == "source_path")
        };
        assert!(has_source_path, "旧库应通过列迁移补上 source_path");
        let source_path: String = conn
            .query_row(
                "SELECT source_path FROM manuscript_documents WHERE id = 'old'",
                [],
                |row| row.get(0),
            )
            .expect("legacy row source_path");
        assert_eq!(source_path, "", "历史文档默认空 source_path");
    }
}
