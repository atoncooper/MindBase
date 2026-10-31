//! shell 命令构造与执行（pwsh / cmd / bash，可选断网）。

use std::path::Path;
use std::time::Duration;

use super::process::{run_to_files, RunCapture};

/// 默认执行超时。
pub const DEFAULT_TIMEOUT_MS: u64 = 60_000;
pub const MIN_TIMEOUT_MS: u64 = 1_000;
pub const MAX_TIMEOUT_MS: u64 = 600_000;
/// 单条命令的字符上限。
pub const MAX_COMMAND_BYTES: usize = 16 * 1024;

/// 要调用的 shell。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShellKind {
    Pwsh,
    Cmd,
    Bash,
}

impl ShellKind {
    pub fn platform_default() -> Self {
        #[cfg(windows)]
        {
            ShellKind::Pwsh
        }
        #[cfg(not(windows))]
        {
            ShellKind::Bash
        }
    }

    pub fn parse(raw: Option<&str>) -> Result<Self, String> {
        match raw.map(str::trim).filter(|value| !value.is_empty()) {
            None => Ok(Self::platform_default()),
            Some("pwsh") | Some("powershell") => Ok(ShellKind::Pwsh),
            Some("cmd") => Ok(ShellKind::Cmd),
            Some("bash") | Some("sh") => Ok(ShellKind::Bash),
            Some(other) => Err(format!(
                "不支持的 shell：{other}（可选 pwsh / cmd / bash；Windows 默认 pwsh，其它平台默认 bash）"
            )),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            ShellKind::Pwsh => "pwsh",
            ShellKind::Cmd => "cmd",
            ShellKind::Bash => "bash",
        }
    }
}

/// 命令的网络模式。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NetworkMode {
    /// 继承应用进程的网络（默认）。
    Inherit,
    /// 尽力断网执行（Linux / macOS 支持，Windows 报错）。
    Off,
}

impl NetworkMode {
    pub fn parse(raw: Option<&str>) -> Result<Self, String> {
        match raw.map(str::trim).filter(|value| !value.is_empty()) {
            None | Some("inherit") => Ok(NetworkMode::Inherit),
            Some("off") => Ok(NetworkMode::Off),
            Some(other) => Err(format!("不支持的 network：{other}（可选 inherit / off）")),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            NetworkMode::Inherit => "inherit",
            NetworkMode::Off => "off",
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
const WINDOWS_NETWORK_OFF_UNSUPPORTED: &str =
    "当前平台（Windows）没有用户态断网机制：network=off 不受支持。\n请改用 network=inherit（继承网络），或使用系统防火墙 / 虚拟机 / 容器做真正的网络隔离。";

/// 基础 argv（不含网络隔离包装）。
fn base_invocation(kind: ShellKind, command: &str) -> (String, Vec<String>) {
    match kind {
        ShellKind::Pwsh => (
            "pwsh".to_string(),
            vec![
                "-NoLogo".to_string(),
                "-NoProfile".to_string(),
                "-NonInteractive".to_string(),
                "-Command".to_string(),
                command.to_string(),
            ],
        ),
        ShellKind::Cmd => ("cmd".to_string(), vec!["/C".to_string(), command.to_string()]),
        ShellKind::Bash => (
            "bash".to_string(),
            vec!["-lc".to_string(), command.to_string()],
        ),
    }
}

/// Linux：unshare -n 新建无网络命名空间。
#[cfg(target_os = "linux")]
fn isolate_network((program, args): (String, Vec<String>)) -> Result<(String, Vec<String>), String> {
    let mut wrapped = vec!["-n".to_string(), "--".to_string(), program];
    wrapped.extend(args);
    Ok(("unshare".to_string(), wrapped))
}

/// macOS：seatbelt profile 拒绝所有网络操作。
#[cfg(target_os = "macos")]
fn isolate_network((program, args): (String, Vec<String>)) -> Result<(String, Vec<String>), String> {
    let profile = "(version 1)(allow default)(deny network*)";
    let mut wrapped = vec!["-p".to_string(), profile.to_string(), program];
    wrapped.extend(args);
    Ok(("sandbox-exec".to_string(), wrapped))
}

/// Windows 及其它平台：没有用户态断网机制，明确拒绝。
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn isolate_network(_invocation: (String, Vec<String>)) -> Result<(String, Vec<String>), String> {
    Err(WINDOWS_NETWORK_OFF_UNSUPPORTED.to_string())
}

/// 组装真正要 spawn 的 program + argv。
pub fn build_invocation(
    kind: ShellKind,
    command: &str,
    network: NetworkMode,
) -> Result<(String, Vec<String>), String> {
    if kind == ShellKind::Cmd && !cfg!(windows) {
        return Err("cmd 仅 Windows 可用；请用 shell=bash".to_string());
    }
    if kind == ShellKind::Pwsh && !cfg!(windows) {
        return Err("pwsh 仅 Windows 可用；请用 shell=bash".to_string());
    }
    let base = base_invocation(kind, command);
    match network {
        NetworkMode::Inherit => Ok(base),
        NetworkMode::Off => isolate_network(base),
    }
}

/// 超时参数夹取到 [MIN, MAX]。
pub fn clamp_timeout(raw: Option<u64>) -> u64 {
    raw.unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
}

/// 构造并执行一条 shell 命令（stdout/stderr 落文件）。
#[allow(clippy::too_many_arguments)]
pub fn run(
    command: &str,
    shell: ShellKind,
    network: NetworkMode,
    cwd: &Path,
    timeout: Duration,
    log_dir: &Path,
    tag: &str,
) -> Result<RunCapture, String> {
    let (program, args) = build_invocation(shell, command, network)?;
    run_to_files(&program, &args, cwd, timeout, log_dir, tag)
}
