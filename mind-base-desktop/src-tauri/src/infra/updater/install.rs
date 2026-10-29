//! Launch a downloaded installer.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::infra::db::Db;

/// Launch a downloaded installer (NSIS setup.exe or MSI). The installer takes
/// over from there — Tauri's NSIS build prompts to close the running app and
/// its bundled uninstaller replaces the old version.
#[tauri::command]
pub fn run_update_installer(app: AppHandle, path: String) -> Result<(), String> {
    let path = PathBuf::from(path.trim());
    let allowed_dir = {
        let db = app.state::<Db>();
        db.data_dir
            .lock()
            .map(|dir| dir.join("updates"))
            .map_err(|err| format!("failed to acquire data dir lock: {err}"))?
    };
    // Only files this app itself downloaded may be launched.
    if !path.starts_with(&allowed_dir) {
        return Err("只允许启动应用下载的安装包".to_string());
    }
    if !path.is_file() {
        return Err(format!("安装包不存在：{}", path.display()));
    }
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if name.ends_with(".msi") {
        std::process::Command::new("msiexec")
            .arg("/i")
            .arg(&path)
            .spawn()
            .map_err(|err| format!("无法启动安装程序：{err}"))?;
    } else if name.ends_with(".exe") {
        std::process::Command::new(&path)
            .spawn()
            .map_err(|err| format!("无法启动安装程序：{err}"))?;
    } else {
        return Err("该文件不是可执行的安装包".to_string());
    }
    Ok(())
}
