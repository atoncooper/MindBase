//! Schema bootstrap statement and the startup repair passes that follow it.

use rusqlite::Connection;

use super::migrations::{
    ensure_chat_message_usage_column, migrate_quiz_records_to_sets, run_column_migrations,
};

/// Schema bootstrap statement. Idempotent so it is safe to run on every launch.
pub(crate) const SCHEMA_SQL: &str =
    "CREATE TABLE IF NOT EXISTS app_config(key TEXT PRIMARY KEY, value TEXT NOT NULL);
     CREATE TABLE IF NOT EXISTS api_keys(
         provider   TEXT PRIMARY KEY,
         api_key    TEXT NOT NULL DEFAULT '',
         base_url   TEXT NOT NULL DEFAULT '',
         model      TEXT NOT NULL DEFAULT '',
         updated_at INTEGER NOT NULL
     );
     CREATE TABLE IF NOT EXISTS vectors(
         id          INTEGER PRIMARY KEY AUTOINCREMENT,
         doc_id      TEXT    NOT NULL,
         chunk_index INTEGER NOT NULL,
         content     TEXT    NOT NULL,
         dim         INTEGER NOT NULL,
         embedding   BLOB    NOT NULL,
         created_at  INTEGER NOT NULL,
         UNIQUE(doc_id, chunk_index)
     );
     CREATE TABLE IF NOT EXISTS bili_session(
         id            INTEGER PRIMARY KEY CHECK (id = 1),
         sessdata      TEXT    NOT NULL,
         bili_jct      TEXT    NOT NULL DEFAULT '',
         dede_user_id  TEXT    NOT NULL DEFAULT '',
         mid           INTEGER NOT NULL DEFAULT 0,
         uname         TEXT    NOT NULL DEFAULT '',
         face          TEXT    NOT NULL DEFAULT '',
         refresh_token TEXT    NOT NULL DEFAULT '',
         logged_in_at  INTEGER NOT NULL
     );
     CREATE TABLE IF NOT EXISTS documents(
         doc_id      TEXT PRIMARY KEY,                -- {bvid}:p{page_index}
         bvid        TEXT    NOT NULL,
         cid         INTEGER NOT NULL,
         page_index  INTEGER NOT NULL,
         video_title TEXT    NOT NULL DEFAULT '',
         page_title  TEXT    NOT NULL DEFAULT '',
         upper_name  TEXT    NOT NULL DEFAULT '',
         source      TEXT    NOT NULL DEFAULT '',     -- asr | basic_info | file extension
         status      TEXT    NOT NULL DEFAULT 'pending', -- pending|processing|done|failed
         source_type TEXT    NOT NULL DEFAULT 'video',   -- video | file
         file_path   TEXT    NOT NULL DEFAULT '',        -- absolute path (file docs only)
         content_hash TEXT   NOT NULL DEFAULT '',        -- file content digest (dedup)
         error       TEXT    NOT NULL DEFAULT '',
         char_count  INTEGER NOT NULL DEFAULT 0,
         chunk_count INTEGER NOT NULL DEFAULT 0,
         embed_model TEXT    NOT NULL DEFAULT '',
         embed_dim   INTEGER NOT NULL DEFAULT 0,
         created_at  INTEGER NOT NULL,
         updated_at  INTEGER NOT NULL
     );
     CREATE INDEX IF NOT EXISTS idx_documents_bvid ON documents(bvid);
     CREATE TABLE IF NOT EXISTS chat_sessions(
         id              INTEGER PRIMARY KEY AUTOINCREMENT,
         chat_session_id TEXT NOT NULL UNIQUE,               -- 32-hex local id
         title           TEXT    NOT NULL DEFAULT '',
         status          TEXT    NOT NULL DEFAULT 'active',  -- active | deleted
         created_at      INTEGER NOT NULL,
         updated_at      INTEGER NOT NULL,
         last_message_at INTEGER
     );
     CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated ON chat_sessions(updated_at DESC);
     CREATE TABLE IF NOT EXISTS chat_messages(
         msg_id          TEXT PRIMARY KEY,                    -- 32-hex local id
         chat_session_id TEXT NOT NULL,
         role            TEXT NOT NULL,                       -- user | assistant
         content         TEXT NOT NULL,
         status          TEXT NOT NULL DEFAULT 'completed',   -- pending|completed|failed
         sources         TEXT NOT NULL DEFAULT '[]',          -- JSON array
         model           TEXT NOT NULL DEFAULT '',
         error           TEXT NOT NULL DEFAULT '',
         usage           TEXT NOT NULL DEFAULT '{}',         -- JSON token usage
         created_at      INTEGER NOT NULL
     );
     CREATE INDEX IF NOT EXISTS idx_chat_messages_session
         ON chat_messages(chat_session_id, created_at);
     CREATE TABLE IF NOT EXISTS notes(
         id         TEXT PRIMARY KEY,                     -- 32-hex local id
         title      TEXT    NOT NULL DEFAULT '',
         content    TEXT    NOT NULL DEFAULT '',          -- markdown source
         pinned     INTEGER NOT NULL DEFAULT 0,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
     );
     CREATE INDEX IF NOT EXISTS idx_notes_pinned_updated ON notes(pinned DESC, updated_at DESC);
     CREATE TABLE IF NOT EXISTS note_revisions(
         id         TEXT PRIMARY KEY,
         note_id    TEXT    NOT NULL,
         content    TEXT    NOT NULL,
         char_count INTEGER NOT NULL,
         created_at INTEGER NOT NULL
     );
     CREATE INDEX IF NOT EXISTS idx_note_revisions_note ON note_revisions(note_id, created_at DESC);
     CREATE TABLE IF NOT EXISTS note_anchors(
         id         TEXT PRIMARY KEY,
         note_id    TEXT    NOT NULL,
         bvid       TEXT    NOT NULL,
         page_index INTEGER NOT NULL DEFAULT 1,
         seconds    INTEGER NOT NULL DEFAULT 0,
         label      TEXT    NOT NULL DEFAULT '',
         created_at INTEGER NOT NULL
     );
     CREATE INDEX IF NOT EXISTS idx_note_anchors_note ON note_anchors(note_id);
     CREATE TABLE IF NOT EXISTS session_summaries(
         session_id       TEXT PRIMARY KEY,
         summary          TEXT    NOT NULL,
         kept_count       INTEGER NOT NULL,
         compressed_count INTEGER NOT NULL,
         updated_at       INTEGER NOT NULL
     );
     CREATE TABLE IF NOT EXISTS session_summary_docs(
         session_id    TEXT PRIMARY KEY,
         content       TEXT    NOT NULL,
         message_count INTEGER NOT NULL,
         created_at    INTEGER NOT NULL
     );
     -- L2 blackboard (plan/1.0.10-AgentMemory §5): structured findings sub-
     -- agents auto-deposit through the delegate bridge. Written ONLY via
     -- record_session_finding (LRU-capped per session); never human dialogue.
     CREATE TABLE IF NOT EXISTS session_findings(
         id         INTEGER PRIMARY KEY AUTOINCREMENT,
         session_id TEXT    NOT NULL,
         agent      TEXT    NOT NULL,
         topic      TEXT    NOT NULL,
         finding    TEXT    NOT NULL,
         sources    TEXT    NOT NULL DEFAULT '[]',
         created_at INTEGER NOT NULL
     );
     CREATE INDEX IF NOT EXISTS idx_session_findings_session
         ON session_findings(session_id, created_at DESC);
     -- L5 memory-agent retrieval window (per session, survives restarts).
     CREATE TABLE IF NOT EXISTS memory_windows(
         session_id TEXT PRIMARY KEY,
         entries    TEXT    NOT NULL,
         updated_at INTEGER NOT NULL
     );
     CREATE TABLE IF NOT EXISTS skill_settings(
         name    TEXT PRIMARY KEY,
         enabled INTEGER NOT NULL DEFAULT 1
     );
     CREATE TABLE IF NOT EXISTS quiz_history(
         question_hash TEXT PRIMARY KEY,                -- md5 of normalized stem
         question_type TEXT    NOT NULL DEFAULT '',
         question_text TEXT    NOT NULL DEFAULT '',
         created_at    INTEGER NOT NULL
     );
     CREATE TABLE IF NOT EXISTS quiz_records(
         id             TEXT PRIMARY KEY,               -- 32-hex local id
         created_at     INTEGER NOT NULL,
         difficulty     TEXT    NOT NULL DEFAULT '',
         question_count INTEGER NOT NULL DEFAULT 0,
         total_score    REAL    NOT NULL DEFAULT 0,
         total_max      REAL    NOT NULL DEFAULT 0,
         details        TEXT    NOT NULL DEFAULT '[]'   -- JSON of per-question outcomes
     );
     CREATE TABLE IF NOT EXISTS quiz_sets(
         id             TEXT PRIMARY KEY,               -- 32-hex local id
         created_at     INTEGER NOT NULL,
         difficulty     TEXT    NOT NULL DEFAULT '',
         question_count INTEGER NOT NULL DEFAULT 0,
         config         TEXT    NOT NULL DEFAULT '',    -- JSON: generation config
         questions      TEXT    NOT NULL DEFAULT '[]',  -- JSON of QuizQuestion
         answers        TEXT    NOT NULL DEFAULT '{}',  -- JSON: questionId -> answer
         results        TEXT    NOT NULL DEFAULT '',    -- JSON [QuizRecordItem]; '' = not graded
         graded         INTEGER NOT NULL DEFAULT 0,
         total_score    REAL    NOT NULL DEFAULT 0,
         total_max      REAL    NOT NULL DEFAULT 0
     );
     CREATE VIRTUAL TABLE IF NOT EXISTS vectors_fts USING fts5(
         content,                                      -- tokenized text (CJK bigrams + ASCII words)
         doc_id UNINDEXED,
         chunk_index UNINDEXED
     );
     CREATE TABLE IF NOT EXISTS mind_maps(
         id         TEXT PRIMARY KEY,                -- 32-hex local id
         title      TEXT    NOT NULL DEFAULT '未命名导图',
         kind       TEXT    NOT NULL DEFAULT 'mindmap', -- mindmap | whiteboard
         data       TEXT    NOT NULL DEFAULT '',     -- JSON: 导图树或白板场景
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
     );
     CREATE INDEX IF NOT EXISTS idx_mind_maps_updated ON mind_maps(updated_at DESC);
     CREATE TABLE IF NOT EXISTS mind_map_snapshots(
         id         TEXT PRIMARY KEY,                -- 32-hex local id
         map_id     TEXT    NOT NULL,                -- 所属 mind_maps.id
         title      TEXT    NOT NULL DEFAULT '',     -- 快照名（自动/手动/回滚备份）
         data       TEXT    NOT NULL DEFAULT '',     -- 快照时刻的整卡 JSON
         created_at INTEGER NOT NULL
     );
     CREATE INDEX IF NOT EXISTS idx_mind_map_snapshots
         ON mind_map_snapshots(map_id, created_at DESC);
     CREATE TABLE IF NOT EXISTS research_projects(
         id            TEXT PRIMARY KEY,
         title         TEXT NOT NULL,
         paper_kind    TEXT NOT NULL DEFAULT 'journal',
         field         TEXT NOT NULL DEFAULT '',
         language      TEXT NOT NULL DEFAULT 'zh',
         target_venue  TEXT NOT NULL DEFAULT '',
         current_stage TEXT NOT NULL DEFAULT 'topic',
         privacy       TEXT NOT NULL DEFAULT 'local',
         deadline      TEXT NOT NULL DEFAULT '',
         meta_json     TEXT NOT NULL DEFAULT '{}',
         created_at    INTEGER NOT NULL,
         updated_at    INTEGER NOT NULL
     );
     CREATE INDEX IF NOT EXISTS idx_research_projects_updated ON research_projects(updated_at DESC);
     CREATE TABLE IF NOT EXISTS research_stages(
         project_id  TEXT NOT NULL,
         stage       TEXT NOT NULL,
         status      TEXT NOT NULL DEFAULT 'locked',
         entered_at  INTEGER,
         approved_at INTEGER,
         gate_json   TEXT NOT NULL DEFAULT '[]',
         PRIMARY KEY(project_id, stage)
     );
     CREATE TABLE IF NOT EXISTS project_artifacts(
         id         TEXT PRIMARY KEY,
         project_id TEXT NOT NULL,
         stage      TEXT NOT NULL DEFAULT '',
         kind       TEXT NOT NULL DEFAULT 'doc',
         title      TEXT NOT NULL DEFAULT '',
         path       TEXT NOT NULL DEFAULT '',
         version    INTEGER NOT NULL DEFAULT 1,
         sha256     TEXT NOT NULL DEFAULT '',
         status     TEXT NOT NULL DEFAULT 'draft',
         meta_json  TEXT NOT NULL DEFAULT '{}',
         created_at INTEGER NOT NULL
     );
     CREATE INDEX IF NOT EXISTS idx_project_artifacts_project ON project_artifacts(project_id, stage);
     CREATE TABLE IF NOT EXISTS literature_refs(
         id           TEXT PRIMARY KEY,
         project_id   TEXT NOT NULL,
         cite_key     TEXT NOT NULL,
         doi          TEXT NOT NULL DEFAULT '',
         title        TEXT NOT NULL,
         authors_json TEXT NOT NULL DEFAULT '[]',
         year         INTEGER,
         venue        TEXT NOT NULL DEFAULT '',
         type         TEXT NOT NULL DEFAULT 'article',
         url          TEXT NOT NULL DEFAULT '',
         status       TEXT NOT NULL DEFAULT 'unverified',
         csl_json     TEXT NOT NULL DEFAULT '{}',
         note         TEXT NOT NULL DEFAULT '',
         created_at   INTEGER NOT NULL,
         UNIQUE(project_id, cite_key)
     );
     CREATE INDEX IF NOT EXISTS idx_literature_refs_project ON literature_refs(project_id, status);
     CREATE TABLE IF NOT EXISTS citations(
         id          TEXT PRIMARY KEY,
         project_id  TEXT NOT NULL,
         artifact_id TEXT NOT NULL DEFAULT '',
         ref_id      TEXT NOT NULL,
         locator     TEXT NOT NULL DEFAULT '',
         claim       TEXT NOT NULL DEFAULT '',
         created_at  INTEGER NOT NULL
     );
     CREATE INDEX IF NOT EXISTS idx_citations_project ON citations(project_id, ref_id);
     CREATE TABLE IF NOT EXISTS datasets(
         id           TEXT PRIMARY KEY,
         project_id   TEXT NOT NULL,
         name         TEXT NOT NULL,
         path         TEXT NOT NULL DEFAULT '',
         sha256       TEXT NOT NULL DEFAULT '',
         rows         INTEGER,
         cols         INTEGER,
         privacy      TEXT NOT NULL DEFAULT 'local',
         schema_json  TEXT NOT NULL DEFAULT '{}',
         profile_json TEXT NOT NULL DEFAULT '{}',
         created_at   INTEGER NOT NULL
     );
     CREATE INDEX IF NOT EXISTS idx_datasets_project ON datasets(project_id);
     CREATE TABLE IF NOT EXISTS experiment_runs(
         id            TEXT PRIMARY KEY,
         project_id    TEXT NOT NULL,
         name          TEXT NOT NULL,
         dataset_ids   TEXT NOT NULL DEFAULT '[]',
         config_json   TEXT NOT NULL DEFAULT '{}',
         script_path   TEXT NOT NULL DEFAULT '',
         script_sha256 TEXT NOT NULL DEFAULT '',
         env_json      TEXT NOT NULL DEFAULT '{}',
         metrics_json  TEXT NOT NULL DEFAULT '{}',
         status        TEXT NOT NULL DEFAULT 'planned',
         conclusion    TEXT NOT NULL DEFAULT '',
         created_at    INTEGER NOT NULL
     );
     CREATE INDEX IF NOT EXISTS idx_experiment_runs_project ON experiment_runs(project_id, created_at DESC);
     CREATE TABLE IF NOT EXISTS manuscript_sections(
         id         TEXT PRIMARY KEY,
         project_id TEXT NOT NULL,
         section    TEXT NOT NULL,
         ord        INTEGER NOT NULL DEFAULT 0,
         path       TEXT NOT NULL DEFAULT '',
         words      INTEGER NOT NULL DEFAULT 0,
         status     TEXT NOT NULL DEFAULT 'draft',
         updated_at INTEGER NOT NULL
     );
     CREATE INDEX IF NOT EXISTS idx_manuscript_sections_project ON manuscript_sections(project_id, ord);
     CREATE TABLE IF NOT EXISTS guidance_notes(
         id             TEXT PRIMARY KEY,
         project_id     TEXT NOT NULL,
         session_date   TEXT NOT NULL DEFAULT '',
         questions_json TEXT NOT NULL DEFAULT '[]',
         notes          TEXT NOT NULL DEFAULT '',
         created_at     INTEGER NOT NULL
     );
     CREATE INDEX IF NOT EXISTS idx_guidance_notes_project ON guidance_notes(project_id, created_at DESC);
     CREATE TABLE IF NOT EXISTS decisions(
         id            TEXT PRIMARY KEY,
         project_id    TEXT NOT NULL,
         ts            INTEGER NOT NULL,
         decision      TEXT NOT NULL,
         rationale     TEXT NOT NULL DEFAULT '',
         evidence_refs TEXT NOT NULL DEFAULT '[]'
     );
     CREATE INDEX IF NOT EXISTS idx_decisions_project ON decisions(project_id, ts DESC);
     CREATE TABLE IF NOT EXISTS project_events(
         id           INTEGER PRIMARY KEY AUTOINCREMENT,
         project_id   TEXT NOT NULL,
         ts           INTEGER NOT NULL,
         actor        TEXT NOT NULL,
         type         TEXT NOT NULL,
         payload_json TEXT NOT NULL DEFAULT '{}'
     );
     CREATE INDEX IF NOT EXISTS idx_project_events_project ON project_events(project_id, ts DESC);
     -- Long-running automation tasks (AI-supervised). Log bodies live on disk;
     -- these tables only keep task/run state, log segment pointers and reports.
     CREATE TABLE IF NOT EXISTS automation_tasks(
         id             INTEGER PRIMARY KEY AUTOINCREMENT,
         name           TEXT    NOT NULL,
         command        TEXT    NOT NULL,
         cwd            TEXT    NOT NULL DEFAULT '',
         interval_secs  INTEGER NOT NULL DEFAULT 600,
         max_attempts   INTEGER NOT NULL DEFAULT 3,
         state          TEXT    NOT NULL DEFAULT 'pending',
         attempt        INTEGER NOT NULL DEFAULT 0,
         last_report_at INTEGER NOT NULL DEFAULT 0,
         created_at     INTEGER NOT NULL,
         updated_at     INTEGER NOT NULL
     );
     CREATE INDEX IF NOT EXISTS idx_automation_tasks_state ON automation_tasks(state, updated_at DESC);
     CREATE TABLE IF NOT EXISTS automation_runs(
         id             INTEGER PRIMARY KEY AUTOINCREMENT,
         task_id        INTEGER NOT NULL,
         attempt        INTEGER NOT NULL,
         pid            INTEGER,
         started_at     INTEGER NOT NULL,
         ended_at       INTEGER,
         exit_code      INTEGER,
         state          TEXT    NOT NULL DEFAULT 'running',
         restart_reason TEXT    NOT NULL DEFAULT ''
     );
     CREATE INDEX IF NOT EXISTS idx_automation_runs_task ON automation_runs(task_id, id DESC);
     CREATE TABLE IF NOT EXISTS automation_logs(
         id           INTEGER PRIMARY KEY AUTOINCREMENT,
         task_id      INTEGER NOT NULL,
         run_id       INTEGER,
         path         TEXT    NOT NULL,
         kind         TEXT    NOT NULL DEFAULT 'stdout',
         start_offset INTEGER NOT NULL DEFAULT 0,
         end_offset   INTEGER NOT NULL DEFAULT 0,
         bytes        INTEGER NOT NULL DEFAULT 0,
         created_at   INTEGER NOT NULL
     );
     CREATE INDEX IF NOT EXISTS idx_automation_logs_task ON automation_logs(task_id, id DESC);
     CREATE TABLE IF NOT EXISTS automation_reports(
         id         INTEGER PRIMARY KEY AUTOINCREMENT,
         task_id    INTEGER NOT NULL,
         run_id     INTEGER,
         kind       TEXT    NOT NULL,
         summary    TEXT    NOT NULL DEFAULT '',
         tail       TEXT    NOT NULL DEFAULT '',
         created_at INTEGER NOT NULL
     );
     CREATE INDEX IF NOT EXISTS idx_automation_reports_task ON automation_reports(task_id, id DESC);
     -- LLM token usage ledger (DeepSeek-Harness-style stats): one row per completed
     -- assistant turn; task_id is set when the turn belongs to an automation task.
     CREATE TABLE IF NOT EXISTS llm_usage(
         id             INTEGER PRIMARY KEY AUTOINCREMENT,
         ts             INTEGER NOT NULL,
         session_id     TEXT    NOT NULL DEFAULT '',
         purpose        TEXT    NOT NULL DEFAULT 'chat',
         model          TEXT    NOT NULL DEFAULT '',
         task_id        INTEGER,
         input_tokens   INTEGER NOT NULL DEFAULT 0,
         output_tokens  INTEGER NOT NULL DEFAULT 0,
         cached_tokens  INTEGER NOT NULL DEFAULT 0,
         total_tokens   INTEGER NOT NULL DEFAULT 0
     );
     CREATE INDEX IF NOT EXISTS idx_llm_usage_ts ON llm_usage(ts DESC);
     CREATE INDEX IF NOT EXISTS idx_llm_usage_session ON llm_usage(session_id, ts DESC);
     CREATE INDEX IF NOT EXISTS idx_llm_usage_task ON llm_usage(task_id, ts DESC);
     -- 主 agent 自建的自定义子代理（角色提示词 + 描述），可被 delegate_to_agent 复用。
     CREATE TABLE IF NOT EXISTS custom_agents(
         id            TEXT PRIMARY KEY,
         name          TEXT NOT NULL UNIQUE,
         description   TEXT NOT NULL DEFAULT '',
         system_prompt TEXT NOT NULL DEFAULT '',
         created_at    INTEGER NOT NULL,
         updated_at    INTEGER NOT NULL
     );";

/// Apply pragmas plus schema bootstrap to a fresh connection.
pub(super) fn ensure_schema(conn: &Connection) -> Result<(), String> {
    // WAL improves crash safety and allows concurrent readers.
    conn.execute_batch("PRAGMA journal_mode=WAL;")
        .map_err(|err| format!("failed to enable WAL journal mode: {err}"))?;
    conn.execute_batch(SCHEMA_SQL)
        .map_err(|err| format!("failed to initialize schema: {err}"))?;
    run_column_migrations(conn);
    ensure_chat_message_usage_column(conn);
    migrate_quiz_records_to_sets(conn);
    backfill_vectors_fts(conn);
    Ok(())
}

/// Keep the FTS index aligned with the `vectors` table.
///
/// The live sync happens inside `vectors::upsert_chunks_conn` /
/// `delete_doc_conn`; this startup pass repairs drift (e.g. rows written by
/// an older build before FTS existed). Count mismatch = full rebuild — the
/// mapping is strictly 1:1, so a rebuild is always correct and cheap at
/// personal-knowledge-base scale.
fn backfill_vectors_fts(conn: &Connection) {
    let vector_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM vectors", [], |row| row.get(0))
        .unwrap_or(0);
    let fts_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM vectors_fts", [], |row| row.get(0))
        .unwrap_or(0);
    if vector_count == fts_count {
        return;
    }
    let rebuild = || -> Result<(), String> {
        conn.execute("DELETE FROM vectors_fts", [])
            .map_err(|err| err.to_string())?;
        let tx = conn
            .unchecked_transaction()
            .map_err(|err| err.to_string())?;
        {
            let mut statement = conn
                .prepare("SELECT doc_id, chunk_index, content FROM vectors")
                .map_err(|err| err.to_string())?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .map_err(|err| err.to_string())?;
            for row in rows {
                let (doc_id, chunk_index, content) = row.map_err(|err| err.to_string())?;
                let tokens = crate::knowledge::vectors::index_tokens(&content).join(" ");
                tx.execute(
                    "INSERT INTO vectors_fts(content, doc_id, chunk_index) VALUES(?1, ?2, ?3)",
                    rusqlite::params![tokens, doc_id, chunk_index],
                )
                .map_err(|err| err.to_string())?;
            }
        }
        tx.commit().map_err(|err| err.to_string())
    };
    match rebuild() {
        Ok(()) => eprintln!("[db] vectors_fts rebuilt ({vector_count} rows, was {fts_count})"),
        Err(err) => eprintln!("[db] vectors_fts rebuild failed: {err}"),
    }
}
