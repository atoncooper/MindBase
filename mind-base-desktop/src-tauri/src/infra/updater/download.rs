//! Installer download with throttled progress events.

use std::io::Read;
use std::time::Duration;

use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use super::github::{
    parse_release_url, pick_windows_installer, request_release_routed, GITHUB_API_BASE, USER_AGENT,
};
use super::types::{GithubAsset, UpdateDownloadEvent, UpdateDownloadSummary};
use crate::infra::config;
use crate::infra::db::Db;

/// Whole-request budget for downloading one installer (a release build is
/// tens of MB; a mainland connection through a proxy can be slow).
pub(super) const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(1800);

/// Stream one asset to disk with throttled progress events. Writes to a
/// `.part` sibling first so a killed download never leaves a half installer
/// that could later be launched.
fn download_asset(
    asset: &GithubAsset,
    dest: &std::path::Path,
    channel: &Channel<UpdateDownloadEvent>,
) -> Result<u64, String> {
    let (primary, fallback) =
        crate::llm::api_keys::egress_agents(DOWNLOAD_TIMEOUT, &asset.browser_download_url)?;
    // The fallback only covers the initial connect: once bytes start flowing
    // the download is committed to the chosen route (a mid-stream retry would
    // restart the file from zero anyway).
    let response = match primary
        .get(&asset.browser_download_url)
        .set("User-Agent", USER_AGENT)
        .call()
    {
        Ok(response) => response,
        Err(err) => match &fallback {
            Some(agent) => agent
                .get(&asset.browser_download_url)
                .set("User-Agent", USER_AGENT)
                .call()
                .map_err(|retry| format!("安装包下载失败：{err}；回退重试仍失败：{retry}"))?,
            None => return Err(format!("安装包下载失败：{err}")),
        },
    };
    if response.status() != 200 {
        return Err(format!("安装包下载失败：HTTP {}", response.status()));
    }

    let total = asset.size;
    let part_path = dest.with_extension("part");
    let mut file = std::fs::File::create(&part_path)
        .map_err(|err| format!("无法创建下载文件 {}：{err}", part_path.display()))?;
    let mut reader = response.into_reader();
    let mut buf = [0u8; 64 * 1024];
    let mut received: u64 = 0;
    let mut last_emit = std::time::Instant::now();
    loop {
        let read = reader
            .read(&mut buf)
            .map_err(|err| format!("下载中断：{err}"))?;
        if read == 0 {
            break;
        }
        std::io::Write::write_all(&mut file, &buf[..read])
            .map_err(|err| format!("写入下载文件失败：{err}"))?;
        received += read as u64;
        if last_emit.elapsed() >= Duration::from_millis(250) {
            let _ = channel.send(UpdateDownloadEvent::Progress {
                received,
                total_bytes: total,
            });
            last_emit = std::time::Instant::now();
        }
    }
    file.sync_all()
        .map_err(|err| format!("写入下载文件失败：{err}"))?;
    drop(file);
    if received != total {
        return Err(format!(
            "下载不完整（{} / {} 字节），请重试",
            received, total
        ));
    }
    std::fs::rename(&part_path, dest).map_err(|err| format!("无法完成下载文件：{err}"))?;
    let _ = channel.send(UpdateDownloadEvent::Done {
        path: dest.to_string_lossy().to_string(),
        bytes: received,
    });
    Ok(received)
}

/// Download the Windows installer of one release into `<data>/updates/`.
#[tauri::command]
pub async fn download_update(
    app: AppHandle,
    db: State<'_, Db>,
    release_url: String,
    on_event: Channel<UpdateDownloadEvent>,
) -> Result<UpdateDownloadSummary, String> {
    let (repo, tag) = parse_release_url(release_url.trim())?;
    let updates_dir = {
        let conn = db
            .conn
            .lock()
            .map_err(|err| format!("failed to acquire database lock: {err}"))?;
        let _ = config::load(&conn)?; // config sanity before a long download
        app.state::<Db>()
            .data_dir
            .lock()
            .map(|dir| dir.join("updates"))
            .map_err(|err| format!("failed to acquire data dir lock: {err}"))?
    };

    tauri::async_runtime::spawn_blocking(move || {
        let url = format!("{GITHUB_API_BASE}/repos/{repo}/releases/tags/{tag}");
        let release = request_release_routed(&url)?;
        let asset = pick_windows_installer(&release.assets)
            .ok_or_else(|| "该版本没有提供 Windows x64 安装包，请到发布页手动下载".to_string())?;

        let _ = on_event.send(UpdateDownloadEvent::Start {
            total_bytes: asset.size,
        });
        std::fs::create_dir_all(&updates_dir).map_err(|err| format!("无法创建更新目录：{err}"))?;
        let dest = updates_dir.join(&asset.name);
        let bytes = download_asset(asset, &dest, &on_event)?;
        Ok(UpdateDownloadSummary {
            path: dest.to_string_lossy().to_string(),
            bytes,
        })
    })
    .await
    .map_err(|err| format!("download task failed: {err}"))?
}
