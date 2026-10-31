//! 子进程执行：stdout/stderr 直接落文件（不经内存）、超时杀进程树、审计。

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::infra::exec_log;

const POLL_INTERVAL: Duration = Duration::from_millis(25);
const AUDIT_SUBDIR: &str = "logs";
const AUDIT_FILE: &str = "shell-audit.jsonl";

/// 一次命令执行的结果：退出码 / 超时 / 两个日志文件路径与字节数。
#[derive(Debug, Clone)]
pub struct RunCapture {
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub duration_ms: u64,
    pub stdout_path: PathBuf,
    pub stderr_path: PathBuf,
    pub stdout_bytes: u64,
    pub stderr_bytes: u64,
}

impl RunCapture {
    /// 状态文案：退出码 / 超时终止。
    pub fn status_text(&self) -> String {
        if self.timed_out {
            "超时终止".to_string()
        } else {
            match self.exit_code {
                Some(code) => format!("退出码 {code}"),
                None => "已被信号终止".to_string(),
            }
        }
    }

    /// stdout / stderr 摘要段（头 + 尾 + 文件路径）。
    pub fn sections(&self) -> String {
        let stdout = exec_log::summarize(&self.stdout_path, self.stdout_bytes);
        let stderr = exec_log::summarize(&self.stderr_path, self.stderr_bytes);
        let mut out = format!("--- stdout（{} 字节）---\n{stdout}\n", self.stdout_bytes);
        out.push_str(&format!("--- stderr（{} 字节）---\n{stderr}", self.stderr_bytes));
        if self.timed_out {
            out.push_str("\n注意：命令超时，已尝试终止整个进程树；未完成的操作可能留下中间文件。");
        }
        out
    }
}

/// 执行日志目录：<data_dir>/logs/exec。
pub fn log_root(data_dir: &Path) -> PathBuf {
    exec_log::log_root(data_dir)
}

/// 超时后杀整个进程树（Windows taskkill /T；Unix 进程组）。
fn kill_tree(child: &mut std::process::Child, pid: u32) {
    let _ = child.kill();
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .args(["-KILL", &format!("-{pid}")])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/// 执行命令，stdout/stderr **直接重定向到文件**（内存只保留摘要）。
pub fn run_to_files(
    program: &str,
    args: &[String],
    cwd: &Path,
    timeout: Duration,
    log_dir: &Path,
    tag: &str,
) -> Result<RunCapture, String> {
    let (stdout_path, stderr_path) = exec_log::create_paths(log_dir, tag)?;
    let stdout_file = std::fs::File::create(&stdout_path)
        .map_err(|err| format!("创建 stdout 日志失败（{}）：{err}", stdout_path.display()))?;
    let stderr_file = std::fs::File::create(&stderr_path)
        .map_err(|err| format!("创建 stderr 日志失败（{}）：{err}", stderr_path.display()))?;
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout_file))
        .stderr(Stdio::from(stderr_file))
        .env("MIND_BASE_AGENT", "1");
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|err| format!("无法启动 {program}（{err}）。请确认它已安装并在 PATH 中。"))?;
    let pid = child.id();
    let started = Instant::now();
    let (exit_code, timed_out) = loop {
        match child.try_wait() {
            Ok(Some(status)) => break (status.code(), false),
            Ok(None) => {
                if started.elapsed() >= timeout {
                    kill_tree(&mut child, pid);
                    let _ = child.wait();
                    break (None, true);
                }
                std::thread::sleep(POLL_INTERVAL);
            }
            Err(err) => {
                let _ = child.kill();
                return Err(format!("等待命令结束失败：{err}"));
            }
        }
    };
    let stdout_bytes = std::fs::metadata(&stdout_path).map(|m| m.len()).unwrap_or(0);
    let stderr_bytes = std::fs::metadata(&stderr_path).map(|m| m.len()).unwrap_or(0);
    exec_log::prune(log_dir);
    Ok(RunCapture {
        exit_code,
        timed_out,
        duration_ms: started.elapsed().as_millis() as u64,
        stdout_path,
        stderr_path,
        stdout_bytes,
        stderr_bytes,
    })
}

/// 审计日志：每次执行追加一行 JSON（失败不影响命令本身的返回）。
pub fn write_audit(data_dir: &Path, payload: &Value) {
    let dir = data_dir.join(AUDIT_SUBDIR);
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    use std::io::Write as _;
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(AUDIT_FILE))
    {
        let line = format!("{payload}\n");
        let _ = file.write_all(line.as_bytes());
    }
}
