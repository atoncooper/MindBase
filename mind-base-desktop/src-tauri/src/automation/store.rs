//! 自动化任务 / 运行 / 日志段 / 报告 的 SQLite 存储。

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskState {
    Pending,
    Running,
    Succeeded,
    Failed,
    Interrupted,
    Stopped,
}

impl TaskState {
    pub fn as_str(self) -> &'static str {
        match self {
            TaskState::Pending => "pending",
            TaskState::Running => "running",
            TaskState::Succeeded => "succeeded",
            TaskState::Failed => "failed",
            TaskState::Interrupted => "interrupted",
            TaskState::Stopped => "stopped",
        }
    }

    pub fn parse(raw: &str) -> Self {
        match raw {
            "running" => TaskState::Running,
            "succeeded" => TaskState::Succeeded,
            "failed" => TaskState::Failed,
            "interrupted" => TaskState::Interrupted,
            "stopped" => TaskState::Stopped,
            _ => TaskState::Pending,
        }
    }
}

#[derive(Debug, Clone)]
pub struct TaskSpec {
    pub name: String,
    pub command: String,
    pub cwd: Option<PathBuf>,
    pub interval_secs: u64,
    pub max_attempts: u32,
}

#[derive(Debug, Clone)]
pub struct TaskRecord {
    pub id: i64,
    pub name: String,
    pub command: String,
    pub cwd: Option<String>,
    pub interval_secs: u64,
    pub max_attempts: u32,
    pub state: TaskState,
    pub attempt: i64,
    pub last_report_at: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone)]
pub struct RunRecord {
    pub id: i64,
    pub task_id: i64,
    pub attempt: i64,
    pub pid: Option<i64>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub exit_code: Option<i32>,
    pub state: String,
    pub restart_reason: String,
}

#[derive(Debug, Clone)]
pub struct LogSegment {
    pub id: i64,
    pub task_id: i64,
    pub run_id: Option<i64>,
    pub path: PathBuf,
    pub kind: String,
    pub start_offset: u64,
    pub end_offset: u64,
    pub bytes: u64,
}

#[derive(Debug, Clone)]
pub struct ReportRecord {
    pub id: i64,
    pub task_id: i64,
    pub run_id: Option<i64>,
    pub kind: String,
    pub summary: String,
    pub tail: String,
    pub created_at: i64,
}

fn map_task(row: &rusqlite::Row<'_>) -> rusqlite::Result<TaskRecord> {
    let state: String = row.get(6)?;
    Ok(TaskRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        command: row.get(2)?,
        cwd: row.get(3)?,
        interval_secs: row.get::<_, i64>(4)? as u64,
        max_attempts: row.get::<_, i64>(5)? as u32,
        state: TaskState::parse(&state),
        attempt: row.get(7)?,
        last_report_at: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

/// 创建任务（pending，尚未启动）。
pub fn create_task(conn: &Connection, spec: &TaskSpec, now: i64) -> Result<TaskRecord, String> {
    let cwd = spec
        .cwd
        .as_ref()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default();
    conn.execute(
        "INSERT INTO automation_tasks(name, command, cwd, interval_secs, max_attempts, state, attempt, last_report_at, created_at, updated_at)
         VALUES(?1, ?2, ?3, ?4, ?5, 'pending', 0, 0, ?6, ?6)",
        params![
            spec.name,
            spec.command,
            cwd,
            spec.interval_secs as i64,
            spec.max_attempts as i64,
            now
        ],
    )
    .map_err(|err| format!("创建自动化任务失败：{err}"))?;
    get_task(conn, conn.last_insert_rowid())
}

pub fn get_task(conn: &Connection, id: i64) -> Result<TaskRecord, String> {
    conn.query_row(
        "SELECT id, name, command, cwd, interval_secs, max_attempts, state, attempt, last_report_at, created_at, updated_at
         FROM automation_tasks WHERE id = ?1",
        params![id],
        map_task,
    )
    .map_err(|err| format!("自动化任务不存在（id={id}）：{err}"))
}

pub fn list_tasks(conn: &Connection, limit: usize) -> Result<Vec<TaskRecord>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id, name, command, cwd, interval_secs, max_attempts, state, attempt, last_report_at, created_at, updated_at
             FROM automation_tasks ORDER BY id DESC LIMIT ?1",
        )
        .map_err(|err| err.to_string())?;
    let rows = statement
        .query_map(params![limit as i64], map_task)
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|err| err.to_string())
}

pub fn set_state(conn: &Connection, id: i64, state: TaskState, now: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE automation_tasks SET state = ?1, updated_at = ?2 WHERE id = ?3",
        params![state.as_str(), now, id],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

pub fn set_attempt(conn: &Connection, id: i64, attempt: i64, now: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE automation_tasks SET attempt = ?1, updated_at = ?2 WHERE id = ?3",
        params![attempt, now, id],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

pub fn set_last_report_at(conn: &Connection, id: i64, now: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE automation_tasks SET last_report_at = ?1 WHERE id = ?2",
        params![now, id],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

/// 启动时调用：所有仍标记为 running/pending 的任务视为中断（进程已随上次会话丢失）。
pub fn mark_stale_interrupted(conn: &Connection, now: i64) -> Result<usize, String> {
    let tasks = conn
        .execute(
            "UPDATE automation_tasks SET state = 'interrupted', updated_at = ?1 WHERE state IN ('running', 'pending')",
            params![now],
        )
        .map_err(|err| err.to_string())?;
    conn.execute(
        "UPDATE automation_runs SET state = 'interrupted', ended_at = ?1 WHERE state = 'running'",
        params![now],
    )
    .map_err(|err| err.to_string())?;
    Ok(tasks)
}

pub fn start_run(
    conn: &Connection,
    task_id: i64,
    attempt: i64,
    pid: Option<i64>,
    now: i64,
    restart_reason: &str,
) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO automation_runs(task_id, attempt, pid, started_at, state, restart_reason)
         VALUES(?1, ?2, ?3, ?4, 'running', ?5)",
        params![task_id, attempt, pid, now, restart_reason],
    )
    .map_err(|err| format!("创建运行记录失败：{err}"))?;
    Ok(conn.last_insert_rowid())
}

pub fn set_run_pid(conn: &Connection, run_id: i64, pid: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE automation_runs SET pid = ?1 WHERE id = ?2",
        params![pid, run_id],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

pub fn finish_run(
    conn: &Connection,
    run_id: i64,
    exit_code: Option<i32>,
    state: &str,
    now: i64,
) -> Result<(), String> {
    conn.execute(
        "UPDATE automation_runs SET ended_at = ?1, exit_code = ?2, state = ?3 WHERE id = ?4",
        params![now, exit_code, state, run_id],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

pub fn last_run(conn: &Connection, task_id: i64) -> Result<Option<RunRecord>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id, task_id, attempt, pid, started_at, ended_at, exit_code, state, restart_reason
             FROM automation_runs WHERE task_id = ?1 ORDER BY id DESC LIMIT 1",
        )
        .map_err(|err| err.to_string())?;
    let mut rows = statement.query(params![task_id]).map_err(|err| err.to_string())?;
    match rows.next().map_err(|err| err.to_string())? {
        Some(row) => Ok(Some(RunRecord {
            id: row.get(0).map_err(|e| e.to_string())?,
            task_id: row.get(1).map_err(|e| e.to_string())?,
            attempt: row.get(2).map_err(|e| e.to_string())?,
            pid: row.get(3).map_err(|e| e.to_string())?,
            started_at: row.get(4).map_err(|e| e.to_string())?,
            ended_at: row.get(5).map_err(|e| e.to_string())?,
            exit_code: row.get(6).map_err(|e| e.to_string())?,
            state: row.get(7).map_err(|e| e.to_string())?,
            restart_reason: row.get(8).map_err(|e| e.to_string())?,
        })),
        None => Ok(None),
    }
}

pub fn insert_log_segment(
    conn: &Connection,
    task_id: i64,
    run_id: Option<i64>,
    path: &Path,
    kind: &str,
    bytes: u64,
    now: i64,
) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO automation_logs(task_id, run_id, path, kind, start_offset, end_offset, bytes, created_at)
         VALUES(?1, ?2, ?3, ?4, 0, ?5, ?5, ?6)",
        params![task_id, run_id, path.to_string_lossy(), kind, bytes as i64, now],
    )
    .map_err(|err| format!("记录日志段失败：{err}"))?;
    Ok(conn.last_insert_rowid())
}

/// 任务的全部日志段（按 id 升序，旧 → 新）。
pub fn log_segments(conn: &Connection, task_id: i64) -> Result<Vec<LogSegment>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id, task_id, run_id, path, kind, start_offset, end_offset, bytes
             FROM automation_logs WHERE task_id = ?1 ORDER BY id ASC",
        )
        .map_err(|err| err.to_string())?;
    let rows = statement
        .query_map(params![task_id], |row| {
            Ok(LogSegment {
                id: row.get(0)?,
                task_id: row.get(1)?,
                run_id: row.get(2)?,
                path: PathBuf::from(row.get::<_, String>(3)?),
                kind: row.get(4)?,
                start_offset: row.get::<_, i64>(5)? as u64,
                end_offset: row.get::<_, i64>(6)? as u64,
                bytes: row.get::<_, i64>(7)? as u64,
            })
        })
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|err| err.to_string())
}

pub fn insert_report(
    conn: &Connection,
    task_id: i64,
    run_id: Option<i64>,
    kind: &str,
    summary: &str,
    tail: &str,
    now: i64,
) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO automation_reports(task_id, run_id, kind, summary, tail, created_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
        params![task_id, run_id, kind, summary, tail, now],
    )
    .map_err(|err| format!("写入报告失败：{err}"))?;
    Ok(conn.last_insert_rowid())
}

pub fn latest_reports(
    conn: &Connection,
    task_id: i64,
    limit: usize,
) -> Result<Vec<ReportRecord>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id, task_id, run_id, kind, summary, tail, created_at
             FROM automation_reports WHERE task_id = ?1 ORDER BY id DESC LIMIT ?2",
        )
        .map_err(|err| err.to_string())?;
    let rows = statement
        .query_map(params![task_id, limit as i64], |row| {
            Ok(ReportRecord {
                id: row.get(0)?,
                task_id: row.get(1)?,
                run_id: row.get(2)?,
                kind: row.get(3)?,
                summary: row.get(4)?,
                tail: row.get(5)?,
                created_at: row.get(6)?,
            })
        })
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|err| err.to_string())
}

pub fn latest_report_kind(conn: &Connection, task_id: i64) -> Result<Option<String>, String> {
    let mut statement = conn
        .prepare("SELECT kind FROM automation_reports WHERE task_id = ?1 ORDER BY id DESC LIMIT 1")
        .map_err(|err| err.to_string())?;
    let mut rows = statement.query(params![task_id]).map_err(|err| err.to_string())?;
    match rows.next().map_err(|err| err.to_string())? {
        Some(row) => Ok(Some(row.get(0).map_err(|e| e.to_string())?)),
        None => Ok(None),
    }
}
