//! `run_sandboxed` tool — thin adapter over the `crate::sandbox` package.
//!
//! 这里只做：参数解析、配置开关、沙箱目录解析、审计与面向模型的输出；
//! 真正的 OS 级隔离（AppContainer / bubblewrap / seatbelt）在 `crate::sandbox`。

use std::path::PathBuf;
use std::time::Duration;

use serde_json::{json, Value};

use crate::sandbox::{self, SandboxNetwork, SandboxShell};

use super::cli;
use super::common::{now_secs_helper, spec};
use super::super::registry::{LocalTool, ToolContext, ToolOutput, ToolSpec};

const DEFAULT_TIMEOUT_MS: u64 = 120_000;
const MIN_TIMEOUT_MS: u64 = 1_000;
const MAX_TIMEOUT_MS: u64 = 600_000;
const MAX_COMMAND_BYTES: usize = 16 * 1024;

fn clamp_timeout(raw: Option<u64>) -> u64 {
    raw.unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
}

/// 沙箱目录：<data_dir>/agent-files/<agent>/sandbox/（与 write_file 相对路径对齐）。
fn sandbox_dir(ctx: &ToolContext) -> Result<PathBuf, String> {
    let data_dir = ctx
        .db
        .data_dir
        .lock()
        .map_err(|err| format!("failed to acquire data dir lock: {err}"))?
        .clone();
    let dir = data_dir.join("agent-files").join(ctx.agent.name()).join("sandbox");
    std::fs::create_dir_all(&dir)
        .map_err(|err| format!("创建沙箱目录失败（{}）：{err}", dir.display()))?;
    Ok(dir)
}

pub(crate) struct RunSandboxedTool;

static SPEC_RUN_SANDBOXED: std::sync::LazyLock<ToolSpec> = std::sync::LazyLock::new(|| {
    spec(
        "run_sandboxed",
        "在操作系统沙箱中执行命令（真正的隔离，不只靠工具层约定）：Windows 用 AppContainer、\
         Linux 用 bubblewrap、macOS 用 seatbelt；沙箱内默认断网，文件系统只放行沙箱目录。\
         需在「系统设置 → 命令执行」开启。cwd 固定为 <data_dir>/agent-files/<agent>/sandbox/；\
         先用 write_file（相对路径 sandbox/xxx.ps1）把脚本写进沙箱目录，再用本工具运行。\
         默认断网；若代码需要联网（pip/npm 安装、调用 API），显式传 network=on：\n         只放开网络能力，文件仍只能访问沙箱目录。\n         输出策略：stdout/stderr 直接写入 <data_dir>/logs/exec/ 下的日志文件，本工具只回传头 2KB + 尾 4KB\n         摘要与文件路径；输出很大时用 read_file 的 offset/limit 按字节分段读取。\n         命令以非交互方式完成：无法读取用户输入。\
         超时默认 120s（1s–600s），到点强杀沙箱进程。每次执行写入 <data_dir>/logs/shell-audit.jsonl。",
        json!({
            "type": "object",
            "required": ["command"],
            "properties": {
                "command": {
                    "type": "string",
                    "description": "要执行的命令/脚本内容（在沙箱目录内执行）"
                },
                "shell": {
                    "type": "string",
                    "enum": ["pwsh", "cmd", "bash"],
                    "description": "Windows：pwsh（默认）/ cmd；Linux / macOS：bash"
                },
                "timeout_ms": {
                    "type": "integer",
                    "minimum": 1000,
                    "maximum": 600000,
                    "description": "执行超时（毫秒，默认 120000）"
                },
                "network": {
                    "type": "string",
                    "enum": ["off", "on"],
                    "description": "网络策略：off=断网（默认）；on=允许联网（只放开网络，文件隔离不变）"
                }
            }
        }),
    )
});

impl LocalTool for RunSandboxedTool {
    fn spec(&self) -> &ToolSpec {
        &SPEC_RUN_SANDBOXED
    }

    fn execute(&self, ctx: &ToolContext, arguments: &str) -> Result<ToolOutput, String> {
        cli::ensure_shell_enabled(ctx)?;
        let value: Value =
            serde_json::from_str(arguments).map_err(|err| format!("工具参数解析失败：{err}"))?;
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
            return Err(format!("命令过长（{} 字节，上限 {MAX_COMMAND_BYTES}）", command.len()));
        }
        let shell = SandboxShell::parse(value.get("shell").and_then(Value::as_str))?;
        let network = SandboxNetwork::parse(value.get("network").and_then(Value::as_str))?;
        let timeout = clamp_timeout(value.get("timeout_ms").and_then(Value::as_u64));
        let dir = sandbox_dir(ctx)?;
        let data_dir = ctx
            .db
            .data_dir
            .lock()
            .map_err(|err| format!("failed to acquire data dir lock: {err}"))?
            .clone();

        // 输出落文件：工具只回传头/尾摘要与日志路径，避免大输出经内存传递。
        let log_dir = crate::infra::exec_log::log_root(&data_dir);
        let outcome = sandbox::run(
            &command,
            shell,
            &dir,
            Duration::from_millis(timeout),
            network,
            &log_dir,
        )?;
        crate::toolkit::process::write_audit(
            &data_dir,
            &json!({
                "ts": now_secs_helper(),
                "tool": "run_sandboxed",
                "backend": sandbox::backend_name(),
                "agent": ctx.agent.name(),
                "session_id": ctx.session_id,
                "shell": shell.as_str(),
                "network": network.as_str(),
                "cwd": dir.to_string_lossy(),
                "command": command.chars().take(2000).collect::<String>(),
                "exit_code": outcome.exit_code,
                "timed_out": outcome.timed_out,
                "duration_ms": outcome.duration_ms,
                "stdout_log": outcome.stdout_path.to_string_lossy(),
                "stderr_log": outcome.stderr_path.to_string_lossy(),
                "stdout_bytes": outcome.stdout_bytes,
                "stderr_bytes": outcome.stderr_bytes,
            }),
        );

        let status = if outcome.timed_out {
            "超时终止".to_string()
        } else {
            match outcome.exit_code {
                Some(code) => format!("退出码 {code}"),
                None => "已被信号终止".to_string(),
            }
        };
        let header = format!(
            "沙箱执行完成：backend={} · shell={} · 网络={} · cwd={} · {status} · {}ms\n$ {command}\n",
            sandbox::backend_name(),
            shell.as_str(),
            network.as_str(),
            dir.display(),
            outcome.duration_ms
        );
        let stdout = crate::infra::exec_log::summarize(&outcome.stdout_path, outcome.stdout_bytes);
        let stderr = crate::infra::exec_log::summarize(&outcome.stderr_path, outcome.stderr_bytes);
        let body = format!(
            "--- stdout（{} 字节）---\n{stdout}\n--- stderr（{} 字节）---\n{stderr}",
            outcome.stdout_bytes, outcome.stderr_bytes
        );
        Ok(ToolOutput::text(format!("{header}{body}")))
    }
}
