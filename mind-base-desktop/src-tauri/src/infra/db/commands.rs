//! Tauri commands exposing the active data-directory placement.

use tauri::State;

use super::connection::Db;
use super::data_dir::{data_dir_info, normalize_path, relocate, validate_target, DataDirInfo};

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
