//! Model registry: known models, on-disk layouts and download status/progress.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use crate::infra::logging;

use super::download::download_model;

/// Default port when the stored config predates this change (0 / unset).
/// 8000 (the old default) collides with the backend dev server that often
/// runs on this machine, so the packaged default moves to 8765.
pub(crate) const DEFAULT_PORT: u16 = 8765;

/// Where the whisper model weights are downloaded to (persists across runs).
/// One sub-directory per model: `<data_dir>/whisper-models/<model>/model.bin`.
pub(super) fn models_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("whisper-models")
}

// ---------------------------------------------------------------------------
// Model management: status, explicit download with progress, path resolution
// ---------------------------------------------------------------------------

/// The whisper models offered in the API-设置 model card (id, label, approx
/// total download size in bytes). All are Systran/faster-whisper-* CT2 repos.
pub(crate) const KNOWN_MODELS: &[(&str, &str, u64)] = &[
    ("tiny", "Tiny（最快，精度低）", 78_000_000),
    ("base", "Base（快）", 148_000_000),
    ("small", "Small（推荐，速度精度均衡）", 492_000_000),
    ("medium", "Medium（更准，较慢）", 1_540_000_000),
    ("large-v3", "Large-v3（最准，CPU 上很慢）", 3_100_000_000),
];

/// The non-weight files every CT2 model dir needs beside `model.bin`. Files
/// the repo doesn't ship are skipped (404), so this list may be a superset.
pub(super) const MODEL_AUX_FILES: &[&str] = &[
    "config.json",
    "preprocessor_config.json",
    "tokenizer.json",
    "vocabulary.txt",
    "vocabulary.json",
];

/// Per-model download progress, polled by the settings UI.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAsrModelStatus {
    pub model: String,
    pub label: String,
    /// Approximate full-download size for display before totals are known.
    pub approx_size_bytes: u64,
    pub downloaded: bool,
    pub downloading: bool,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub(super) struct DownloadState {
    pub(super) downloaded_bytes: u64,
    pub(super) total_bytes: u64,
    pub(super) error: Option<String>,
}

/// Process-global download progress registry (keyed by model id).
static DOWNLOADS: OnceLock<Mutex<std::collections::HashMap<String, DownloadState>>> =
    OnceLock::new();

pub(super) fn downloads_slot() -> &'static Mutex<std::collections::HashMap<String, DownloadState>> {
    DOWNLOADS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// The plain per-model dir in the new layout.
pub(super) fn model_dir(data_dir: &Path, model: &str) -> PathBuf {
    models_dir(data_dir).join(model)
}

/// Legacy-layout path: a complete HF-hub snapshot (downloaded by an earlier
/// build through the HF SDK). faster-whisper passes `download_root` straight
/// through as `snapshot_download`'s `cache_dir`, so the repo dir may sit
/// directly under `whisper-models/` (explicit cache_dir) or under
/// `whisper-models/hub/` (HF_HOME default) — both are recognized.
fn hf_snapshot_dir(data_dir: &Path, model: &str) -> Option<PathBuf> {
    let base = models_dir(data_dir);
    for repo_root in [base.join("hub"), base] {
        let repo = repo_root.join(format!("models--Systran--faster-whisper-{model}"));
        let commit = match std::fs::read_to_string(repo.join("refs").join("main")) {
            Ok(text) => text.trim().to_string(),
            Err(_) => continue,
        };
        if commit.is_empty() {
            continue;
        }
        let snapshot = repo.join("snapshots").join(commit);
        if snapshot.join("model.bin").is_file() {
            return Some(snapshot);
        }
    }
    None
}

/// Resolve the local directory holding a fully downloaded model, `None` when
/// it is not available. Both layouts count as downloaded.
pub(crate) fn resolve_model_path(data_dir: &Path, model: &str) -> Option<PathBuf> {
    let plain = model_dir(data_dir, model);
    if plain.join("model.bin").is_file() && plain.join("config.json").is_file() {
        return Some(plain);
    }
    hf_snapshot_dir(data_dir, model)
}

/// Status of every known model (downloaded? progress? error?).
pub fn model_status_list(data_dir: &Path) -> Vec<LocalAsrModelStatus> {
    let downloads = downloads_slot()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    KNOWN_MODELS
        .iter()
        .map(|(id, label, approx)| {
            let state = downloads.get(*id);
            LocalAsrModelStatus {
                model: id.to_string(),
                label: label.to_string(),
                approx_size_bytes: *approx,
                downloaded: resolve_model_path(data_dir, id).is_some(),
                downloading: state.is_some() && state.unwrap().error.is_none(),
                downloaded_bytes: state.map(|s| s.downloaded_bytes).unwrap_or(0),
                total_bytes: state.map(|s| s.total_bytes).unwrap_or(0),
                error: state.and_then(|s| s.error.clone()),
            }
        })
        .collect()
}

/// Kick off a background download for `model`. Idempotent: a completed model
/// is a no-op, an in-flight one is not duplicated.
pub fn start_model_download(data_dir: PathBuf, model: String) -> Result<(), String> {
    let (_, label, _) = KNOWN_MODELS
        .iter()
        .find(|(id, _, _)| *id == model)
        .ok_or_else(|| format!("未知模型：{model}"))?;
    if resolve_model_path(&data_dir, &model).is_some() {
        return Ok(()); // already downloaded
    }
    {
        let mut downloads = downloads_slot()
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        match downloads.get(&model) {
            // In-flight (no error yet): don't spawn a second downloader.
            Some(state) if state.error.is_none() => return Ok(()),
            _ => {
                downloads.insert(
                    model.clone(),
                    DownloadState {
                        downloaded_bytes: 0,
                        total_bytes: 0,
                        error: None,
                    },
                );
            }
        }
    }
    logging::info(
        "whisper",
        &format!("开始下载本地 ASR 模型：{model}（{label}）"),
    );
    std::thread::spawn(move || {
        let outcome = download_model(&data_dir, &model);
        let mut downloads = downloads_slot()
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        match outcome {
            Ok(()) => {
                logging::info("whisper", &format!("本地 ASR 模型下载完成：{model}"));
                downloads.remove(&model); // downloaded=true now covers it
            }
            Err(err) => {
                logging::error("whisper", &format!("本地 ASR 模型下载失败 {model}：{err}"));
                downloads.insert(
                    model.clone(),
                    DownloadState {
                        downloaded_bytes: 0,
                        total_bytes: 0,
                        error: Some(err),
                    },
                );
            }
        }
    });
    Ok(())
}
