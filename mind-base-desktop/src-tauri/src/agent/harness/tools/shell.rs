//! run_command 工具适配层：JSON 参数 -> toolkit::shell 执行 -> 结果格式化 / 审计。
//!
//! 通用执行逻辑在 crate::toolkit；这里只保留 LocalTool 契约与 ToolContext 相关策略。

use std::path::PathBuf;
use std::time::Duration;

use serde_json::{json, Value};

use crate::toolkit::{process, shell};

use super::cli;
use super::common::{now_secs_helper, spec};
use super::super::registry::{LocalTool, ToolContext, ToolOutput, ToolSpec};

/// cwd 解析：默认 <data_dir>/agent-files/<agent>；显式路径走文件工具同一套边界检查。
fn resolve_cwd(
    data_dir: &std::path::Path,
    ctx: &ToolContext,
    raw: Option<&str>,
) -> Result<PathBuf, String> {
    let resolved = match raw.map(str::trim).filter(|value| !value.is_empty()) {
        Some(raw) => super::files::resolve_agent_path_in(data_dir, ctx.agent.name(), raw)?,
        None => data_dir.join("agent-files").join(ctx.agent.name()),
    };
    if !resolved.exists() {
        std::fs::create_dir_all(&resolved)
            .map_err(|err| format!("创建命令工作目录失败（{}）：{err}", resolved.display()))?;
    }
    if !resolved.is_dir() {
        return Err(format!("cwd 不是目录：{}", resolved.display()));
    }
    Ok(resolved)
}

pub(crate) struct RunCommandTool;

static SPEC_RUN_COMMAND: std::sync::LazyLock<ToolSpec> = std::sync::LazyLock::new(|| {
    spec(
        "run_command",
        "在本机执行一条 shell 命令（Windows: pwsh / cmd；Linux / macOS: bash）。\
         默认关闭，需在「系统设置 → 命令执行」开启后才能调用。\
         安全边界：cwd 只能落在应用数据目录内（默认 <data_dir>/agent-files/<agent>/），越界被拒；\
         命令本身继承当前用户权限，可读写用户有权访问的路径（工具层无法强制文件隔离）。\
         network=inherit 继承网络（默认）；network=off 尽力断网执行：Linux 用 unshare -n、macOS 用 sandbox-exec，Windows 不支持会直接报错。\
         输出策略：stdout/stderr **直接写入 <data_dir>/logs/exec/ 下的日志文件**，本工具只回传\
         头 2KB + 尾 4KB 摘要与文件路径；输出很大时用 read_file 的 offset/limit 按字节分段读取完整日志。\
         超时（1s–600s，默认 60s）到达后强杀进程树；每次执行写入 <data_dir>/logs/tool-audit.jsonl（实际文件名 shell-audit.jsonl）。",
        json!({
            "type": "object",
            "required": ["command"],
            "properties": {
                "command": {
                    "type": "string",
                    "description": "要执行的命令文本（原样交给 shell；Windows 下为 PowerShell / cmd 语法，其它平台为 bash 语法）"
                },
                "shell": {
                    "type": "string",
                    "enum": ["pwsh", "cmd", "bash"],
                    "description": "shell 选择：Windows 默认 pwsh（可显式用 cmd）；Linux / macOS 只能用 bash"
                },
                "cwd": {
                    "type": "string",
                    "description": "工作目录（必须在应用数据目录内；默认 <data_dir>/agent-files/<agent>）。可用绝对路径或相对本 agent 目录的相对路径"
                },
                "timeout_ms": {
                    "type": "integer",
                    "minimum": 1000,
                    "maximum": 600000,
                    "description": "执行超时（毫秒，默认 60000）"
                },
                "network": {
                    "type": "string",
                    "enum": ["inherit", "off"],
                    "description": "网络模式：inherit=继承应用网络（默认）；off=尽力断网执行（Linux/macOS 支持，Windows 报错）"
                }
            }
        }),
    )
});


impl LocalTool for RunCommandTool {
    fn spec(&self) -> &ToolSpec {
        &SPEC_RUN_COMMAND
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
        if command.len() > shell::MAX_COMMAND_BYTES {
            return Err(format!(
                "命令过长（{} 字节，上限 {}）；请把脚本写入文件后再执行",
                command.len(),
                shell::MAX_COMMAND_BYTES
            ));
        }
        let shell_kind = shell::ShellKind::parse(value.get("shell").and_then(Value::as_str))?;
        let network = shell::NetworkMode::parse(value.get("network").and_then(Value::as_str))?;
        let timeout = shell::clamp_timeout(value.get("timeout_ms").and_then(Value::as_u64));
        let data_dir = cli::data_dir(ctx)?;
        let cwd = resolve_cwd(&data_dir, ctx, value.get("cwd").and_then(Value::as_str))?;
        let log_dir = process::log_root(&data_dir);

        let capture = shell::run(
            &command,
            shell_kind,
            network,
            &cwd,
            Duration::from_millis(timeout),
            &log_dir,
            "shell",
        )?;
        process::write_audit(
            &data_dir,
            &json!({
                "ts": now_secs_helper(),
                "tool": "run_command",
                "agent": ctx.agent.name(),
                "session_id": ctx.session_id,
                "shell": shell_kind.as_str(),
                "network": network.as_str(),
                "cwd": cwd.to_string_lossy(),
                "command": command.chars().take(2000).collect::<String>(),
                "exit_code": capture.exit_code,
                "timed_out": capture.timed_out,
                "duration_ms": capture.duration_ms,
                "stdout_log": capture.stdout_path.to_string_lossy(),
                "stderr_log": capture.stderr_path.to_string_lossy(),
                "stdout_bytes": capture.stdout_bytes,
                "stderr_bytes": capture.stderr_bytes,
            }),
        );
        let header = format!(
            "命令执行完成：shell={} · network={} · cwd={} · {} · {}ms\n$ {command}\n",
            shell_kind.as_str(),
            network.as_str(),
            cwd.display(),
            capture.status_text(),
            capture.duration_ms
        );
        Ok(ToolOutput::text(format!("{header}{}", capture.sections())))
    }
}
