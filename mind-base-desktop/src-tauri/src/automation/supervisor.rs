//! 进程托管：启动 / 监控 / 终止 / 中断恢复。
//!
//! 每个任务在一个后台线程里 try_wait 轮询；进程退出后写回 DB。
//! 应用重启时子进程无法 reattach（Child 句柄丢失），由 reconcile 标记为
//! interrupted，交给 AI/用户决定是否重试。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use rusqlite::Connection;

use crate::automation::{log_index, now_secs, store};
use crate::toolkit::shell::{build_invocation, NetworkMode, ShellKind};

const POLL_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Debug, Clone)]
pub struct StartOutcome {
    pub task_id: i64,
    pub run_id: i64,
    pub pid: u32,
    pub stdout_path: PathBuf,
    pub stderr_path: PathBuf,
}

fn registry() -> &'static Mutex<HashMap<i64, Arc<Mutex<Child>>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<i64, Arc<Mutex<Child>>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn is_running(task_id: i64) -> bool {
    registry()
        .lock()
        .map(|guard| guard.contains_key(&task_id))
        .unwrap_or(false)
}

/// 启动（或重试）任务。调用方负责配置开关与 max_attempts 之前的判断。
pub fn start(
    conn: &Arc<Mutex<Connection>>,
    data_dir: &Path,
    task: &store::TaskRecord,
    restart_reason: &str,
) -> Result<StartOutcome, String> {
    let task_id = task.id;
    if is_running(task_id) {
        return Err(format!("任务 {} 已在运行", task_id));
    }
    let attempt = task.attempt + 1;
    let now = now_secs();
    let run_id = {
        let guard = conn.lock().map_err(|_| "数据库锁失败".to_string())?;
        store::start_run(&guard, task_id, attempt, None, now, restart_reason)?
    };
    let (stdout_path, stderr_path) = log_index::run_log_paths(data_dir, task_id, run_id, now);
    log_index::ensure_parent(&stdout_path)?;
    log_index::ensure_parent(&stderr_path)?;

    let cwd = task
        .cwd
        .as_deref()
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .unwrap_or_else(|| data_dir.to_path_buf());
    let (program, args) = build_invocation(
        ShellKind::platform_default(),
        &task.command,
        NetworkMode::Inherit,
    )?;
    let stdout_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&stdout_path)
        .map_err(|err| format!("创建 stdout 日志失败（{}）：{err}", stdout_path.display()))?;
    let stderr_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&stderr_path)
        .map_err(|err| format!("创建 stderr 日志失败（{}）：{err}", stderr_path.display()))?;

    let mut command = Command::new(&program);
    command
        .args(&args)
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout_file))
        .stderr(Stdio::from(stderr_file))
        .env("MIND_BASE_AUTOMATION", "1");
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        command.process_group(0);
    }
    let child = command
        .spawn()
        .map_err(|err| format!("无法启动自动化任务（{program}）：{err}"))?;
    let pid = child.id();

    {
        let guard = conn.lock().map_err(|_| "数据库锁失败".to_string())?;
        store::set_run_pid(&guard, run_id, pid as i64)?;
        store::set_attempt(&guard, task_id, attempt, now)?;
        store::set_state(&guard, task_id, store::TaskState::Running, now)?;
        store::insert_log_segment(&guard, task_id, Some(run_id), &stdout_path, "stdout", 0, now)?;
        store::insert_log_segment(&guard, task_id, Some(run_id), &stderr_path, "stderr", 0, now)?;
    }

    let child = Arc::new(Mutex::new(child));
    if let Ok(mut guard) = registry().lock() {
        guard.insert(task_id, child.clone());
    }

    // 监控线程：进程退出后写回 run/task 状态；不消耗任何模型 token。
    let conn_for_monitor = conn.clone();
    let child_for_monitor = child.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(POLL_INTERVAL);
        let status = {
            let Ok(mut guard) = child_for_monitor.lock() else {
                return;
            };
            match guard.try_wait() {
                Ok(Some(status)) => Some(status),
                Ok(None) => None,
                Err(_) => Some(std::process::ExitStatus::default()),
            }
        };
        let Some(status) = status else { continue };
        let now = now_secs();
        if let Ok(guard) = conn_for_monitor.lock() {
            let stopped = store::get_task(&guard, task_id)
                .map(|record| record.state == store::TaskState::Stopped)
                .unwrap_or(false);
            let state = if stopped {
                "stopped"
            } else if status.success() {
                "succeeded"
            } else {
                "failed"
            };
            let _ = store::finish_run(&guard, run_id, status.code(), state, now);
            if !stopped {
                let task_state = if status.success() {
                    store::TaskState::Succeeded
                } else {
                    store::TaskState::Failed
                };
                let _ = store::set_state(&guard, task_id, task_state, now);
            }
        }
        if let Ok(mut guard) = registry().lock() {
            guard.remove(&task_id);
        }
        break;
    });

    Ok(StartOutcome {
        task_id: task_id,
        run_id,
        pid,
        stdout_path,
        stderr_path,
    })
}

/// 终止任务进程树（Windows: taskkill /T）。
pub fn kill(conn: &Arc<Mutex<Connection>>, task_id: i64) -> Result<bool, String> {
    let child = registry()
        .lock()
        .map_err(|_| "进程注册表锁失败".to_string())?
        .remove(&task_id);
    let Some(child) = child else {
        let guard = conn.lock().map_err(|_| "数据库锁失败".to_string())?;
        let now = now_secs();
        store::set_state(&guard, task_id, store::TaskState::Stopped, now)?;
        if let Some(run) = store::last_run(&guard, task_id)? {
            if run.state == "running" {
                store::finish_run(&guard, run.id, None, "stopped", now)?;
            }
        }
        return Ok(false);
    };
    let pid = {
        let mut guard = child.lock().map_err(|_| "进程锁失败".to_string())?;
        let pid = guard.id();
        let _ = guard.kill();
        let _ = guard.wait();
        pid
    };
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let guard = conn.lock().map_err(|_| "数据库锁失败".to_string())?;
    let now = now_secs();
    store::set_state(&guard, task_id, store::TaskState::Stopped, now)?;
    if let Some(run) = store::last_run(&guard, task_id)? {
        if run.state == "running" {
            store::finish_run(&guard, run.id, None, "stopped", now)?;
        }
    }
    Ok(true)
}

/// 启动时对账：上次会话遗留的 running/pending 任务一律标记 interrupted。
pub fn reconcile(conn: &Connection, now: i64) -> Result<usize, String> {
    store::mark_stale_interrupted(conn, now)
}
