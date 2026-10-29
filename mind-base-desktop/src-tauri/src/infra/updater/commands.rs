//! Tauri command for the manual (GitHub release) update check.

use tauri::{AppHandle, State};

use super::github::{fetch_latest_release, is_newer_version, safe_release_url, strip_tag_prefix};
use super::types::UpdateInfo;
use crate::infra::config;
use crate::infra::db::Db;

/// Tauri command: check GitHub for a newer desktop release.
#[tauri::command]
pub async fn check_update(app: AppHandle, db: State<'_, Db>) -> Result<UpdateInfo, String> {
    let repo = {
        let conn = db
            .conn
            .lock()
            .map_err(|err| format!("failed to acquire database lock: {err}"))?;
        config::load(&conn)?.update_repo
    };
    // Same shared rule that guards writes in `set_config`; re-checking here
    // also defends against rows persisted by older builds before strict
    // validation existed.
    let repo = config::validate_update_repo(&repo)?;
    let current_version = app.package_info().version.to_string();

    // Blocking network IO must stay off the async runtime worker threads.
    let release = tauri::async_runtime::spawn_blocking(move || fetch_latest_release(&repo))
        .await
        .map_err(|err| format!("update check task failed: {err}"))??;

    Ok(UpdateInfo {
        has_update: is_newer_version(&release.tag_name, &current_version),
        current_version,
        latest_version: strip_tag_prefix(&release.tag_name),
        release_url: safe_release_url(&release.html_url),
        release_notes: release.body,
        published_at: release.published_at,
    })
}
