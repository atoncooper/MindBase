//! OS-level sandboxed process execution (the sandbox package).
//!
//! 本包只关心「把一条命令关进操作系统沙箱并拿回输出」，不依赖 agent / tools /
//! UI：上层 `agent::harness::tools::sandbox` 负责参数解析、配置开关、审计与文案。
//!
//! **输出不经过内存传递**：stdout/stderr 直接重定向到
//! `<data_dir>/logs/exec/` 下的文件，调用方读取头/尾摘要，必要时用 read_file
//! 的 offset/limit 分段读取完整日志。
//!
//! 后端：
//! - Windows：AppContainer（windows-rs：profile / capability / STARTUPINFOEX / ACL）。
//! - Linux：bubblewrap；macOS：sandbox-exec（seatbelt）。
//!
//! 跨平台候选库调研见 docs/desktop-rust-architecture.md §8。

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::infra::exec_log;

/// 沙箱内可选的 shell。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SandboxShell {
    Pwsh,
    Cmd,
    Bash,
}

impl SandboxShell {
    pub fn platform_default() -> Self {
        #[cfg(windows)]
        {
            SandboxShell::Pwsh
        }
        #[cfg(not(windows))]
        {
            SandboxShell::Bash
        }
    }

    pub fn parse(raw: Option<&str>) -> Result<Self, String> {
        match raw.map(str::trim).filter(|value| !value.is_empty()) {
            None => Ok(Self::platform_default()),
            Some("pwsh") | Some("powershell") => Ok(SandboxShell::Pwsh),
            Some("cmd") => Ok(SandboxShell::Cmd),
            Some("bash") | Some("sh") => Ok(SandboxShell::Bash),
            Some(other) => Err(format!(
                "不支持的 shell：{other}（可选 pwsh / cmd / bash；Windows 默认 pwsh，其它平台默认 bash）"
            )),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            SandboxShell::Pwsh => "pwsh",
            SandboxShell::Cmd => "cmd",
            SandboxShell::Bash => "bash",
        }
    }
}

/// 沙箱内命令的网络策略。默认阻断；需要联网时显式开启（文件隔离不变）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SandboxNetwork {
    Off,
    On,
}

impl SandboxNetwork {
    pub fn parse(raw: Option<&str>) -> Result<Self, String> {
        match raw.map(str::trim).filter(|value| !value.is_empty()) {
            None | Some("off") | Some("blocked") => Ok(SandboxNetwork::Off),
            Some("on") | Some("internet") | Some("inherit") => Ok(SandboxNetwork::On),
            Some(other) => Err(format!(
                "不支持的 network：{other}（可选 off=断网（默认）/ on=允许联网）"
            )),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            SandboxNetwork::Off => "blocked",
            SandboxNetwork::On => "internet",
        }
    }
}

/// 一次沙箱执行的结果：只携带退出码 / 超时 / 日志文件位置与大小，
/// 输出正文由调用方按需从文件读取（内存里不保留全文）。
#[derive(Debug, Clone)]
pub struct SandboxOutput {
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub duration_ms: u64,
    pub stdout_path: PathBuf,
    pub stderr_path: PathBuf,
    pub stdout_bytes: u64,
    pub stderr_bytes: u64,
}

/// 当前平台的沙箱后端名（用于输出与审计）。
pub fn backend_name() -> &'static str {
    #[cfg(windows)]
    {
        "appcontainer"
    }
    #[cfg(target_os = "linux")]
    {
        "bubblewrap"
    }
    #[cfg(target_os = "macos")]
    {
        "seatbelt"
    }
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    {
        "unsupported"
    }
}

/// 在沙箱中执行一条命令。`dir` 是沙箱目录（唯一可读写的位置）；
/// stdout/stderr 落到 `log_dir` 下的日志文件。
pub fn run(
    command: &str,
    shell: SandboxShell,
    dir: &Path,
    timeout: Duration,
    network: SandboxNetwork,
    log_dir: &Path,
) -> Result<SandboxOutput, String> {
    let (stdout_path, stderr_path) = exec_log::create_paths(log_dir, "sandbox")?;
    #[cfg(windows)]
    {
        windows::run(
            command,
            shell,
            dir,
            timeout,
            network,
            &stdout_path,
            &stderr_path,
        )
    }
    #[cfg(not(windows))]
    {
        unix::run(
            command,
            shell,
            dir,
            timeout,
            network,
            &stdout_path,
            &stderr_path,
        )
    }
}

#[cfg(windows)]
mod windows;
#[cfg(not(windows))]
mod unix;
