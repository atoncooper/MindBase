//! Pointer file and relocation protocol for the active data directory.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use super::connection::{open_conn, Db, DB_FILE_NAME};

/// Pointer file inside the DEFAULT dir naming the custom data directory.
const POINTER_FILE_NAME: &str = "data-location.json";

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
pub(super) fn normalize_path(p: &Path) -> PathBuf {
    let canonical = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let text = canonical.as_os_str().to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => canonical,
    }
}

pub(super) fn default_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
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
pub(super) fn read_custom_dir(default_dir: &Path) -> Option<PathBuf> {
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

pub(super) fn data_dir_info(current: &Path, default_dir: &Path) -> DataDirInfo {
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
    let meta =
        std::fs::metadata(&main_src).map_err(|err| format!("source database missing: {err}"))?;
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
pub(super) fn validate_target(requested: &str) -> Result<PathBuf, String> {
    let raw = requested.trim();
    if raw.is_empty() {
        return Err("数据目录路径不能为空".to_string());
    }
    let target = PathBuf::from(raw);
    if !target.is_absolute() {
        return Err(format!("请选择完整的绝对路径（含盘符），收到：{raw}"));
    }
    std::fs::create_dir_all(&target)
        .map_err(|err| format!("无法创建目录 {}：{err}", target.display()))?;

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
pub(super) fn relocate(
    db: &Db,
    target: PathBuf,
    migrate: bool,
    to_default: bool,
) -> Result<DataDirInfo, String> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pointer_target_accepts_absolute_path() {
        let payload = r#"{"dataDir": "D:\\my data\\mindbase"}"#;
        assert_eq!(
            pointer_target(payload),
            Some(PathBuf::from(r"D:\my data\mindbase"))
        );
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
