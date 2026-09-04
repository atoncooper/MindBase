//! Local OCR model management (download + status).
//!
//! The local OCR pipeline is RapidOCR over PP-OCRv4 ONNX models. A "model"
//! here is a *bundle*: detection + recognition + classification ONNX files
//! that together make a usable OCR pipeline. Bundles are downloaded from the
//! RapidAI/RapidOCR repo on ModelScope (mainland-friendly CDN, no proxy
//! needed) into `<data_dir>/ocr-models/<bundle>/` as `det.onnx`, `rec.onnx`,
//! `cls.onnx`.
//!
//! This module intentionally mirrors the local-ASR model card mechanics in
//! `whisper_server.rs` (global progress registry + background download
//! thread + resumable file fetch). The inference/runtime wiring that
//! *consumes* these bundles ships separately; `resolve_model_dir` is the
//! handoff point.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use tauri::State;

use crate::db::Db;
use crate::logging;
use crate::whisper_server::{download_agents, download_file};

/// Base URL for all bundle files (ModelScope repo raw-file endpoint).
const REPO_BASE: &str = "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/master/";

/// The OCR model bundles offered in the API-设置 model card.
///
/// Tuple: (id, label, approx total download bytes, files). Each file entry
/// is (repo-relative path, local file name inside the bundle dir). `cls` is
/// shared by both bundles — it is a direction classifier, not a weight-heavy
/// det/rec model.
pub(crate) const KNOWN_MODELS: &[(&str, &str, u64, &[(&str, &str)])] = &[
    (
        "pp-ocrv4-mobile",
        "PP-OCRv4 Mobile（推荐，CPU 快）",
        16_500_000,
        &[
            ("onnx/PP-OCRv4/det/ch_PP-OCRv4_det_mobile.onnx", "det.onnx"),
            ("onnx/PP-OCRv4/rec/ch_PP-OCRv4_rec_mobile.onnx", "rec.onnx"),
            (
                "onnx/PP-OCRv4/cls/ch_ppocr_mobile_v2.0_cls_mobile.onnx",
                "cls.onnx",
            ),
        ],
    ),
    (
        "pp-ocrv4-server",
        "PP-OCRv4 Server（更准，较慢）",
        205_000_000,
        &[
            ("onnx/PP-OCRv4/det/ch_PP-OCRv4_det_server.onnx", "det.onnx"),
            ("onnx/PP-OCRv4/rec/ch_PP-OCRv4_rec_server.onnx", "rec.onnx"),
            (
                "onnx/PP-OCRv4/cls/ch_ppocr_mobile_v2.0_cls_mobile.onnx",
                "cls.onnx",
            ),
        ],
    ),
];

/// Where the OCR model bundles live (one sub-directory per bundle).
pub(crate) fn models_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("ocr-models")
}

fn bundle_dir(data_dir: &Path, model: &str) -> PathBuf {
    models_dir(data_dir).join(model)
}

/// Resolve the local directory holding a fully downloaded bundle, `None`
/// when any bundle file is missing (a partial download does not count).
pub(crate) fn resolve_model_dir(data_dir: &Path, model: &str) -> Option<PathBuf> {
    let (_, _, _, files) = KNOWN_MODELS.iter().find(|(id, _, _, _)| *id == model)?;
    let dir = bundle_dir(data_dir, model);
    files
        .iter()
        .all(|(_, name)| dir.join(name).is_file())
        .then_some(dir)
}

/// Per-bundle download progress, polled by the settings UI.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalOcrModelStatus {
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
struct DownloadState {
    downloaded_bytes: u64,
    total_bytes: u64,
    error: Option<String>,
}

/// Process-global download progress registry (keyed by bundle id).
static DOWNLOADS: OnceLock<Mutex<std::collections::HashMap<String, DownloadState>>> =
    OnceLock::new();

fn downloads_slot() -> &'static Mutex<std::collections::HashMap<String, DownloadState>> {
    DOWNLOADS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// Status of every known bundle (downloaded? progress? error?).
pub fn model_status_list(data_dir: &Path) -> Vec<LocalOcrModelStatus> {
    let downloads = downloads_slot()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    KNOWN_MODELS
        .iter()
        .map(|(id, label, approx, _)| {
            let state = downloads.get(*id);
            LocalOcrModelStatus {
                model: id.to_string(),
                label: label.to_string(),
                approx_size_bytes: *approx,
                downloaded: resolve_model_dir(data_dir, id).is_some(),
                downloading: state.is_some() && state.unwrap().error.is_none(),
                downloaded_bytes: state.map(|s| s.downloaded_bytes).unwrap_or(0),
                total_bytes: state.map(|s| s.total_bytes).unwrap_or(0),
                error: state.and_then(|s| s.error.clone()),
            }
        })
        .collect()
}

/// Kick off a background download for `model`. Idempotent: a completed
/// bundle is a no-op, an in-flight one is not duplicated.
pub fn start_model_download(data_dir: PathBuf, model: String) -> Result<(), String> {
    let entry = KNOWN_MODELS
        .iter()
        .find(|(id, _, _, _)| *id == model)
        .ok_or_else(|| format!("未知模型：{model}"))?;
    if resolve_model_dir(&data_dir, &model).is_some() {
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
        "ocr",
        &format!("开始下载本地 OCR 模型：{model}（{}）", entry.1),
    );
    std::thread::spawn(move || {
        let outcome = download_model(&data_dir, &model);
        let mut downloads = downloads_slot()
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        match outcome {
            Ok(()) => {
                logging::info("ocr", &format!("本地 OCR 模型下载完成：{model}"));
                downloads.remove(&model); // downloaded=true now covers it
            }
            Err(err) => {
                logging::error("ocr", &format!("本地 OCR 模型下载失败 {model}：{err}"));
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

/// Download one bundle into `ocr-models/<model>/`, tracking progress in the
/// global registry. Runs on a worker thread. Progress accounting centers on
/// the recognition weights (`rec.onnx`, the largest file); the smaller det /
/// cls files only shift the reported bar by a few MB.
fn download_model(data_dir: &Path, model: &str) -> Result<(), String> {
    let (_, _, _, files) = KNOWN_MODELS
        .iter()
        .find(|(id, _, _, _)| *id == model)
        .ok_or_else(|| format!("未知模型：{model}"))?;
    let dir = bundle_dir(data_dir, model);
    std::fs::create_dir_all(&dir)
        .map_err(|err| format!("无法创建模型目录 {}：{err}", dir.display()))?;
    let agents = download_agents()?;

    let update = |file_downloaded: u64, file_total: u64| {
        let mut downloads = downloads_slot()
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if let Some(state) = downloads.get_mut(model) {
            state.downloaded_bytes = file_downloaded;
            state.total_bytes = file_total;
        }
    };

    for (remote, name) in files.iter() {
        let dest = dir.join(name);
        if dest.is_file() {
            continue;
        }
        let url = format!("{REPO_BASE}{remote}");
        let is_rec = *name == "rec.onnx";
        let mut local = 0u64;
        download_file(&agents, &url, &dest, &mut |have, total| {
            local = have;
            // Only the biggest file drives the visible bar; smaller files
            // report (0, 0) so they don't jump the progress around.
            if is_rec {
                update(have, total);
            }
        })
        .map_err(|err| format!("下载 {remote} 失败：{err}"))?;
        logging::info(
            "ocr",
            &format!("模型文件完成：{model}/{name}（{local} 字节）"),
        );
    }

    // Sanity: the dir must now hold a complete bundle.
    if resolve_model_dir(data_dir, model).is_none() {
        return Err("下载完成但模型目录不完整（缺 det/rec/cls 之一）".to_string());
    }
    Ok(())
}

/// Status of every known local OCR bundle for the API-设置 model card. The
/// UI polls this while downloads are active.
#[tauri::command]
pub fn local_ocr_model_status(db: State<'_, Db>) -> Result<Vec<LocalOcrModelStatus>, String> {
    let data_dir = db
        .data_dir
        .lock()
        .map(|dir| dir.clone())
        .map_err(|_| "failed to read data dir".to_string())?;
    Ok(model_status_list(&data_dir))
}

/// Start a background download for one known bundle (no-op when already
/// downloaded or in flight). Progress is observed via `local_ocr_model_status`.
#[tauri::command]
pub fn local_ocr_model_download(db: State<'_, Db>, model: String) -> Result<(), String> {
    let data_dir = db
        .data_dir
        .lock()
        .map(|dir| dir.clone())
        .map_err(|_| "failed to read data dir".to_string())?;
    start_model_download(data_dir, model)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn unknown_bundle_is_rejected() {
        let dir = std::env::temp_dir().join(format!("mb-ocr-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(start_model_download(dir.clone(), "nope".to_string()).is_err());
        assert!(resolve_model_dir(&dir, "nope").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bundle_layout_detection() {
        let dir = std::env::temp_dir().join(format!("mb-ocr-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let bundle = bundle_dir(&dir, "pp-ocrv4-mobile");
        std::fs::create_dir_all(&bundle).unwrap();
        assert!(
            resolve_model_dir(&dir, "pp-ocrv4-mobile").is_none(),
            "empty dir"
        );
        std::fs::write(bundle.join("det.onnx"), b"x").unwrap();
        std::fs::write(bundle.join("rec.onnx"), b"x").unwrap();
        assert!(
            resolve_model_dir(&dir, "pp-ocrv4-mobile").is_none(),
            "missing cls"
        );
        std::fs::write(bundle.join("cls.onnx"), b"x").unwrap();
        assert_eq!(
            resolve_model_dir(&dir, "pp-ocrv4-mobile"),
            Some(bundle.clone()),
            "complete bundle resolves"
        );
        // Status list reflects the completed download.
        let status = model_status_list(&dir);
        assert_eq!(status.len(), KNOWN_MODELS.len());
        let mobile = status
            .iter()
            .find(|s| s.model == "pp-ocrv4-mobile")
            .unwrap();
        assert!(mobile.downloaded && !mobile.downloading && mobile.error.is_none());
        let server = status
            .iter()
            .find(|s| s.model == "pp-ocrv4-server")
            .unwrap();
        assert!(!server.downloaded);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Real network download of the mobile bundle (~16MB), exercising the
    /// shared resumable downloader + ModelScope URLs end-to-end. Opt-in:
    /// `cargo test --lib ocr_server -- --ignored`.
    #[test]
    #[ignore]
    fn downloads_mobile_bundle_end_to_end() {
        let dir = std::env::temp_dir().join("mindbase-ocr-dl-test");
        std::fs::create_dir_all(&dir).unwrap();
        start_model_download(dir.clone(), "pp-ocrv4-mobile".to_string()).unwrap();
        for _ in 0..600 {
            if resolve_model_dir(&dir, "pp-ocrv4-mobile").is_some() {
                break;
            }
            std::thread::sleep(Duration::from_secs(1));
        }
        let path = resolve_model_dir(&dir, "pp-ocrv4-mobile").expect("bundle should download");
        let rec = std::fs::metadata(path.join("rec.onnx")).unwrap().len();
        assert!(rec > 10_000_000, "rec.onnx implausibly small: {rec}");
        let status = model_status_list(&dir);
        let mobile = status
            .iter()
            .find(|s| s.model == "pp-ocrv4-mobile")
            .unwrap();
        assert!(mobile.downloaded && !mobile.downloading && mobile.error.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
