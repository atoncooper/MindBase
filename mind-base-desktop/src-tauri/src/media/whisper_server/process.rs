//! Sidecar process lifecycle: port probing, spawn, readiness polling and shutdown.

use std::path::{Path, PathBuf};
use std::process::{Child, Command as StdCommand, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::infra::config::LocalAsrConfig;
use crate::infra::logging;

use super::models::{models_dir, resolve_model_path, DEFAULT_PORT};

/// Poll interval while waiting for readiness.
const READY_POLL: Duration = Duration::from_millis(500);
/// Marker the local server reports at `/health` (`server` field), proving
/// the listener is our whisper server rather than an unrelated HTTP app.
const SERVER_MARKER: &str = "mindbase-whisper";
/// Effective port: stored config, or [`DEFAULT_PORT`] when unset/zero.
pub(super) fn effective_port(cfg: &LocalAsrConfig) -> u16 {
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
pub(super) fn probe_port(port: u16) -> PortState {
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
    let exe = crate::infra::python_runtime::ensure_server_deps(data_dir)?;
    Ok(exe)
}
/// Launch command for the server script. Exposed for tests. The `--model`
/// argument is the **local model directory** when the model has been
/// downloaded (faster-whisper accepts a dir directly), else the bare name.
pub(super) fn server_command(exe: &Path, cfg: &LocalAsrConfig, data_dir: &Path) -> StdCommand {
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
    cmd.env("PYTHONIOENCODING", "utf-8");
    // The worker's huggingface_hub downloads inherit the user's egress proxy
    // when one is configured; domestic mirrors stay direct via NO_PROXY.
    for (name, value) in crate::llm::api_keys::child_proxy_env() {
        cmd.env(name, value);
    }
    cmd.stdin(Stdio::null())
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
