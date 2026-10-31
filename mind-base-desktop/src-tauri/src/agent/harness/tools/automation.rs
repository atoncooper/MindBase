//! 自动化任务工具：启动长任务 / 查看状态 / 检索日志 / 分段读取 / 终止 / 重试 / 到期报告。
//!
//! 只做轻量适配：真正的托管（进程、日志分区、状态机、报告节奏）在 crate::automation。
//! 长任务不会阻塞 ReAct 回合：启动后立即返回 task_id，等待与上报由后台线程/调度器完成。

use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use serde_json::{json, Value};

use crate::automation::{log_index, now_secs, report, scheduler, store, supervisor};
use crate::toolkit::shell::MAX_COMMAND_BYTES;

use super::super::registry::{LocalTool, ToolContext, ToolOutput, ToolSpec};
use super::cli;
use super::common::{now_secs_helper, spec};

const MAX_LOG_READ: usize = 64 * 1024;
const MAX_SEARCH_HITS: usize = 50;

fn conn(ctx: &ToolContext) -> Arc<Mutex<Connection>> {
    ctx.db.conn.clone()
}

fn task_id_of(value: &Value) -> Result<i64, String> {
    value
        .get("task_id")
        .and_then(Value::as_i64)
        .filter(|id| *id > 0)
        .ok_or_else(|| "缺少 task_id".to_string())
}

fn latest_stdout_segment(
    conn: &Connection,
    task_id: i64,
) -> Result<Option<std::path::PathBuf>, String> {
    Ok(store::log_segments(conn, task_id)?
        .into_iter()
        .rev()
        .find(|segment| segment.kind == "stdout")
        .map(|segment| segment.path))
}

pub(crate) struct StartAutomationTool;

static SPEC_START_AUTOMATION: std::sync::LazyLock<ToolSpec> = std::sync::LazyLock::new(|| {
    spec(
        "automation_start",
        "启动一个长时自动化任务（构建 / 训练 / 批处理脚本），立即返回 task_id，不阻塞当前回合。\
         适用：预计运行超过 2 分钟、可能被中断重试的脚本。短命令请用 run_command。\
         日志策略：stdout/stderr 直接写入 <data_dir>/automation/<task_id>/<日期>/<时间>_run-<id>.log，\
         工具只返回 task_id / run_id / pid / 日志路径；后续用 automation_status 拿有界摘要（含尾部 4KB），\
         用 automation_log_search / automation_log_read 按需检索，避免把整份日志塞进上下文。\
         报告节奏：interval_secs 决定 automation_due 多久产出一次上下文包（默认 600 秒）。\
         失败重试：最多 max_attempts 次，由 automation_retry 触发。",
        json!({
            "type": "object",
            "required": ["name", "command"],
            "properties": {
                "name": {"type": "string", "description": "任务名（展示与报告用，例如 训练-xxx-2026-10-28）"},
                "command": {"type": "string", "description": "要执行的命令（交给平台默认 shell；建议把详细输出重定向到文件，只保留进度行）"},
                "cwd": {"type": "string", "description": "工作目录（必须在应用数据目录内；默认 <data_dir>）"},
                "interval_secs": {"type": "integer", "minimum": 60, "maximum": 86400, "description": "报告间隔秒数（默认 600）"},
                "max_attempts": {"type": "integer", "minimum": 1, "maximum": 10, "description": "最大尝试次数（默认 3）"}
            }
        }),
    )
});

impl LocalTool for StartAutomationTool {
    fn spec(&self) -> &ToolSpec {
        &SPEC_START_AUTOMATION
    }

    fn execute(&self, ctx: &ToolContext, arguments: &str) -> Result<ToolOutput, String> {
        cli::ensure_shell_enabled(ctx)?;
        let value: Value =
            serde_json::from_str(arguments).map_err(|err| format!("工具参数解析失败：{err}"))?;
        let name = value
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .unwrap_or("自动化任务")
            .to_string();
        let command = value
            .get("command")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_string();
        if command.is_empty() {
            return Err("command 不能为空".to_string());
        }
        if command.len() > MAX_COMMAND_BYTES {
            return Err(format!(
                "命令过长（{} 字节，上限 {MAX_COMMAND_BYTES}）；请把脚本写入文件后再执行",
                command.len()
            ));
        }
        let data_dir = cli::data_dir(ctx)?;
        let cwd = match value.get("cwd").and_then(Value::as_str) {
            Some(raw) if !raw.trim().is_empty() => Some(super::files::resolve_agent_path_in(
                &data_dir,
                ctx.agent.name(),
                raw.trim(),
            )?),
            _ => Some(data_dir.clone()),
        };
        let interval_secs = value
            .get("interval_secs")
            .and_then(Value::as_u64)
            .unwrap_or(600)
            .clamp(60, 86_400);
        let max_attempts = value
            .get("max_attempts")
            .and_then(Value::as_u64)
            .unwrap_or(3)
            .clamp(1, 10) as u32;
        let db = conn(ctx);
        let spec = store::TaskSpec {
            name: name.clone(),
            command: command.clone(),
            cwd,
            interval_secs,
            max_attempts,
        };
        let now = now_secs();
        let task = {
            let guard = db.lock().map_err(|_| "数据库锁失败".to_string())?;
            store::create_task(&guard, &spec, now)?
        };
        let outcome = match supervisor::start(&db, &data_dir, &task, "initial") {
            Ok(outcome) => outcome,
            Err(err) => {
                if let Ok(guard) = db.lock() {
                    let _ = store::set_state(&guard, task.id, store::TaskState::Failed, now);
                }
                return Err(err);
            }
        };
        Ok(ToolOutput::text(format!(
            "已启动自动化任务 #{}（run #{}，pid {}）\n名称：{name}\n日志：{}\n上报间隔：{interval_secs}s；最大重试：{max_attempts}\n后续：automation_status / automation_log_search / automation_log_read / automation_kill / automation_retry",
            outcome.task_id,
            outcome.run_id,
            outcome.pid,
            outcome.stdout_path.display()
        )))
    }
}

pub(crate) struct AutomationStatusTool;

static SPEC_AUTOMATION_STATUS: std::sync::LazyLock<ToolSpec> = std::sync::LazyLock::new(|| {
    spec(
        "automation_status",
        "查看自动化任务状态：状态机 / 尝试次数 / 已运行时长 / 最近退出码 / 尾部 4KB 日志 / 日志路径 / 最近报告。\
         这是周期上报给模型的「上下文包」；不要在轮询里反复调用本工具读全量日志。",
        json!({
            "type": "object",
            "required": ["task_id"],
            "properties": {
                "task_id": {"type": "integer", "minimum": 1, "description": "automation_start 返回的任务 id"}
            }
        }),
    )
});

impl LocalTool for AutomationStatusTool {
    fn spec(&self) -> &ToolSpec {
        &SPEC_AUTOMATION_STATUS
    }

    fn execute(&self, ctx: &ToolContext, arguments: &str) -> Result<ToolOutput, String> {
        let value: Value =
            serde_json::from_str(arguments).map_err(|err| format!("工具参数解析失败：{err}"))?;
        let task_id = task_id_of(&value)?;
        let db = conn(ctx);
        let data_dir = cli::data_dir(ctx)?;
        let guard = db.lock().map_err(|_| "数据库锁失败".to_string())?;
        let pack = report::build_pack(&guard, &data_dir, task_id)?;
        let logs = pack
            .get("logs")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let reports = pack
            .get("recent_reports")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut out = String::new();
        out.push_str(&format!(
            "任务 #{} {}：{}（attempt {}，已运行 {}s，最近退出码 {}）\n",
            pack.get("task_id").and_then(Value::as_i64).unwrap_or(task_id),
            pack.get("name").and_then(Value::as_str).unwrap_or(""),
            pack.get("state").and_then(Value::as_str).unwrap_or("unknown"),
            pack.get("attempt").and_then(Value::as_i64).unwrap_or(0),
            pack.get("elapsed_secs").and_then(Value::as_u64).unwrap_or(0),
            pack.get("last_exit_code")
                .map(|code| code.to_string())
                .unwrap_or_else(|| "无".to_string())
        ));
        for log in logs {
            out.push_str(&format!(
                "日志：{}（{} 字节）\n",
                log.get("path").and_then(Value::as_str).unwrap_or(""),
                log.get("bytes").and_then(Value::as_u64).unwrap_or(0)
            ));
        }
        for report in reports.iter().rev() {
            out.push_str(&format!(
                "报告[{}]：{}\n",
                report.get("kind").and_then(Value::as_str).unwrap_or(""),
                report.get("summary").and_then(Value::as_str).unwrap_or("")
            ));
        }
        out.push_str("--- 尾部日志 ---\n");
        out.push_str(pack.get("tail").and_then(Value::as_str).unwrap_or(""));
        Ok(ToolOutput::text(out))
    }
}

pub(crate) struct AutomationLogSearchTool;

static SPEC_AUTOMATION_LOG_SEARCH: std::sync::LazyLock<ToolSpec> = std::sync::LazyLock::new(|| {
    spec(
        "automation_log_search",
        "在自动化任务的日志里按子串检索（大小写不敏感），返回命中行号与路径，最多 50 条。\
         用于定位 ERROR / OOM / 关键指标，不要用它在循环里轮询全量日志。",
        json!({
            "type": "object",
            "required": ["task_id", "query"],
            "properties": {
                "task_id": {"type": "integer", "minimum": 1},
                "query": {"type": "string", "description": "关键字/子串，例如 ERROR、CUDA out of memory"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 50, "description": "最多返回条数（默认 20）"}
            }
        }),
    )
});

impl LocalTool for AutomationLogSearchTool {
    fn spec(&self) -> &ToolSpec {
        &SPEC_AUTOMATION_LOG_SEARCH
    }

    fn execute(&self, ctx: &ToolContext, arguments: &str) -> Result<ToolOutput, String> {
        let value: Value =
            serde_json::from_str(arguments).map_err(|err| format!("工具参数解析失败：{err}"))?;
        let task_id = task_id_of(&value)?;
        let query = value
            .get("query")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|query| !query.is_empty())
            .ok_or("query 不能为空")?
            .to_string();
        let limit = value
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(20)
            .clamp(1, MAX_SEARCH_HITS as u64) as usize;
        let db = conn(ctx);
        let guard = db.lock().map_err(|_| "数据库锁失败".to_string())?;
        let paths: Vec<std::path::PathBuf> = store::log_segments(&guard, task_id)?
            .into_iter()
            .map(|segment| segment.path)
            .collect();
        let matches = log_index::search_lines(&paths, &query, limit)?;
        let mut out = format!("命中 {} 条（上限 {}）：\n", matches.len(), limit);
        for hit in matches {
            let line: String = hit.line.chars().take(300).collect();
            out.push_str(&format!(
                "{}:{}: {}\n",
                hit.path.file_name().map(|name| name.to_string_lossy()).unwrap_or_default(),
                hit.line_no,
                line
            ));
        }
        Ok(ToolOutput::text(out))
    }
}

pub(crate) struct AutomationLogReadTool;

static SPEC_AUTOMATION_LOG_READ: std::sync::LazyLock<ToolSpec> = std::sync::LazyLock::new(|| {
    spec(
        "automation_log_read",
        "按字节区间读取自动化任务最新 stdout 日志（offset/limit，limit <= 64KB）。\
         只在需要细节时使用；状态摘要请用 automation_status。",
        json!({
            "type": "object",
            "required": ["task_id"],
            "properties": {
                "task_id": {"type": "integer", "minimum": 1},
                "offset": {"type": "integer", "minimum": 0, "description": "起始字节（默认 0）"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 65536, "description": "读取字节数（默认 8192）"}
            }
        }),
    )
});

impl LocalTool for AutomationLogReadTool {
    fn spec(&self) -> &ToolSpec {
        &SPEC_AUTOMATION_LOG_READ
    }

    fn execute(&self, ctx: &ToolContext, arguments: &str) -> Result<ToolOutput, String> {
        let value: Value =
            serde_json::from_str(arguments).map_err(|err| format!("工具参数解析失败：{err}"))?;
        let task_id = task_id_of(&value)?;
        let offset = value.get("offset").and_then(Value::as_u64).unwrap_or(0);
        let limit = value
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(8192)
            .clamp(1, MAX_LOG_READ as u64) as usize;
        let db = conn(ctx);
        let guard = db.lock().map_err(|_| "数据库锁失败".to_string())?;
        let path = latest_stdout_segment(&guard, task_id)?
            .ok_or_else(|| format!("任务 {task_id} 还没有日志"))?;
        drop(guard);
        let (text, total) = log_index::read_range(&path, offset, limit)?;
        Ok(ToolOutput::text(format!(
            "已读取 {}（offset={offset}，limit={limit}，文件共 {total} 字节）：\n{text}",
            path.display()
        )))
    }
}

pub(crate) struct AutomationKillTool;

static SPEC_AUTOMATION_KILL: std::sync::LazyLock<ToolSpec> = std::sync::LazyLock::new(|| {
    spec(
        "automation_kill",
        "终止自动化任务的进程树并标记为 stopped。日志与历史保留，可稍后 automation_retry。",
        json!({
            "type": "object",
            "required": ["task_id"],
            "properties": {"task_id": {"type": "integer", "minimum": 1}}
        }),
    )
});

impl LocalTool for AutomationKillTool {
    fn spec(&self) -> &ToolSpec {
        &SPEC_AUTOMATION_KILL
    }

    fn execute(&self, ctx: &ToolContext, arguments: &str) -> Result<ToolOutput, String> {
        let value: Value =
            serde_json::from_str(arguments).map_err(|err| format!("工具参数解析失败：{err}"))?;
        let task_id = task_id_of(&value)?;
        let db = conn(ctx);
        let killed = supervisor::kill(&db, task_id)?;
        Ok(ToolOutput::text(if killed {
            format!("任务 {task_id} 已终止（保留日志与历史）")
        } else {
            format!("任务 {task_id} 当前没有运行中的进程，已标记为 stopped")
        }))
    }
}

pub(crate) struct AutomationRetryTool;

static SPEC_AUTOMATION_RETRY: std::sync::LazyLock<ToolSpec> = std::sync::LazyLock::new(|| {
    spec(
        "automation_retry",
        "重试一个失败/中断/已停止的自动化任务（最多 max_attempts 次）。\
         重试前建议先用 automation_status + automation_log_search 分析失败原因，并在 reason 里记录判断。",
        json!({
            "type": "object",
            "required": ["task_id"],
            "properties": {
                "task_id": {"type": "integer", "minimum": 1},
                "reason": {"type": "string", "description": "重启原因/分析结论（写入 automation_runs.restart_reason）"}
            }
        }),
    )
});

impl LocalTool for AutomationRetryTool {
    fn spec(&self) -> &ToolSpec {
        &SPEC_AUTOMATION_RETRY
    }

    fn execute(&self, ctx: &ToolContext, arguments: &str) -> Result<ToolOutput, String> {
        let value: Value =
            serde_json::from_str(arguments).map_err(|err| format!("工具参数解析失败：{err}"))?;
        let task_id = task_id_of(&value)?;
        let reason = value
            .get("reason")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|reason| !reason.is_empty())
            .unwrap_or("manual retry")
            .to_string();
        let db = conn(ctx);
        let data_dir = cli::data_dir(ctx)?;
        let task = {
            let guard = db.lock().map_err(|_| "数据库锁失败".to_string())?;
            store::get_task(&guard, task_id)?
        };
        if supervisor::is_running(task_id) {
            return Err(format!("任务 {task_id} 仍在运行，先 automation_kill"));
        }
        if task.attempt + 1 > task.max_attempts as i64 {
            return Err(format!(
                "任务 {task_id} 已达到最大尝试次数（{}/{}）",
                task.attempt, task.max_attempts
            ));
        }
        let outcome = supervisor::start(&db, &data_dir, &task, &reason)?;
        Ok(ToolOutput::text(format!(
            "任务 #{task_id} 已重试（run #{}，pid {}，attempt {}）\n日志：{}",
            outcome.run_id,
            outcome.pid,
            task.attempt + 1,
            outcome.stdout_path.display()
        )))
    }
}

pub(crate) struct AutomationDueTool;

static SPEC_AUTOMATION_DUE: std::sync::LazyLock<ToolSpec> = std::sync::LazyLock::new(|| {
    spec(
        "automation_due",
        "调度器入口：返回当前到期需要上报的任务上下文包，并把报告写入 automation_reports。\
         应由应用后台定时调用（例如每 60s），而不是模型自己轮询；模型每次只看到有界的摘要与尾部日志。",
        json!({"type": "object", "properties": {}}),
    )
});

impl LocalTool for AutomationDueTool {
    fn spec(&self) -> &ToolSpec {
        &SPEC_AUTOMATION_DUE
    }

    fn execute(&self, ctx: &ToolContext, arguments: &str) -> Result<ToolOutput, String> {
        let _ = arguments;
        let db = conn(ctx);
        let data_dir = cli::data_dir(ctx)?;
        let now = now_secs();
        let due = {
            let guard = db.lock().map_err(|_| "数据库锁失败".to_string())?;
            scheduler::due_reports(&guard, now)?
        };
        if due.is_empty() {
            return Ok(ToolOutput::text("当前没有到期的自动化任务报告".to_string()));
        }
        let mut out = String::new();
        for item in due {
            let guard = db.lock().map_err(|_| "数据库锁失败".to_string())?;
            let pack = report::build_pack(&guard, &data_dir, item.task_id)?;
            let _ = report::record(&guard, item.task_id, item.kind, &pack, now)?;
            out.push_str(&format!(
                "[{}] 任务 #{} {}：{}（已运行 {}s）\n尾部：{}\n\n",
                item.kind,
                item.task_id,
                pack.get("name").and_then(Value::as_str).unwrap_or(""),
                pack.get("state").and_then(Value::as_str).unwrap_or("unknown"),
                pack.get("elapsed_secs").and_then(Value::as_u64).unwrap_or(0),
                pack.get("tail")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .chars()
                    .take(1200)
                    .collect::<String>()
            ));
        }
        Ok(ToolOutput::text(out))
    }
}

pub(crate) struct AutomationListTool;

static SPEC_AUTOMATION_LIST: std::sync::LazyLock<ToolSpec> = std::sync::LazyLock::new(|| {
    spec(
        "automation_list",
        "列出最近的自动化任务（状态 / 尝试次数 / 间隔），用于让用户选择查看哪个任务。",
        json!({"type": "object", "properties": {"limit": {"type": "integer", "minimum": 1, "maximum": 50}}}),
    )
});

impl LocalTool for AutomationListTool {
    fn spec(&self) -> &ToolSpec {
        &SPEC_AUTOMATION_LIST
    }

    fn execute(&self, ctx: &ToolContext, arguments: &str) -> Result<ToolOutput, String> {
        let value: Value = serde_json::from_str(arguments).unwrap_or_else(|_| json!({}));
        let limit = value
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(20)
            .clamp(1, 50) as usize;
        let db = conn(ctx);
        let guard = db.lock().map_err(|_| "数据库锁失败".to_string())?;
        let tasks = store::list_tasks(&guard, limit)?;
        if tasks.is_empty() {
            return Ok(ToolOutput::text("还没有自动化任务".to_string()));
        }
        let mut out = String::new();
        for task in tasks {
            out.push_str(&format!(
                "#{} {}：{}（attempt {}，间隔 {}s）\n",
                task.id,
                task.name,
                task.state.as_str(),
                task.attempt,
                task.interval_secs
            ));
        }
        let _ = now_secs_helper();
        Ok(ToolOutput::text(out))
    }
}
