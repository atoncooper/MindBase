//! 面向 AI 的上下文包：状态 + 尾部日志 + 日志指针 + 最近报告，严格限量。

use std::path::Path;

use rusqlite::Connection;
use serde_json::{json, Value};

use crate::automation::{log_index, now_secs, store};

/// 尾部日志最多取多少字节（约 4KB，够定位问题又不污染上下文）。
pub const TAIL_BYTES: usize = 4 * 1024;
const RECENT_REPORTS: usize = 3;

/// 构建一次报告上下文包（可直接喂给模型；JSON 序列化后通常 < 8KB）。
pub fn build_pack(
    conn: &Connection,
    _data_dir: &Path,
    task_id: i64,
) -> Result<Value, String> {
    let task = store::get_task(conn, task_id)?;
    let run = store::last_run(conn, task_id)?;
    let segments = store::log_segments(conn, task_id)?;
    let tail_segment = segments
        .iter()
        .rev()
        .find(|segment| segment.kind == "stdout");
    let tail = tail_segment
        .map(|segment| log_index::read_tail(&segment.path, TAIL_BYTES))
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| "（暂无输出）".to_string());
    let logs: Vec<Value> = segments
        .iter()
        .rev()
        .take(4)
        .map(|segment| {
            json!({
                "path": segment.path.to_string_lossy(),
                "kind": segment.kind,
                "bytes": segment.bytes,
            })
        })
        .collect();
    let recent: Vec<Value> = store::latest_reports(conn, task_id, RECENT_REPORTS)?
        .into_iter()
        .map(|report| {
            json!({
                "kind": report.kind,
                "summary": report.summary,
                "at": report.created_at,
            })
        })
        .collect();
    let now = now_secs();
    let elapsed_secs = run
        .as_ref()
        .map(|run| now.saturating_sub(run.started_at).max(0) as u64)
        .unwrap_or(0);
    Ok(json!({
        "task_id": task.id,
        "name": task.name,
        "command": task.command,
        "state": task.state.as_str(),
        "attempt": task.attempt,
        "interval_secs": task.interval_secs,
        "elapsed_secs": elapsed_secs,
        "last_exit_code": run.as_ref().and_then(|run| run.exit_code),
        "last_run_state": run.as_ref().map(|run| run.state.clone()),
        "tail": tail,
        "logs": logs,
        "recent_reports": recent,
        "log_hint": "需要细节请调用 automation_log_search / automation_log_read（按 offset/limit 分段）",
    }))
}

/// 单行摘要（写进 automation_reports.summary，控制长度）。
pub fn summarize(pack: &Value) -> String {
    let name = pack.get("name").and_then(Value::as_str).unwrap_or("task");
    let state = pack.get("state").and_then(Value::as_str).unwrap_or("unknown");
    let attempt = pack.get("attempt").and_then(Value::as_i64).unwrap_or(0);
    let elapsed = pack.get("elapsed_secs").and_then(Value::as_u64).unwrap_or(0);
    format!("{name}: {state}（attempt {attempt}，已运行 {elapsed}s）")
}

/// 记录一条报告（DB 只存摘要 + 尾部，正文留在日志文件）。
pub fn record(
    conn: &Connection,
    task_id: i64,
    kind: &str,
    pack: &Value,
    now: i64,
) -> Result<i64, String> {
    let tail = pack.get("tail").and_then(Value::as_str).unwrap_or_default();
    let run_id = store::last_run(conn, task_id)?.map(|run| run.id);
    let id = store::insert_report(conn, task_id, run_id, kind, &summarize(pack), tail, now)?;
    store::set_last_report_at(conn, task_id, now)?;
    Ok(id)
}
