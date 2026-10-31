//! Unix 沙箱后端：Linux 用 bubblewrap，macOS 用 sandbox-exec（seatbelt）。
//!
//! stdout/stderr 直接重定向到日志文件（不经过管道/内存）；本模块负责组装参数、
//! 启动进程、超时杀进程组。

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use super::{SandboxNetwork, SandboxOutput, SandboxShell};

const POLL_INTERVAL: Duration = Duration::from_millis(25);

#[allow(clippy::too_many_arguments)]
pub(super) fn run(
    command: &str,
    shell: SandboxShell,
    dir: &Path,
    timeout: Duration,
    network: SandboxNetwork,
    stdout_path: &Path,
    stderr_path: &Path,
) -> Result<SandboxOutput, String> {
    if shell != SandboxShell::Bash {
        return Err(format!(
            "{} 沙箱只支持 bash；请使用 shell=bash",
            super::backend_name()
        ));
    }
    #[cfg(target_os = "linux")]
    {
        linux(command, dir, timeout, network, stdout_path, stderr_path)
    }
    #[cfg(target_os = "macos")]
    {
        macos(command, dir, timeout, network, stdout_path, stderr_path)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = (command, dir, timeout, network, stdout_path, stderr_path);
        Err("当前平台暂不支持沙箱执行".to_string())
    }
}

#[allow(clippy::too_many_arguments)]
fn spawn_to_files(
    program: &str,
    args: &[String],
    cwd: &Path,
    timeout: Duration,
    stdout_path: &Path,
    stderr_path: &Path,
) -> Result<SandboxOutput, String> {
    let stdout_file = std::fs::File::create(stdout_path)
        .map_err(|err| format!("创建 stdout 日志失败（{}）：{err}", stdout_path.display()))?;
    let stderr_file = std::fs::File::create(stderr_path)
        .map_err(|err| format!("创建 stderr 日志失败（{}）：{err}", stderr_path.display()))?;
    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout_file))
        .stderr(Stdio::from(stderr_file))
        .env("MIND_BASE_AGENT", "1");
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        // 独立进程组：超时可整组杀掉派生子进程。
        cmd.process_group(0);
    }
    let mut child = cmd
        .spawn()
        .map_err(|err| format!("无法启动 {program}（{err}）。请确认它已安装并在 PATH 中。"))?;
    let pid = child.id();
    let started = Instant::now();
    let (exit_code, timed_out) = loop {
        match child.try_wait() {
            Ok(Some(status)) => break (status.code(), false),
            Ok(None) => {
                if started.elapsed() >= timeout {
                    #[cfg(unix)]
                    {
                        let _ = Command::new("kill")
                            .args(["-KILL", &format!("-{pid}")])
                            .stdout(Stdio::null())
                            .stderr(Stdio::null())
                            .status();
                    }
                    let _ = child.wait();
                    break (None, true);
                }
                std::thread::sleep(POLL_INTERVAL);
            }
            Err(err) => {
                let _ = child.kill();
                return Err(format!("等待沙箱进程失败：{err}"));
            }
        }
    };
    let stdout_bytes = std::fs::metadata(stdout_path).map(|m| m.len()).unwrap_or(0);
    let stderr_bytes = std::fs::metadata(stderr_path).map(|m| m.len()).unwrap_or(0);
    Ok(SandboxOutput {
        exit_code,
        timed_out,
        duration_ms: started.elapsed().as_millis() as u64,
        stdout_path: stdout_path.to_path_buf(),
        stderr_path: stderr_path.to_path_buf(),
        stdout_bytes,
        stderr_bytes,
    })
}

#[cfg(target_os = "linux")]
#[allow(clippy::too_many_arguments)]
fn linux(
    command: &str,
    dir: &Path,
    timeout: Duration,
    network: SandboxNetwork,
    stdout_path: &Path,
    stderr_path: &Path,
) -> Result<SandboxOutput, String> {
    let mut args: Vec<String> = vec!["--die-with-parent".into()];
    if network == SandboxNetwork::Off {
        args.push("--unshare-net".into());
    }
    args.extend([
        "--unshare-pid".into(),
        "--new-session".into(),
        "--proc".into(),
        "/proc".into(),
        "--dev".into(),
        "/dev".into(),
        "--tmpfs".into(),
        "/tmp".into(),
    ]);
    for path in ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/opt"] {
        if Path::new(path).exists() {
            args.push("--ro-bind".into());
            args.push(path.into());
            args.push(path.into());
        }
    }
    args.push("--bind".into());
    args.push(dir.to_string_lossy().to_string());
    args.push("/work".into());
    args.push("--chdir".into());
    args.push("/work".into());
    args.push("--".into());
    args.push("bash".into());
    args.push("-lc".into());
    args.push(command.to_string());
    spawn_to_files("bwrap", &args, dir, timeout, stdout_path, stderr_path).map_err(|err| {
        if err.contains("无法启动 bwrap") {
            format!("{err}\n未找到 bubblewrap：请先安装 bwrap（apt install bubblewrap / dnf install bubblewrap / pacman -S bubblewrap）。")
        } else {
            err
        }
    })
}

#[cfg(target_os = "macos")]
#[allow(clippy::too_many_arguments)]
fn macos(
    command: &str,
    dir: &Path,
    timeout: Duration,
    network: SandboxNetwork,
    stdout_path: &Path,
    stderr_path: &Path,
) -> Result<SandboxOutput, String> {
    let dir_text = dir.to_string_lossy().replace('"', "\\\"");
    let network_rule = if network == SandboxNetwork::Off {
        "(deny network*)"
    } else {
        "(allow network*)"
    };
    let profile = format!(
        "(version 1)(deny default)(allow process*)(allow sysctl-read)\\
         (allow file-read* (subpath \"/usr\") (subpath \"/System\") (subpath \"/Library\") (subpath \"/bin\") (subpath \"/sbin\") (subpath \"/private/tmp\") (subpath \"/dev\") (subpath \"{dir_text}\") (literal \"/\"))\\
         (allow file-write* (subpath \"{dir_text}\") (subpath \"/private/tmp\"))\\
         {network_rule}"
    );
    let args = vec![
        "-p".to_string(),
        profile,
        "bash".to_string(),
        "-lc".to_string(),
        command.to_string(),
    ];
    spawn_to_files("sandbox-exec", &args, dir, timeout, stdout_path, stderr_path).map_err(|err| {
        if err.contains("无法启动 sandbox-exec") {
            format!("{err}\n未找到 macOS sandbox-exec（系统自带 /usr/bin/sandbox-exec）。")
        } else {
            err
        }
    })
}
