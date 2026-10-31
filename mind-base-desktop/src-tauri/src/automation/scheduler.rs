//! 报告节奏：由调度器决定何时叫 AI（而不是模型轮询）。

use rusqlite::Connection;

use crate::automation::{now_secs, store};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DueReport {
    pub task_id: i64,
    /// scheduled / succeeded / failed / interrupted / stopped
    pub kind: &'static str,
}

/// 扫描所有任务，返回这一轮应该上报给 AI 的任务。
///
/// - running：距上次报告 >= interval_secs（无变化可在外层再过滤）；
/// - succeeded / failed / interrupted / stopped：终态第一次出现时立即上报一次。
pub fn due_reports(conn: &Connection, now: i64) -> Result<Vec<DueReport>, String> {
    let tasks = store::list_tasks(conn, 200)?;
    let mut due = Vec::new();
    for task in tasks {
        let kind = match task.state {
            store::TaskState::Running => {
                let elapsed = now.saturating_sub(task.last_report_at);
                if task.last_report_at == 0 || elapsed >= task.interval_secs as i64 {
                    Some("scheduled")
                } else {
                    None
                }
            }
            store::TaskState::Succeeded => Some("succeeded"),
            store::TaskState::Failed => Some("failed"),
            store::TaskState::Interrupted => Some("interrupted"),
            store::TaskState::Stopped => Some("stopped"),
            store::TaskState::Pending => None,
        };
        let Some(kind) = kind else { continue };
        let already = store::latest_report_kind(conn, task.id)?
            .map(|last| last == kind)
            .unwrap_or(false);
        if !already {
            due.push(DueReport {
                task_id: task.id,
                kind,
            });
        }
    }
    Ok(due)
}

/// 连续失败时的退避间隔（秒）：base * 2^(failures-1)，上限 1 小时。
pub fn backoff_secs(base: u64, consecutive_failures: u32) -> u64 {
    let factor = 1u64 << consecutive_failures.saturating_sub(1).min(6);
    (base.saturating_mul(factor)).min(3600)
}

#[allow(dead_code)]
fn _now() -> i64 {
    now_secs()
}
