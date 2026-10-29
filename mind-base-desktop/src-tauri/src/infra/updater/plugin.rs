//! Signed seamless updates through `tauri-plugin-updater`.

use std::time::Duration;

use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use super::download::DOWNLOAD_TIMEOUT;
use super::github::{REQUEST_TIMEOUT, GITHUB_HTML_BASE};
use super::types::{UpdaterInstallEvent, UpdaterMeta};
use crate::infra::config;
use crate::infra::db::Db;

/// Managed slot for the update found by `updater_check`. `Update` carries the
/// expected signature and pubkey context, so the later install command applies
/// exactly what was checked — nothing is trusted between the two calls.
#[derive(Default)]
pub struct PendingUpdate(std::sync::Mutex<Option<Update>>);

impl PendingUpdate {
    fn set(&self, update: Option<Update>) {
        if let Ok(mut slot) = self.0.lock() {
            *slot = update;
        }
    }

    /// Take the pending update out; errors when no check ran first.
    fn take(&self) -> Result<Update, String> {
        let mut slot = self
            .0
            .lock()
            .map_err(|err| format!("failed to acquire update slot lock: {err}"))?;
        slot.take().ok_or_else(|| "请先检查更新".to_string())
    }
}

/// Static JSON endpoint of the signed update channel: the `latest.json` asset
/// of the latest release. Rust keeps building it from the configurable repo
/// (instead of only relying on `plugins.updater.endpoints`) so a user-changed
/// `update_repo` keeps both channels in sync.
fn updater_endpoint(repo: &str) -> String {
    format!("{GITHUB_HTML_BASE}{repo}/releases/latest/download/latest.json")
}

/// Tauri command: check the signed-update channel (`latest.json`).
///
/// Mirrors `check_update`'s repository resolution, then hands off to
/// tauri-plugin-updater (minisign-verified payload, silent in-place install).
/// Routes through the user's proxy exactly like the manual downloader. The
/// found update parks in `PendingUpdate` until `updater_install`.
#[tauri::command]
pub async fn updater_check(
    app: AppHandle,
    db: State<'_, Db>,
    pending: State<'_, PendingUpdate>,
) -> Result<UpdaterMeta, String> {
    let repo = {
        let conn = db
            .conn
            .lock()
            .map_err(|err| format!("failed to acquire database lock: {err}"))?;
        let repo = config::load(&conn)?.update_repo;
        config::validate_update_repo(&repo)?
    };
    let endpoint = updater_endpoint(&repo);
    let current_version = app.package_info().version.to_string();

    let mut builder = app.updater_builder();
    builder = builder
        .endpoints(vec![
            tauri::Url::parse(&endpoint).map_err(|err| format!("更新地址无效：{err}"))?
        ])
        .map_err(|err| format!("更新配置无效：{err}"))?;
    if let Some(proxy) = crate::llm::api_keys::proxy_for_url(&endpoint) {
        let proxy_url = tauri::Url::parse(&proxy).map_err(|err| format!("代理地址无效：{err}"))?;
        builder = builder.proxy(proxy_url);
    }
    // Metadata fetch must fail fast; `updater_install` re-widens the timeout
    // for the payload itself.
    builder = builder.timeout(REQUEST_TIMEOUT);
    let update = builder
        .build()
        .map_err(|err| format!("初始化签名更新器失败：{err}"))?
        .check()
        .await
        .map_err(|err| format!("检查签名更新失败：{err}"))?;

    Ok(match update {
        None => {
            pending.set(None);
            UpdaterMeta {
                current_version,
                available: false,
                version: None,
                notes: None,
            }
        }
        Some(update) => {
            let meta = UpdaterMeta {
                current_version: current_version.clone(),
                available: true,
                version: Some(update.version.clone()),
                notes: update.body.clone(),
            };
            pending.set(Some(update));
            meta
        }
    })
}

/// Tauri command: download the pending signed update and install it.
///
/// On Windows the plugin launches the NSIS installer in the configured
/// install mode and then exits this process — the command never returns on
/// success there. On macOS/Linux this relaunches the app itself.
#[tauri::command]
#[allow(unused_variables)] // `app` is only touched on macOS/Linux (self-restart).
pub async fn updater_install(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
    on_event: Channel<UpdaterInstallEvent>,
) -> Result<(), String> {
    let mut update = pending.take()?;
    // The check command set the short metadata timeout; widen it for the
    // payload (both fields are public on `Update`).
    update.timeout = Some(DOWNLOAD_TIMEOUT);

    let mut received: u64 = 0;
    let mut last_emit = std::time::Instant::now();
    update
        .download_and_install(
            |chunk, total| {
                received += chunk as u64;
                if last_emit.elapsed() >= Duration::from_millis(250) {
                    let _ = on_event.send(UpdaterInstallEvent::Progress {
                        received,
                        total_bytes: total,
                    });
                    last_emit = std::time::Instant::now();
                }
            },
            || {
                let _ = on_event.send(UpdaterInstallEvent::Downloaded);
            },
        )
        .await
        .map_err(|err| format!("签名更新安装失败：{err}"))?;

    // Windows exits inside install(); reaching this means macOS/Linux, where
    // the app must relaunch itself to run the new version.
    #[cfg(not(windows))]
    app.restart();

    #[cfg(windows)]
    Ok(())
}
