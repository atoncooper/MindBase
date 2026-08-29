//! FFmpeg availability probing for the system status card.
//!
//! Resolution order:
//! 1. `override` - absolute binary path configured by the user
//!    ([`AppConfig::ffmpeg_path_override`] / `config.rs`).
//! 2. `bundled` - sidecar binary shipped next to the app executable and
//!    declared under `bundle.externalBin` in `tauri.conf.json`. The files in
//!    `src-tauri/binaries/` carry the `-x86_64-pc-windows-msvc` suffix;
//!    tauri-build copies them next to the executable without the suffix,
//!    which is exactly what `shell().sidecar("ffmpeg")` resolves.
//! 3. `system` - plain PATH lookup.
//!
//! Every candidate is verified by actually running `<binary> -version` under
//! a hard wall-clock timeout (one shared [`PROBE_TIMEOUT`] deadline covering
//! both the exit wait and the pipe drains), so a wedged binary can never hang
//! the status check. All failures are collected into a single descriptive error.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command as StdCommand, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_shell::ShellExt;

use crate::config;
use crate::db::Db;

/// Hard wall-clock cap applied to every `-version` invocation.
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// Poll interval used while waiting for a probe child process to exit.
const PROBE_POLL_INTERVAL: Duration = Duration::from_millis(50);

/// Source label for a user-configured binary path.
const SOURCE_OVERRIDE: &str = "override";
/// Source label for the sidecar binary bundled with the installer.
const SOURCE_BUNDLED: &str = "bundled";
/// Source label for a binary discovered through the system PATH.
const SOURCE_SYSTEM: &str = "system";

/// Effective ffmpeg installation as surfaced to the UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegStatus {
    /// Where the binary came from: `"override"` | `"bundled"` | `"system"`.
    pub source: String,
    /// Version parsed from `-version` output, e.g. `"7.1.1-essentials"`.
    pub version: String,
    /// Path of the binary that answered.
    pub path: String,
}

/// Read the stored config and return the user-configured ffmpeg path, if any.
fn read_override_path(db: &State<'_, Db>) -> Result<Option<String>, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    let cfg = config::load(&conn)?;
    Ok(cfg
        .ffmpeg_path_override
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty()))
}

/// Resolve the path of the bundled ffmpeg sidecar.
///
/// The shell plugin wraps a plain [`StdCommand`]; converting it is how the
/// resolved program location can be inspected without spawning anything.
fn bundled_sidecar_path(app: &AppHandle) -> Result<PathBuf, String> {
    let command = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|err| format!("failed to resolve sidecar: {err}"))?;
    Ok(PathBuf::from(StdCommand::from(command).get_program()))
}

/// Prevent a console window from flashing for each probe on Windows.
#[cfg(windows)]
fn apply_no_window(cmd: &mut StdCommand) {
    use std::os::windows::process::CommandExt;

    // Mirrors the flag the shell plugin itself uses for spawned processes.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

/// No-op placeholder for platforms without console-window semantics.
#[cfg(not(windows))]
fn apply_no_window(_cmd: &mut StdCommand) {}

/// Drain one pipe into a buffer on a worker thread.
fn spawn_reader<R>(pipe: Option<R>, sender: mpsc::Sender<Vec<u8>>) -> thread::JoinHandle<()>
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut buffer = Vec::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.read_to_end(&mut buffer);
        }
        let _ = sender.send(buffer);
    })
}

/// Time still left in the probe budget; zero once the deadline has passed.
fn remaining(deadline: Instant) -> Duration {
    deadline.checked_duration_since(Instant::now()).unwrap_or_default()
}

/// Collect a drained pipe, giving up (with empty output) once the caller's
/// share of the shared probe budget is exhausted.
fn collect_reader(receiver: mpsc::Receiver<Vec<u8>>, budget: Duration) -> Vec<u8> {
    receiver.recv_timeout(budget).unwrap_or_default()
}

/// Run `<program> -version` and return its decoded output text.
///
/// One [`PROBE_TIMEOUT`] budget covers the whole candidate — waiting for exit
/// *and* draining both pipes — so a wedged binary can never stretch a single
/// probe to `3 x PROBE_TIMEOUT`. Pipes are drained on dedicated threads so a
/// chatty binary cannot deadlock on a full buffer.
fn run_version_probe(program: &Path) -> Result<String, String> {
    let mut cmd = StdCommand::new(program);
    cmd.arg("-version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_no_window(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|err| format!("failed to launch: {err}"))?;

    let (stdout_tx, stdout_rx) = mpsc::channel();
    let (stderr_tx, stderr_rx) = mpsc::channel();
    spawn_reader(child.stdout.take(), stdout_tx);
    spawn_reader(child.stderr.take(), stderr_tx);

    // Shared wall-clock deadline for every blocking wait below.
    let deadline = Instant::now() + PROBE_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                let left = remaining(deadline);
                if left.is_zero() {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "did not answer within {}s",
                        PROBE_TIMEOUT.as_secs()
                    ));
                }
                // Never oversleep past the deadline.
                thread::sleep(PROBE_POLL_INTERVAL.min(left));
            }
            Err(err) => return Err(format!("failed while waiting: {err}")),
        }
    };

    // Drain with whatever budget is left; an exhausted budget yields empty
    // output instead of extending the probe beyond PROBE_TIMEOUT.
    let stdout =
        String::from_utf8_lossy(&collect_reader(stdout_rx, remaining(deadline))).into_owned();
    let stderr =
        String::from_utf8_lossy(&collect_reader(stderr_rx, remaining(deadline))).into_owned();

    if !status.success() {
        let code = status
            .code()
            .map_or_else(|| "unknown".to_string(), |code| code.to_string());
        let detail = if stderr.trim().is_empty() {
            stdout.trim()
        } else {
            stderr.trim()
        };
        return Err(format!("exited with status {code}: {detail}"));
    }

    Ok(if stdout.trim().is_empty() {
        stderr
    } else {
        stdout
    })
}

/// Extract the version token from `ffmpeg -version` output.
///
/// Expected first line shape:
/// `ffmpeg version 7.1.1-essentials_build-www.gyan.dev Copyright ...`
fn parse_ffmpeg_version(output: &str) -> Option<String> {
    let first_line = output.lines().next()?;
    let mut tokens = first_line.split_whitespace();
    while let Some(token) = tokens.next() {
        if token.eq_ignore_ascii_case("version") {
            let raw = tokens.next()?;
            // gyan.dev builds append `_build-...`; trim it for a tidy display.
            let trimmed = raw.split_once("_build").map_or(raw, |(head, _)| head);
            return Some(trimmed.trim_matches(',').to_string());
        }
    }
    None
}

/// Verify one candidate binary and turn it into an [`FfmpegStatus`].
fn probe_candidate(source: &str, path: &Path) -> Result<FfmpegStatus, String> {
    let output = run_version_probe(path)?;
    let version = parse_ffmpeg_version(&output).ok_or_else(|| {
        format!(
            "could not parse version from output starting with {:?}",
            output.lines().next().unwrap_or("")
        )
    })?;
    Ok(FfmpegStatus {
        source: source.to_string(),
        version,
        path: path.display().to_string(),
    })
}

/// Walk the resolution chain and return the first working ffmpeg.
fn resolve_status(app: &AppHandle, override_path: Option<&str>) -> Result<FfmpegStatus, String> {
    let mut failures: Vec<String> = Vec::new();

    // 1. Explicit user configuration always wins.
    if let Some(configured) = override_path.filter(|value| !value.trim().is_empty()) {
        let path = PathBuf::from(configured.trim());
        match probe_candidate(SOURCE_OVERRIDE, &path) {
            Ok(status) => return Ok(status),
            Err(err) => failures.push(format!("override ({}): {err}", path.display())),
        }
    }

    // 2. Sidecar binary shipped with the application.
    match bundled_sidecar_path(app) {
        Ok(path) => match probe_candidate(SOURCE_BUNDLED, &path) {
            Ok(status) => return Ok(status),
            Err(err) => failures.push(format!("bundled ({}): {err}", path.display())),
        },
        Err(err) => failures.push(format!("bundled: {err}")),
    }

    // 3. Fall back to whatever the operating system has on PATH.
    match probe_candidate(SOURCE_SYSTEM, Path::new("ffmpeg")) {
        Ok(status) => return Ok(status),
        Err(err) => failures.push(format!("system: {err}")),
    }

    Err(format!(
        "no usable ffmpeg found; attempts: {}",
        failures.join("; ")
    ))
}

/// Report which ffmpeg installation the app will use, if any.
#[tauri::command]
pub async fn ffmpeg_status(app: AppHandle, db: State<'_, Db>) -> Result<FfmpegStatus, String> {
    // Read the override before entering the worker so only owned data is
    // moved across the thread boundary.
    let override_path = read_override_path(&db)?;

    // Probes block on process spawns; keep them off the async runtime's
    // reactive core so unrelated commands stay responsive.
    tauri::async_runtime::spawn_blocking(move || resolve_status(&app, override_path.as_deref()))
        .await
        .map_err(|err| format!("ffmpeg probe worker failed: {err}"))?
}

/// Resolve a usable ffmpeg binary **path** for subprocess use (transcoding
/// audio to raw PCM for the real-time ASR path). `override_path` is the
/// user-configured absolute binary path (may be `None`); the resolution chain
/// is override → bundled sidecar → system PATH. Reuses the probe so only a
/// genuinely working binary is returned.
pub fn resolve_ffmpeg_path(
    app: &AppHandle,
    override_path: Option<&str>,
) -> Result<PathBuf, String> {
    let status = resolve_status(app, override_path)?;
    Ok(PathBuf::from(status.path))
}

#[cfg(test)]
mod tests {
    use super::parse_ffmpeg_version;

    #[test]
    fn parses_gyan_essentials_version_line() {
        let output = "ffmpeg version 7.1.1-essentials_build-www.gyan.dev \
                      Copyright (c) 2000-2025 the FFmpeg developers";
        assert_eq!(parse_ffmpeg_version(output).as_deref(), Some("7.1.1-essentials"));
    }

    #[test]
    fn parses_plain_upstream_version_line() {
        assert_eq!(
            parse_ffmpeg_version("ffmpeg version 6.0 Copyright (c) 2000-2023").as_deref(),
            Some("6.0")
        );
    }

    #[test]
    fn returns_none_for_unrecognized_output() {
        assert_eq!(parse_ffmpeg_version(""), None);
        assert_eq!(parse_ffmpeg_version("not an ffmpeg binary"), None);
    }
}
