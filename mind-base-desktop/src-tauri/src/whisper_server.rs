//! Local ASR server lifecycle management.
//!
//! When the user selects the local ASR mode in API 设置, ingestion routes
//! ASR to a locally run, OpenAI-compatible whisper server, which
//! [`crate::asr`] already consumes - so **no transcription code changes are
//! needed**, only this process manager that provides the local base URL.
//!
//! The server itself is `scripts/whisper_server.py` (faster-whisper +
//! FastAPI) running under the app's self-contained embedded Python (provision
//! on first use): dependencies are pip-installed automatically and the
//! whisper model is downloaded from HuggingFace (hf-mirror when
//! huggingface.co is unreachable) into `<data_dir>/whisper-models`. Nothing
//! needs to be installed by hand and no cloud API key is required.
//!
//! Lifecycle rules (idempotent, safe to call at startup and on every
//! ingestion run):
//!
//! 1. A port already serving **our** server (the `/health` marker, see
//!    below) is reused - the app will not spawn a second one and will not
//!    shut it down on exit. A port serving anything else is a conflict and
//!    reported as an error (the old behavior of blindly reusing any HTTP
//!    listener silently misrouted ASR to an unrelated local service, e.g. a
//!    dev backend on the same port).
//! 2. Otherwise spawn `python whisper_server.py --host 127.0.0.1 --port <p>
//!    --model <m> --hf-home <data>/whisper-models` as a detached child, then
//!    poll `/health` until it responds (or the readiness timeout elapses).
//!    `/health` answers as soon as the HTTP listener is up; the whisper
//!    model keeps loading/downloading in the background and transcription
//!    requests wait for it (bounded) server-side.
//! 3. The spawned child handle is kept in a process-global registry and
//!    killed on app exit ([`shutdown`]) - the model download dir persists,
//!    so the next start needs no re-download.
//!
//! Only one instance of the desktop app is expected to run at a time, so a
//! process-wide registry (rather than threading state through `AsrClient`)
//! is the simplest correct home for the child handle.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command as StdCommand, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{Manager, State};

use crate::config::LocalAsrConfig;
use crate::db::Db;
use crate::logging;

/// Poll interval while waiting for readiness.
const READY_POLL: Duration = Duration::from_millis(500);
/// Default port when the stored config predates this change (0 / unset).
/// 8000 (the old default) collides with the backend dev server that often
/// runs on this machine, so the packaged default moves to 8765.
pub(crate) const DEFAULT_PORT: u16 = 8765;
/// Marker the local server reports at `/health` (`server` field), proving
/// the listener is our whisper server rather than an unrelated HTTP app.
const SERVER_MARKER: &str = "mindbase-whisper";
/// Effective port: stored config, or [`DEFAULT_PORT`] when unset/zero.
fn effective_port(cfg: &LocalAsrConfig) -> u16 {
    if cfg.port == 0 {
        DEFAULT_PORT
    } else {
        cfg.port
    }
}

/// The base URL for a local server on the given port (`http://127.0.0.1:{p}/v1`).
pub fn local_base_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/v1")
}

/// What is listening on a probed port.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PortState {
    /// Nothing answered.
    NotServing,
    /// Our whisper server answered `/health` with the marker.
    Ours,
    /// Something HTTP answered but it is not our server.
    Foreign,
}

/// Probe the port: resolve to [`PortState::Ours`] only when `/health` answers
/// with our server marker; any other HTTP response is `Foreign`.
fn probe_port(port: u16) -> PortState {
    let url = format!("http://127.0.0.1:{port}/health");
    let response = ureq::get(&url).timeout(Duration::from_secs(3)).call();
    match response {
        Ok(resp) => {
            let ours = resp
                .into_string()
                .ok()
                .and_then(|body| serde_json::from_str::<serde_json::Value>(&body).ok())
                .and_then(|value| {
                    value
                        .get("server")
                        .and_then(|s| s.as_str())
                        .map(|s| s == SERVER_MARKER)
                })
                .unwrap_or(false);
            if ours {
                PortState::Ours
            } else {
                PortState::Foreign
            }
        }
        Err(ureq::Error::Status(_, _)) => PortState::Foreign,
        Err(_) => PortState::NotServing,
    }
}

/// Process-global registry of the child we spawned. Tracks the port and
/// model the child was started with so a config change (user edits the port
/// or switches model in API 设置) is detected: a mismatching live child is
/// stopped and respawned with the new settings instead of being silently
/// reused while the caller waits on a port that will never open.
struct ManagedChild {
    port: u16,
    model: String,
    child: Child,
}

static MANAGED_CHILD: OnceLock<Mutex<Option<ManagedChild>>> = OnceLock::new();

fn child_slot() -> &'static Mutex<Option<ManagedChild>> {
    MANAGED_CHILD.get_or_init(|| Mutex::new(None))
}

/// Resolve the embedded Python and ensure the server's dependencies are
/// installed, returning the interpreter path.
fn ensure_interpreter(data_dir: &Path) -> Result<PathBuf, String> {
    let exe = crate::python_runtime::ensure_server_deps(data_dir)?;
    Ok(exe)
}

/// Where the whisper model weights are downloaded to (persists across runs).
/// One sub-directory per model: `<data_dir>/whisper-models/<model>/model.bin`.
fn models_dir(data_dir: &Path) -> PathBuf {
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
const MODEL_AUX_FILES: &[&str] = &[
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
struct DownloadState {
    downloaded_bytes: u64,
    total_bytes: u64,
    error: Option<String>,
}

/// Process-global download progress registry (keyed by model id).
static DOWNLOADS: OnceLock<Mutex<std::collections::HashMap<String, DownloadState>>> =
    OnceLock::new();

fn downloads_slot() -> &'static Mutex<std::collections::HashMap<String, DownloadState>> {
    DOWNLOADS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// The plain per-model dir in the new layout.
fn model_dir(data_dir: &Path, model: &str) -> PathBuf {
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

/// Direct (no-proxy) and optional proxied agents for model downloads. The
/// hf-mirror + HF CDN hosts answer fine directly on mainland networks while
/// an overseas-exit proxy stalls the big files, so direct is preferred; the
/// proxy is the fallback for networks that need it. Also reused by the
/// local-OCR model downloader (`ocr_server`).
pub(crate) struct DownloadAgents {
    pub(crate) direct: ureq::Agent,
    pub(crate) via_proxy: Option<ureq::Agent>,
}

pub(crate) fn download_agents() -> Result<DownloadAgents, String> {
    // Read timeouts must be per-read (streaming a multi-GB body), not overall.
    let builder = || {
        ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(15))
            .timeout_read(Duration::from_secs(60))
    };
    let direct = builder().build();
    let via_proxy = crate::api_keys::proxied_agent(Duration::from_secs(60))?;
    Ok(DownloadAgents {
        direct,
        via_proxy: via_proxy.map(|_| builder().build()),
    })
}

/// Download one repo file into `dest` with resume support (`.part` suffix).
/// `on_progress` receives (downloaded, total) for the whole file. Shared
/// with the local-OCR model downloader.
pub(crate) fn download_file(
    agents: &DownloadAgents,
    url: &str,
    dest: &Path,
    on_progress: &mut dyn FnMut(u64, u64),
) -> Result<(), String> {
    // Appended (not replacing) so `model.bin` resumes as `model.bin.part` —
    // `with_extension` would collide files sharing a stem (vocabulary.txt vs
    // a hypothetical vocabulary.json).
    let part = PathBuf::from(format!("{}.part", dest.display()));
    let mut have = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    // Alternate direct / proxied attempts so a network that only works one
    // way still converges.
    let max_attempts = 8usize;
    let mut last_err = String::new();
    for attempt in 0..max_attempts {
        if attempt > 0 {
            std::thread::sleep(Duration::from_secs(2 * attempt as u64));
        }
        let use_proxy = attempt % 2 == 1 && agents.via_proxy.is_some();
        let agent = match (use_proxy, &agents.via_proxy) {
            (true, Some(p)) => p,
            _ => &agents.direct,
        };
        let mut request = agent.get(url);
        if have > 0 {
            request = request.set("Range", &format!("bytes={have}-"));
        }
        let response = match request.call() {
            Ok(resp) => resp,
            Err(ureq::Error::Status(416, _)) => {
                // Range not satisfiable = the .part already holds everything.
                std::fs::rename(&part, dest).map_err(|err| format!("完成文件重命名失败：{err}"))?;
                return Ok(());
            }
            Err(ureq::Error::Status(code, resp)) => {
                last_err = format!("HTTP {code}: {}", {
                    let body = resp.into_string().unwrap_or_default();
                    body.chars().take(200).collect::<String>()
                });
                // 4xx (except 429 rate-limiting) is permanent for this file —
                // retrying a missing repo file only burns ~1 minute of sleeps.
                if (400..500).contains(&code) && code != 429 {
                    return Err(last_err);
                }
                continue;
            }
            Err(err) => {
                last_err = err.to_string();
                continue;
            }
        };
        // A 200 (not 206) means the server ignored the Range: restart.
        if response.status() == 200 && have > 0 {
            have = 0;
            let _ = std::fs::remove_file(&part);
        }
        let total = response
            .header("Content-Length")
            .and_then(|len| len.parse::<u64>().ok())
            .map(|len| len + have);
        let mut reader = response.into_reader();
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&part)
            .map_err(|err| format!("无法写入下载文件 {}：{err}", part.display()))?;
        let mut buf = [0u8; 64 * 1024];
        let mut io_err: Option<std::io::Error> = None;
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if let Err(err) = file.write_all(&buf[..n]) {
                        io_err = Some(err);
                        break;
                    }
                    have += n as u64;
                    on_progress(have, total.unwrap_or(0));
                }
                Err(err) => {
                    io_err = Some(err);
                    break;
                }
            }
        }
        drop(file);
        if io_err.is_none() {
            // Stream ended; complete when the total is satisfied (or unknown).
            match total {
                Some(t) if have < t => {
                    last_err = format!("连接中断（{have}/{t} 字节），将断点续传");
                    continue;
                }
                _ => {
                    std::fs::rename(&part, dest)
                        .map_err(|err| format!("完成文件重命名失败：{err}"))?;
                    return Ok(());
                }
            }
        }
        last_err = format!(
            "下载中断：{}",
            io_err.map(|e| e.to_string()).unwrap_or_default()
        );
    }
    Err(format!("下载失败（{max_attempts} 次尝试后）：{last_err}"))
}

/// Download one model into the plain layout (`whisper-models/<model>/`),
/// tracking progress in the global registry. Runs on a worker thread.
fn download_model(data_dir: &Path, model: &str) -> Result<(), String> {
    let dir = model_dir(data_dir, model);
    std::fs::create_dir_all(&dir)
        .map_err(|err| format!("无法创建模型目录 {}：{err}", dir.display()))?;
    let agents = download_agents()?;
    let base = format!("https://hf-mirror.com/Systran/faster-whisper-{model}/resolve/main");

    let update = |file_downloaded: u64, file_total: u64, aux_done: bool| {
        let mut downloads = downloads_slot()
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if let Some(state) = downloads.get_mut(model) {
            // Progress accounting centers on model.bin; aux files (~2MB)
            // collapse into a constant head start so the bar starts near 0.
            state.downloaded_bytes = file_downloaded;
            state.total_bytes = if file_total > 0 { file_total } else { 0 };
            let _ = aux_done;
        }
    };

    // Aux files first (small, fast) so a failed weight download still leaves
    // a resumable state rather than a half-configured dir.
    for name in MODEL_AUX_FILES {
        let dest = dir.join(name);
        if dest.is_file() {
            continue;
        }
        let url = format!("{base}/{name}");
        let mut local = 0u64;
        let result = download_file(&agents, &url, &dest, &mut |have, _total| {
            local = have;
        });
        match result {
            Ok(()) => logging::info(
                "whisper",
                &format!("模型文件完成：{model}/{name}（{local} 字节）"),
            ),
            Err(err) => {
                // Optional file (404-style failures after retries): skip it.
                logging::warn("whisper", &format!("模型文件跳过：{model}/{name}（{err}）"));
                let _ = std::fs::remove_file(PathBuf::from(format!("{}.part", dest.display())));
            }
        }
    }

    let weights = dir.join("model.bin");
    if !weights.is_file() {
        let url = format!("{base}/model.bin");
        download_file(&agents, &url, &weights, &mut |have, total| {
            update(have, total, true);
        })?;
    }
    // Sanity: the dir must now be usable by faster-whisper.
    if !weights.is_file() || !dir.join("config.json").is_file() {
        return Err("下载完成但模型目录不完整（缺 model.bin 或 config.json）".to_string());
    }
    Ok(())
}

/// Launch command for the server script. Exposed for tests. The `--model`
/// argument is the **local model directory** when the model has been
/// downloaded (faster-whisper accepts a dir directly), else the bare name.
fn server_command(exe: &Path, cfg: &LocalAsrConfig, data_dir: &Path) -> StdCommand {
    let script = script_path();
    let model_arg = resolve_model_path(data_dir, &cfg.model)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| cfg.model.clone());
    let mut cmd = StdCommand::new(exe);
    cmd.arg(&script)
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(effective_port(cfg).to_string())
        .arg("--model")
        .arg(model_arg)
        // Logical model id for /health: the --model arg may be a snapshot
        // directory whose basename is a commit hash, and ensure_running
        // compares this field against the configured model to decide reuse.
        .arg("--model-name")
        .arg(&cfg.model)
        .arg("--hf-home")
        .arg(&models_dir(data_dir));
    // Extra args are space-separated (each token becomes one argv element).
    for token in cfg.extra_args.split_whitespace() {
        cmd.arg(token);
    }
    cmd.env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    cmd
}

/// Path of the server script, shipped as a resource next to the binary.
fn script_path() -> PathBuf {
    // dev: CARGO_MANIFEST_DIR/scripts; packaged: resources/scripts
    let dev = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("scripts")
        .join("whisper_server.py");
    if dev.exists() {
        return dev;
    }
    std::path::Path::new("scripts")
        .join("whisper_server.py")
        .to_path_buf()
}

/// The model id the local server on `port` reports via `/health`, `None`
/// when it is not reachable or the field is missing.
fn health_model(port: u16) -> Option<String> {
    health_snapshot(port).ok().and_then(|value| {
        value
            .get("model")
            .and_then(|m| m.as_str())
            .map(String::from)
    })
}

/// Ensure a local ASR server is running and ready, returning its base URL
/// (including `/v1`). Idempotent: reuses a compatible already-serving
/// instance (our marker AND the configured model), spawns one when the port
/// is free, restarts the managed child when the port or model setting
/// changed, and errors when the port is taken by an unrelated service.
///
/// The caller invokes this only when [`LocalAsrConfig::enabled`] is set;
/// otherwise ASR keeps using the configured cloud endpoint.
pub fn ensure_running(cfg: &LocalAsrConfig, data_dir: &Path) -> Result<String, String> {
    let port = effective_port(cfg);
    // Only downloaded models are usable: enforce before any spawn attempt so
    // the error points at the model card instead of a cryptic load failure.
    if resolve_model_path(data_dir, &cfg.model).is_none() {
        return Err(format!(
            "本地 ASR 模型「{}」尚未下载：请在「API 设置 → 本地 ASR 模型」卡片中先下载",
            cfg.model
        ));
    }

    // Reuse a serving instance only when it runs the configured model; a
    // stale managed child (old port/model) is stopped so the spawn below can
    // apply the new settings.
    match probe_port(port) {
        PortState::Ours => match health_model(port) {
            Some(model) if model == cfg.model => {
                // Serving instance is compatible. Stop a managed child bound
                // elsewhere (e.g. left over from an older port setting).
                let mut guard = child_slot()
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner());
                if let Some(managed) = guard.as_ref() {
                    if managed.port != port {
                        let mut stale = guard.take().expect("checked above");
                        let _ = stale.child.kill();
                        let _ = stale.child.wait();
                        logging::info(
                            "whisper",
                            &format!("配置端口已变更为 {port}，停止旧端口的本地 ASR 服务"),
                        );
                    }
                }
                logging::info(
                    "whisper",
                    &format!("本地 ASR 服务已在运行，直接复用端口 {port}"),
                );
                return Ok(local_base_url(port));
            }
            Some(other_model) => {
                // Wrong model on this port: our managed child can be
                // restarted; one the user (or a previous session) started
                // cannot — say so instead of transcribing with the wrong
                // model.
                let guard = child_slot()
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner());
                let ours = matches!(guard.as_ref(), Some(m) if m.port == port);
                drop(guard);
                if ours {
                    logging::info(
                        "whisper",
                        &format!(
                            "模型已切换为 {}，重启本地 ASR 服务（原 {}）",
                            cfg.model, other_model
                        ),
                    );
                    kill_managed();
                } else {
                    return Err(format!(
                        "端口 {port} 上已有一个使用模型 {other_model} 的本地 ASR 服务（非本会话启动）。请把模型改回 {other_model} 或换一个端口"
                    ));
                }
            }
            None => {
                // /health reachable but no model field: treat as compatible.
                logging::info(
                    "whisper",
                    &format!("本地 ASR 服务已在运行，直接复用端口 {port}"),
                );
                return Ok(local_base_url(port));
            }
        },
        PortState::Foreign => {
            return Err(format!(
                "端口 {port} 已被其他程序占用（探测到非 MindBase 本地 ASR 服务）。请在「API 设置」中换一个本地 ASR 端口"
            ));
        }
        PortState::NotServing => {}
    }

    // Port is free: reuse the managed child only when it matches BOTH the
    // requested port and model (it may still be starting up). A stale or
    // mismatching child is stopped and a fresh one is spawned.
    let spawn_needed = {
        let mut guard = child_slot()
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let live_and_matching = match guard.as_mut() {
            Some(managed) => {
                managed.port == port
                    && managed.model == cfg.model
                    && managed
                        .child
                        .try_wait()
                        .map(|st| st.is_none())
                        .unwrap_or(false)
            }
            None => false,
        };
        if live_and_matching {
            false // reuse the existing child - poll to ready below.
        } else {
            if let Some(mut stale) = guard.take() {
                logging::info(
                    "whisper",
                    &format!(
                        "本地 ASR 配置已变更（端口/模型），停止旧服务（port={} model={}）",
                        stale.port, stale.model
                    ),
                );
                let _ = stale.child.kill();
                let _ = stale.child.wait();
                // Give the OS a beat to release the old port before the new
                // child binds it.
                std::thread::sleep(Duration::from_millis(500));
            }
            true
        }
    };

    if spawn_needed {
        let exe = ensure_interpreter(data_dir)?;
        let script = script_path();
        if !script.exists() {
            return Err(format!("找不到本地 ASR 服务脚本：{}", script.display()));
        }
        std::fs::create_dir_all(models_dir(data_dir))
            .map_err(|err| format!("无法创建模型目录 {}：{err}", models_dir(data_dir).display()))?;
        logging::info(
            "whisper",
            &format!(
                "启动本地 ASR 服务：python {} port={} model={}",
                script.display(),
                port,
                cfg.model
            ),
        );

        let child = server_command(&exe, cfg, data_dir)
            .spawn()
            .map_err(|err| format!("无法启动本地 ASR 服务（{err}）"))?;

        let mut guard = child_slot()
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        *guard = Some(ManagedChild {
            port,
            model: cfg.model.clone(),
            child,
        });
        drop(guard);
    }

    // Wait for the server (spawned now or already running) to answer /health.
    // A cold start includes pip install (first run only); the model itself
    // keeps loading in the background and need not be ready here.
    let deadline = Instant::now() + Duration::from_secs(cfg.ready_timeout_secs);
    loop {
        match probe_port(port) {
            PortState::Ours => {
                logging::info("whisper", &format!("本地 ASR 服务就绪 port={port}"));
                return Ok(local_base_url(port));
            }
            PortState::Foreign => {
                let _ = kill_managed();
                return Err(format!(
                    "端口 {port} 被其他程序占用，本地 ASR 服务未能启动。请在「API 设置」中换一个端口"
                ));
            }
            PortState::NotServing => {}
        }
        // Fail fast when the child we spawned has already exited (import
        // error, port bind failure, …) instead of waiting out the timeout.
        {
            let mut guard = child_slot()
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            if let Some(managed) = guard.as_mut() {
                if let Ok(Some(_status)) = managed.child.try_wait() {
                    *guard = None;
                    return Err(
                        "本地 ASR 服务进程已退出（多为依赖或模型问题），请查看日志 logs/mindbase.log"
                            .to_string(),
                    );
                }
            }
        }
        if Instant::now() >= deadline {
            // Best-effort cleanup of the child we spawned before failing.
            let _ = kill_managed();
            return Err(format!(
                "本地 ASR 服务在 {}s 内未就绪（port={port}）。首次启动需要安装依赖（约 1-2 分钟），请稍后重试；若持续失败请查看日志 logs/mindbase.log",
                cfg.ready_timeout_secs
            ));
        }
        std::thread::sleep(READY_POLL);
    }
}

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
    let db = app.state::<crate::db::Db>();
    let (cfg, data_dir) = match (db.conn.lock(), db.data_dir.lock()) {
        (Ok(conn), Ok(dir)) => {
            let cfg = crate::config::load(&conn).ok();
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

/// Fetch the local server's `/health` document (model, readiness, load
/// error). Used by the ASR "测试连接" probe; assumes the server is running.
pub(crate) fn health_snapshot(port: u16) -> Result<serde_json::Value, String> {
    let url = format!("http://127.0.0.1:{port}/health");
    let body = ureq::get(&url)
        .timeout(Duration::from_secs(5))
        .call()
        .map_err(|err| format!("本地 ASR 健康检查失败：{err}"))?
        .into_string()
        .map_err(|err| format!("读取本地 ASR 健康状态失败：{err}"))?;
    serde_json::from_str(&body).map_err(|err| format!("解析本地 ASR 健康状态失败：{err}"))
}

/// Stop the child we spawned, if any (called on app exit). Does nothing to a
/// server the user started manually.
pub fn shutdown() {
    let stopped = kill_managed();
    if stopped {
        logging::info("whisper", "本地 ASR 服务已停止");
    }
}

/// Kill (and reap) the managed child. Returns true if a child was stopped.
fn kill_managed() -> bool {
    let mut guard = child_slot()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    match guard.take() {
        Some(mut managed) => {
            let _ = managed.child.kill();
            let _ = managed.child.wait();
            true
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_cfg(port: u16, model: &str) -> LocalAsrConfig {
        LocalAsrConfig {
            enabled: true,
            command: String::new(),
            port,
            model: model.to_string(),
            extra_args: String::new(),
            ready_timeout_secs: 5,
        }
    }

    #[test]
    fn dead_port_is_not_serving() {
        // Port 1 is never bound by our server in test environments.
        assert_eq!(probe_port(1), PortState::NotServing);
    }

    #[test]
    fn zero_port_falls_back_to_packaged_default() {
        assert_eq!(effective_port(&test_cfg(0, "small")), DEFAULT_PORT);
        assert_eq!(effective_port(&test_cfg(8799, "small")), 8799);
    }

    #[test]
    fn server_command_carries_script_port_model_and_hf_home() {
        let exe = Path::new("C:/embedded/python.exe");
        let cfg = test_cfg(8765, "small");
        let dir = Path::new("D:/appdata");
        let cmd = server_command(&exe, &cfg, dir);
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        // The script path is the first argument.
        assert!(args[0].ends_with("whisper_server.py"));
        let joined = args.join(" ");
        assert!(joined.contains("--host 127.0.0.1"));
        assert!(joined.contains("--port 8765"));
        assert!(joined.contains("--model small"));
        assert!(joined.contains("--hf-home"));
        assert!(joined.contains("whisper-models"));
    }

    #[test]
    fn extra_args_are_split_into_tokens() {
        let cfg = LocalAsrConfig {
            extra_args: "--device cuda --beam-size 5".to_string(),
            ..test_cfg(8765, "small")
        };
        let cmd = server_command(Path::new("python"), &cfg, Path::new("D:/d"));
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert!(args
            .windows(2)
            .any(|w| w[0] == "--device" && w[1] == "cuda"));
        assert!(args
            .windows(2)
            .any(|w| w[0] == "--beam-size" && w[1] == "5"));
    }

    #[test]
    fn model_layout_detection() {
        let dir = std::env::temp_dir().join(format!("mb-model-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        // Plain layout: model.bin + config.json present.
        let plain = model_dir(&dir, "small");
        std::fs::create_dir_all(&plain).unwrap();
        assert!(resolve_model_path(&dir, "small").is_none()); // empty dir
        std::fs::write(plain.join("model.bin"), b"x").unwrap();
        std::fs::write(plain.join("config.json"), b"{}").unwrap();
        assert_eq!(
            resolve_model_path(&dir, "small"),
            Some(plain.clone()),
            "plain layout resolves once model.bin + config.json exist"
        );
        // A `.part` left over must not break resolution.
        std::fs::write(plain.join("model.bin.part"), b"y").unwrap();
        assert!(resolve_model_path(&dir, "small").is_some());
        // Legacy HF-hub layout resolves via refs/main -> snapshots/<sha>.
        let repo = dir
            .join("whisper-models")
            .join("hub")
            .join("models--Systran--faster-whisper-tiny");
        let snap = repo.join("snapshots").join("abc123");
        std::fs::create_dir_all(&snap).unwrap();
        std::fs::create_dir_all(repo.join("refs")).unwrap();
        std::fs::write(repo.join("refs").join("main"), b"abc123\n").unwrap();
        std::fs::write(snap.join("model.bin"), b"x").unwrap();
        assert_eq!(
            resolve_model_path(&dir, "tiny"),
            Some(snap),
            "legacy HF snapshot resolves"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Real network download of the smallest model, exercising the resumable
    /// downloader + progress registry + resolution end-to-end. Deliberately
    /// keeps its temp dir between runs so a re-run resumes an interrupted
    /// `.part` (proving resume). Explicitly opt-in:
    /// `cargo test --lib whisper_server -- --ignored` (~80MB).
    #[test]
    #[ignore]
    fn downloads_tiny_model_end_to_end() {
        // Fixed dir name so a re-run resumes the previous run's `.part`
        // (each cargo test process has a different pid, and the download
        // thread dies with it).
        let dir = std::env::temp_dir().join("mindbase-model-dl-test");
        std::fs::create_dir_all(&dir).unwrap();
        start_model_download(dir.clone(), "tiny".to_string()).unwrap();
        for _ in 0..1800 {
            if resolve_model_path(&dir, "tiny").is_some() {
                break;
            }
            std::thread::sleep(Duration::from_secs(1));
        }
        let path = resolve_model_path(&dir, "tiny").expect("tiny model should download");
        let size = std::fs::metadata(path.join("model.bin")).unwrap().len();
        assert!(
            size > 60_000_000,
            "tiny model.bin implausibly small: {size}"
        );
        let status = model_status_list(&dir);
        let tiny = status.iter().find(|s| s.model == "tiny").unwrap();
        assert!(tiny.downloaded && !tiny.downloading && tiny.error.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
