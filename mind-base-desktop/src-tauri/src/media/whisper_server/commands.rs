//! Tauri commands and startup hook for the local ASR model card / server.

use tauri::{Manager, State};

use crate::infra::db::Db;
use crate::infra::logging;

use super::models::{model_status_list, start_model_download, LocalAsrModelStatus};
use super::process::ensure_running;

/// Status of every known local ASR model (downloaded? progress? error?) for
/// the API-设置 model card. The UI polls this while downloads are active.
#[tauri::command]
pub fn local_asr_model_status(db: State<'_, Db>) -> Result<Vec<LocalAsrModelStatus>, String> {
    let data_dir = db
        .data_dir
        .lock()
        .map(|dir| dir.clone())
        .map_err(|_| "failed to read data dir".to_string())?;
    Ok(model_status_list(&data_dir))
}

/// Start a background download for one known model (no-op when already
/// downloaded or in flight). Progress is observed via `local_asr_model_status`.
#[tauri::command]
pub fn local_asr_model_download(db: State<'_, Db>, model: String) -> Result<(), String> {
    let data_dir = db
        .data_dir
        .lock()
        .map(|dir| dir.clone())
        .map_err(|_| "failed to read data dir".to_string())?;
    start_model_download(data_dir, model)
}

/// Best-effort startup spawn: start the server when local mode is on. Never
/// blocks app launch - errors are logged and the ingestion-time
/// [`ensure_running`] retries (it can also show the error to the user).
pub fn startup_spawn(app: &tauri::AppHandle) {
    let db = app.state::<crate::infra::db::Db>();
    let (cfg, data_dir) = match (db.conn.lock(), db.data_dir.lock()) {
        (Ok(conn), Ok(dir)) => {
            let cfg = crate::infra::config::load(&conn).ok();
            (cfg, dir.clone())
        }
        _ => {
            logging::warn("whisper", "启动本地 ASR 失败：无法读取数据库状态");
            return;
        }
    };
    let Some(cfg) = cfg else {
        return;
    };
    if !cfg.local_asr.enabled {
        return;
    }
    // Off the startup path: provisioning (download + pip) can take minutes.
    let cfg = cfg.local_asr.clone();
    std::thread::spawn(move || match ensure_running(&cfg, &data_dir) {
        Ok(base) => logging::info("whisper", &format!("启动时本地 ASR 已就绪：{base}")),
        Err(err) => logging::warn(
            "whisper",
            &format!("启动本地 ASR 未成功（入库时会重试）：{err}"),
        ),
    });
}
