//! SQLite data layer with a relocatable data directory.
//!
//! The active data directory is resolved at startup: when the pointer file
//! (`data-location.json`) inside the DEFAULT app-data dir names a usable
//! custom directory, that directory hosts the SQLite database; otherwise the
//! default directory is used. Keeping the pointer outside the database file
//! is what makes relocation possible at all (bootstrap problem: the config
//! lives inside SQLite, which lives inside the data directory).
//!
//! Every failure mode of the pointer (absent, unreadable, malformed, target
//! unusable) self-heals to the default directory — a distributed desktop app
//! must never fail startup because of stale relocation state.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

/// Database file stored under the active data directory.
pub(crate) const DB_FILE_NAME: &str = "mindbase-desktop.sqlite3";

/// Process-wide counter mixed into [`local_id`] so ids created within the
/// same nanosecond timestamp stay unique.
static LOCAL_ID_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Generate a 32-hex local identifier (stand-in for UUID4 without a new
/// dependency): MD5 over wall-clock nanos + pid + an atomic counter. Collision
/// odds are irrelevant for a single-user local app.
pub(crate) fn local_id() -> String {
    use md5::{Digest, Md5};
    use std::sync::atomic::Ordering;

    let counter = LOCAL_ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|delta| delta.as_nanos())
        .unwrap_or_default();
    let mut hasher = Md5::new();
    hasher.update(nanos.to_le_bytes());
    hasher.update(std::process::id().to_le_bytes());
    hasher.update(counter.to_le_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(32);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Pointer file inside the DEFAULT dir naming the custom data directory.
const POINTER_FILE_NAME: &str = "data-location.json";

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
     );";

/// Additive column migrations for databases created by older builds.
///
/// `ALTER TABLE … ADD COLUMN` fails once the column exists, so each statement
/// runs on its own and "duplicate column" failures are silently accepted —
/// that error *is* the success state for an already-migrated database.
/// Anything else is logged but never fatal (startup must self-heal).
const COLUMN_MIGRATIONS: [&str; 5] = [
    "ALTER TABLE api_keys ADD COLUMN base_url TEXT NOT NULL DEFAULT '';",
    "ALTER TABLE api_keys ADD COLUMN model TEXT NOT NULL DEFAULT '';",
    "ALTER TABLE documents ADD COLUMN source_type TEXT NOT NULL DEFAULT 'video';",
    "ALTER TABLE documents ADD COLUMN file_path TEXT NOT NULL DEFAULT '';",
    "ALTER TABLE documents ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';",
];

/// Apply [`COLUMN_MIGRATIONS`], tolerating already-applied ones.
fn run_column_migrations(conn: &Connection) {
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

/// Managed SQLite handle shared across Tauri commands.
///
/// Lock order (to stay deadlock-free): `conn` first, then `data_dir`. No
/// code path acquires them in reverse order or nests other locks in between.
pub struct Db {
    pub conn: Mutex<Connection>,
    /// Active data directory (host of the db file); updated on relocation.
    pub data_dir: Mutex<PathBuf>,
    /// OS default app-data dir; pointer-file anchor and reset target.
    pub default_dir: PathBuf,
}

/// Snapshot describing the current data directory placement.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDirInfo {
    pub current_path: String,
    pub is_custom: bool,
    pub default_path: String,
}

/// Extract the custom directory named by a pointer payload.
///
/// Pure (no filesystem access): `None` for malformed JSON, missing fields or
/// relative paths, so every bad payload degrades to "use the default dir".
fn pointer_target(payload: &str) -> Option<PathBuf> {
    #[derive(serde::Deserialize)]
    struct Payload {
        #[serde(rename = "dataDir")]
        data_dir: String,
    }
    let raw = serde_json::from_str::<Payload>(payload).ok()?.data_dir;
    let dir = PathBuf::from(raw);
    dir.is_absolute().then_some(dir)
}

/// True when `child` lies strictly inside `parent` (component-wise compare,
/// so `D:\data` is not reported as being inside `D:\database`).
fn is_strict_subdir(child: &Path, parent: &Path) -> bool {
    child != parent && child.starts_with(parent)
}

/// Canonicalize what exists and strip the Windows extended-length prefix
/// (`\\?\C:\...`) so user-picked paths compare equal to our stored ones.
fn normalize_path(p: &Path) -> PathBuf {
    let canonical = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let text = canonical.as_os_str().to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => canonical,
    }
}

fn default_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("failed to resolve app data dir: {err}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|err| format!("failed to create app data dir {}: {err}", dir.display()))?;
    Ok(dir)
}

/// Read and validate the pointer file inside `default_dir`.
///
/// Returns `None` — and logs — for every failure mode; callers fall back to
/// the default directory.
fn read_custom_dir(default_dir: &Path) -> Option<PathBuf> {
    let payload = std::fs::read_to_string(default_dir.join(POINTER_FILE_NAME)).ok()?;
    match pointer_target(&payload) {
        Some(dir) => {
            if let Err(err) = std::fs::create_dir_all(&dir) {
                eprintln!(
                    "[db] custom data dir {} cannot be created ({err}); using default",
                    dir.display()
                );
                return None;
            }
            Some(dir)
        }
        None => {
            eprintln!("[db] pointer file is invalid; using default data dir");
            None
        }
    }
}

fn write_pointer(default_dir: &Path, dir: &Path) -> Result<(), String> {
    let payload = serde_json::json!({ "dataDir": dir.display().to_string() });
    std::fs::write(
        default_dir.join(POINTER_FILE_NAME),
        serde_json::to_string_pretty(&payload).map_err(|err| err.to_string())?,
    )
    .map_err(|err| format!("failed to write data-location pointer: {err}"))
}

fn clear_pointer(default_dir: &Path) -> Result<(), String> {
    match std::fs::remove_file(default_dir.join(POINTER_FILE_NAME)) {
        Ok(()) => Ok(()),
        // Already gone is exactly the state we want.
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("failed to remove data-location pointer: {err}")),
    }
}

/// Apply pragmas plus schema bootstrap to a fresh connection.
fn ensure_schema(conn: &Connection) -> Result<(), String> {
    // WAL improves crash safety and allows concurrent readers.
    conn.execute_batch("PRAGMA journal_mode=WAL;")
        .map_err(|err| format!("failed to enable WAL journal mode: {err}"))?;
    conn.execute_batch(SCHEMA_SQL)
        .map_err(|err| format!("failed to initialize schema: {err}"))?;
    run_column_migrations(conn);
    Ok(())
}

/// Open (or create) the database under `dir` and prepare it for use.
fn open_conn(dir: &Path) -> Result<Connection, String> {
    let path = dir.join(DB_FILE_NAME);
    let conn = Connection::open(&path)
        .map_err(|err| format!("failed to open sqlite db at {}: {err}", path.display()))?;
    ensure_schema(&conn)?;
    Ok(conn)
}

/// Open the database at the resolved location and share it as managed state.
///
/// The active directory is the pointer target when valid, else the default;
/// a custom location that cannot be opened falls back to the default one so
/// startup never breaks because of relocation state.
pub fn init(app: &AppHandle) -> Result<Db, String> {
    let default_dir = default_data_dir(app)?;
    let preferred = read_custom_dir(&default_dir).unwrap_or_else(|| default_dir.clone());

    let (conn, used_dir) = match open_conn(&preferred) {
        Ok(conn) => (conn, preferred),
        Err(err) if preferred != default_dir => {
            eprintln!("[db] custom data dir unusable ({err}); falling back to default");
            open_conn(&default_dir).map(|conn| (conn, default_dir.clone()))?
        }
        Err(err) => return Err(err),
    };

    Ok(Db {
        conn: Mutex::new(conn),
        data_dir: Mutex::new(used_dir),
        default_dir,
    })
}

fn data_dir_info(current: &Path, default_dir: &Path) -> DataDirInfo {
    DataDirInfo {
        current_path: current.display().to_string(),
        is_custom: current != default_dir,
        default_path: default_dir.display().to_string(),
    }
}

/// Copy the database files from the old directory to the new one.
///
/// Copy (not rename) keeps this working across drives. The main file must
/// exist and be non-empty; WAL/SHM side files are copied only when present.
/// Callers must have run `PRAGMA wal_checkpoint(TRUNCATE)` first so the main
/// file is complete.
fn copy_db_files(from_dir: &Path, to_dir: &Path) -> Result<(), String> {
    let side_files = [format!("{DB_FILE_NAME}-wal"), format!("{DB_FILE_NAME}-shm")];

    let main_src = from_dir.join(DB_FILE_NAME);
    let meta = std::fs::metadata(&main_src)
        .map_err(|err| format!("source database missing: {err}"))?;
    if meta.len() == 0 {
        return Err("source database file is empty".to_string());
    }
    std::fs::copy(&main_src, to_dir.join(DB_FILE_NAME))
        .map_err(|err| format!("failed to copy database: {err}"))?;

    for name in side_files {
        let src = from_dir.join(&name);
        if src.exists() {
            std::fs::copy(&src, to_dir.join(&name))
                .map_err(|err| format!("failed to copy {name}: {err}"))?;
        }
    }

    let copied = std::fs::metadata(to_dir.join(DB_FILE_NAME))
        .map_err(|err| format!("copied database missing: {err}"))?;
    if copied.len() == 0 {
        return Err("copied database file is empty".to_string());
    }
    Ok(())
}

/// Validate a user-supplied target directory (existence, writability).
///
/// Returns the normalized path on success.
fn validate_target(requested: &str) -> Result<PathBuf, String> {
    let raw = requested.trim();
    if raw.is_empty() {
        return Err("数据目录路径不能为空".to_string());
    }
    let target = PathBuf::from(raw);
    if !target.is_absolute() {
        return Err(format!("请选择完整的绝对路径（含盘符），收到：{raw}"));
    }
    std::fs::create_dir_all(&target).map_err(|err| {
        format!(
            "无法创建目录 {}：{err}",
            target.display()
        )
    })?;

    // Writability probe: create then delete a temp marker file.
    let probe = target.join(".mindbase-write-probe");
    std::fs::write(&probe, b"ok")
        .map_err(|err| format!("目录不可写 {}: {err}", target.display()))?;
    let _ = std::fs::remove_file(&probe);

    Ok(normalize_path(&target))
}

/// Shared core of set/reset: switch the live connection over to `target`.
///
/// Crash-safety ordering: checkpoint → copy → open replacement → persist
/// pointer → swap connection. Any failure before the swap leaves the running
/// database untouched (copied files at the target are harmless leftovers).
///
/// `to_default` selects how the placement decision is persisted: moving back
/// to the OS-default directory removes the pointer file, any other target
/// writes one naming the new location.
fn relocate(db: &Db, target: PathBuf, migrate: bool, to_default: bool) -> Result<DataDirInfo, String> {
    let mut conn_guard = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;

    let current = {
        let guard = db
            .data_dir
            .lock()
            .map_err(|err| format!("failed to acquire database lock: {err}"))?;
        normalize_path(&guard)
    };
    if target == current {
        return Err("新目录与当前数据目录相同".to_string());
    }
    if is_strict_subdir(&target, &current) {
        return Err("新目录不能位于当前数据目录内部".to_string());
    }

    // 1. Flush the WAL into the main file so a plain file copy is complete.
    conn_guard
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .map_err(|err| format!("failed to checkpoint wal: {err}"))?;

    // 2. Copy existing data when asked. The source files stay in place —
    //    keeping them makes any failed relocation trivially reversible.
    if migrate {
        copy_db_files(&current, &target)?;
    }

    // 3. Open the replacement before touching the live connection.
    let new_conn = open_conn(&target)?;

    // 4. Persist the decision BEFORE swapping so a crash between these steps
    //    still boots into the copied data.
    if to_default {
        clear_pointer(&db.default_dir)?;
    } else {
        write_pointer(&db.default_dir, &target)?;
    }

    // 5. Swap: dropping the old connection closes it implicitly.
    *conn_guard = new_conn;
    *db.data_dir
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))? = target.clone();

    Ok(data_dir_info(&target, &db.default_dir))
}

/// Return the current data directory placement.
#[tauri::command]
pub fn get_data_dir(db: State<'_, Db>) -> Result<DataDirInfo, String> {
    let guard = db
        .data_dir
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    Ok(data_dir_info(&guard, &db.default_dir))
}

/// Switch the data directory to a user-chosen location.
///
/// `migrate=false` leaves existing data untouched and starts a fresh empty
/// database in the new location.
#[tauri::command]
pub fn set_data_dir(path: String, migrate: bool, db: State<'_, Db>) -> Result<DataDirInfo, String> {
    let target = validate_target(&path)?;
    // Moving onto the default directory is a reset: drop the pointer instead
    // of writing one that points at the default anyway.
    let to_default = normalize_path(&target) == normalize_path(&db.default_dir);
    relocate(&db, target, migrate, to_default)
}

/// Move back to the default app-data directory.
#[tauri::command]
pub fn reset_data_dir(migrate: bool, db: State<'_, Db>) -> Result<DataDirInfo, String> {
    {
        let guard = db
            .data_dir
            .lock()
            .map_err(|err| format!("failed to acquire database lock: {err}"))?;
        if *guard == db.default_dir {
            return Ok(data_dir_info(&guard, &db.default_dir));
        }
    }
    relocate(&db, db.default_dir.clone(), migrate, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pointer_target_accepts_absolute_path() {
        let payload = r#"{"dataDir": "D:\\my data\\mindbase"}"#;
        assert_eq!(pointer_target(payload), Some(PathBuf::from(r"D:\my data\mindbase")));
    }

    #[test]
    fn pointer_target_rejects_malformed_json() {
        assert_eq!(pointer_target("not json"), None);
        assert_eq!(pointer_target("{}"), None);
    }

    #[test]
    fn pointer_target_rejects_relative_path() {
        assert_eq!(pointer_target(r#"{"dataDir": "relative/path"}"#), None);
    }

    #[test]
    fn subdir_detection_is_component_wise() {
        let parent = Path::new("D:\\data");
        let child = Path::new("D:\\data\\nested");
        let sibling_prefix = Path::new("D:\\database");
        assert!(is_strict_subdir(child, parent));
        assert!(!is_strict_subdir(sibling_prefix, parent));
        assert!(!is_strict_subdir(parent, parent));
    }
}
