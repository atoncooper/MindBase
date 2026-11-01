//! SFTP 文件传输：复用交互会话的 SSH Handle 打开 sftp 子系统。
//!
//! 单文件传输上限 200MB；错误文案中文；未知会话统一报 SSH 会话不存在。

// 命令由 Lead 在 app/commands.rs 注册；注册完成前 crate 内没有调用方，
// 临时抑制 dead_code 噪音（注册后此属性可删除）。
#![allow(dead_code)]

use std::path::PathBuf;
use std::time::UNIX_EPOCH;

use russh_sftp::client::SftpSession;
use serde::Serialize;
use tokio::io::AsyncWriteExt;

use super::session::session_handle;

/// 单文件上传/下载上限（200 MB）。
const MAX_TRANSFER_BYTES: u64 = 200 * 1024 * 1024;

/// 远端目录条目。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    /// epoch 秒；0 表示服务器未提供修改时间。
    pub modified_at: i64,
}

/// 上传/下载结果。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpTransfer {
    pub bytes: u64,
}

pub(super) fn require_remote_path(path: &str) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("远端路径不能为空".to_string());
    }
    Ok(trimmed.to_string())
}

pub(super) fn require_local_path(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("本地路径不能为空".to_string());
    }
    Ok(PathBuf::from(trimmed))
}

/// 远端父目录：POSIX 风格，与 SFTP 线上协议一致。
pub(super) fn remote_parent(path: &str) -> Option<String> {
    match path.rsplit_once('/') {
        None => None,
        Some(("", _)) => Some("/".to_string()),
        Some((dir, _)) => Some(dir.to_string()),
    }
}

/// 打开一个新的 SFTP 会话（channel + subsystem）。
async fn open_sftp(session_id: &str) -> Result<SftpSession, String> {
    let handle = session_handle(session_id)?;
    let channel = {
        let guard = handle.lock().await;
        guard
            .channel_open_session()
            .await
            .map_err(|err| format!("SSH 打开 SFTP 通道失败：{err}"))?
    };
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|err| format!("SSH 启动 SFTP 子系统失败：{err}"))?;
    SftpSession::new(channel.into_stream())
        .await
        .map_err(|err| format!("SFTP 会话初始化失败：{err}"))
}

/// 列出远端目录（目录在前，按名称排序）。
#[tauri::command]
pub async fn sftp_list(session_id: String, path: String) -> Result<Vec<SftpEntry>, String> {
    let path = require_remote_path(&path)?;
    let sftp = open_sftp(&session_id).await?;
    let read_dir = sftp
        .read_dir(&path)
        .await
        .map_err(|err| format!("读取远端目录失败（{path}）：{err}"))?;
    let mut entries: Vec<SftpEntry> = Vec::new();
    for entry in read_dir {
        let metadata = entry.metadata();
        let modified_at = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|delta| delta.as_secs() as i64)
            .unwrap_or(0);
        entries.push(SftpEntry {
            name: entry.file_name(),
            path: entry.path(),
            is_dir: metadata.is_dir(),
            size: metadata.len(),
            modified_at,
        });
    }
    entries.sort_by(|left, right| {
        right
            .is_dir
            .cmp(&left.is_dir)
            .then_with(|| left.name.cmp(&right.name))
    });
    let _ = sftp.close().await;
    Ok(entries)
}

/// 下载远端文件到本地（父目录自动创建，≤200MB）。
#[tauri::command]
pub async fn sftp_download(
    session_id: String,
    remote_path: String,
    local_path: String,
) -> Result<SftpTransfer, String> {
    let remote_path = require_remote_path(&remote_path)?;
    let local_path = require_local_path(&local_path)?;
    let sftp = open_sftp(&session_id).await?;
    let metadata = sftp
        .metadata(&remote_path)
        .await
        .map_err(|err| format!("读取远端文件信息失败（{remote_path}）：{err}"))?;
    if metadata.is_dir() {
        return Err(format!("不能下载目录：{remote_path}"));
    }
    let size = metadata.len();
    if size > MAX_TRANSFER_BYTES {
        return Err(format!("文件过大（上限 200 MB，当前 {size} 字节）"));
    }
    if let Some(parent) = local_path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|err| format!("创建本地目录失败（{}）：{err}", parent.display()))?;
        }
    }
    let mut remote_file = sftp
        .open(&remote_path)
        .await
        .map_err(|err| format!("打开远端文件失败（{remote_path}）：{err}"))?;
    let mut local_file = tokio::fs::File::create(&local_path)
        .await
        .map_err(|err| format!("创建本地文件失败（{}）：{err}", local_path.display()))?;
    let bytes = tokio::io::copy(&mut remote_file, &mut local_file)
        .await
        .map_err(|err| format!("下载失败（{remote_path}）：{err}"))?;
    local_file
        .flush()
        .await
        .map_err(|err| format!("写入本地文件失败（{}）：{err}", local_path.display()))?;
    let _ = sftp.close().await;
    Ok(SftpTransfer { bytes })
}

/// 上传本地文件到远端（≤200MB；远端父目录不存在时报错）。
#[tauri::command]
pub async fn sftp_upload(
    session_id: String,
    local_path: String,
    remote_path: String,
) -> Result<SftpTransfer, String> {
    let local_path = require_local_path(&local_path)?;
    let remote_path = require_remote_path(&remote_path)?;
    let metadata = std::fs::metadata(&local_path)
        .map_err(|_| format!("本地文件不存在：{}", local_path.display()))?;
    if !metadata.is_file() {
        return Err(format!("本地路径不是文件：{}", local_path.display()));
    }
    let size = metadata.len();
    if size > MAX_TRANSFER_BYTES {
        return Err(format!("文件过大（上限 200 MB，当前 {size} 字节）"));
    }
    let sftp = open_sftp(&session_id).await?;
    if let Some(parent) = remote_parent(&remote_path) {
        if parent != "/" && sftp.metadata(&parent).await.is_err() {
            return Err(format!("远端目录不存在：{parent}"));
        }
    }
    let mut local_file = tokio::fs::File::open(&local_path)
        .await
        .map_err(|err| format!("打开本地文件失败（{}）：{err}", local_path.display()))?;
    let mut remote_file = sftp
        .create(&remote_path)
        .await
        .map_err(|err| format!("创建远端文件失败（{remote_path}）：{err}"))?;
    let bytes = tokio::io::copy(&mut local_file, &mut remote_file)
        .await
        .map_err(|err| format!("上传失败（{remote_path}）：{err}"))?;
    remote_file
        .shutdown()
        .await
        .map_err(|err| format!("写入远端文件失败（{remote_path}）：{err}"))?;
    let _ = sftp.close().await;
    Ok(SftpTransfer { bytes })
}

/// 创建远端目录（已存在会报错，交前端提示）。
#[tauri::command]
pub async fn sftp_mkdir(session_id: String, path: String) -> Result<(), String> {
    let path = require_remote_path(&path)?;
    let sftp = open_sftp(&session_id).await?;
    sftp.create_dir(&path)
        .await
        .map_err(|err| format!("创建远端目录失败（{path}）：{err}"))?;
    let _ = sftp.close().await;
    Ok(())
}

/// 删除远端文件（仅文件；目录删除被拒绝）。
#[tauri::command]
pub async fn sftp_delete(session_id: String, path: String) -> Result<(), String> {
    let path = require_remote_path(&path)?;
    let sftp = open_sftp(&session_id).await?;
    let metadata = sftp
        .metadata(&path)
        .await
        .map_err(|err| format!("读取远端路径信息失败（{path}）：{err}"))?;
    if metadata.is_dir() {
        return Err(format!("仅支持删除文件，不能删除目录：{path}"));
    }
    sftp.remove_file(&path)
        .await
        .map_err(|err| format!("删除远端文件失败（{path}）：{err}"))?;
    let _ = sftp.close().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_paths_are_required_and_parents_parsed() {
        assert!(require_remote_path("  ").is_err());
        assert_eq!(require_remote_path(" /srv/a.txt ").expect("path"), "/srv/a.txt");
        assert_eq!(remote_parent("/srv/app/run.py").as_deref(), Some("/srv/app"));
        assert_eq!(remote_parent("/run.py").as_deref(), Some("/"));
        assert_eq!(remote_parent("run.py"), None);
    }

    #[test]
    fn local_paths_are_required() {
        assert!(require_local_path("   ").is_err());
        assert_eq!(
            require_local_path(" C:/tmp/a.txt ").expect("local path"),
            PathBuf::from("C:/tmp/a.txt")
        );
    }

    #[test]
    fn sftp_entry_serializes_camel_case() {
        let entry = SftpEntry {
            name: "run.py".to_string(),
            path: "/srv/app/run.py".to_string(),
            is_dir: false,
            size: 42,
            modified_at: 1_700_000_000,
        };
        let json = serde_json::to_string(&entry).expect("serialize");
        assert!(json.contains("\"isDir\":false"), "{json}");
        assert!(json.contains("\"modifiedAt\":1700000000"), "{json}");
        let transfer = SftpTransfer { bytes: 1024 };
        assert!(serde_json::to_string(&transfer)
            .expect("serialize")
            .contains("\"bytes\":1024"));
    }
}
