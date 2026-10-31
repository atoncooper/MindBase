//! git 工具适配层：JSON 参数 -> toolkit::git 执行 -> 结果格式化 / 审计。
//!
//! 参数构造与子进程执行在 crate::toolkit；这里只保留 LocalTool 契约与 ToolContext 策略。

use serde_json::{json, Value};

use crate::toolkit::{git, process};

use super::cli;
use super::common::{now_secs_helper, spec};
use super::super::registry::{LocalTool, ToolContext, ToolOutput, ToolSpec};

pub(crate) struct GitTool;

static SPEC_GIT: std::sync::LazyLock<ToolSpec> = std::sync::LazyLock::new(|| {
    spec(
        "git",
        "在本地 git 仓库执行常用 git 操作（结构化参数，不经过 shell 拼接）。\
         需在「系统设置 → 命令执行」开启；本机需安装 git。\
         action：status（短状态+分支）/ diff（可选 staged、stat、path）/ log（oneline，可选 limit/path）/ \
         show（rev，默认 HEAD，可选 stat）/ branch（本地分支列表）/ add（paths 或 all）/ commit（message）。\
         repo 必须是仓库根的绝对路径（如 D:/code/my-project）；省略时用应用数据目录（通常不是仓库）。\
         只有在用户明确要求时才执行 add / commit 这类写操作；提交前先用 status/diff 确认改动。\
         每次调用写入 <data_dir>/logs/shell-audit.jsonl；输出上限 16KB/流。",
        json!({
            "type": "object",
            "required": ["action"],
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["status", "diff", "log", "show", "branch", "add", "commit"],
                    "description": "git 操作"
                },
                "repo": { "type": "string", "description": "仓库根的绝对路径（必须已存在）" },
                "path": { "type": "string", "description": "diff / log 限定的路径（相对 repo）" },
                "staged": { "type": "boolean", "description": "diff: true=查看已暂存差异" },
                "stat": { "type": "boolean", "description": "diff / show: true=只要统计" },
                "rev": { "type": "string", "description": "show: 修订号，默认 HEAD" },
                "limit": { "type": "integer", "minimum": 1, "maximum": 200, "description": "log: 条数（默认 20）" },
                "paths": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "add: 要暂存的路径列表"
                },
                "all": { "type": "boolean", "description": "add: true=暂存全部改动（git add -A）" },
                "message": { "type": "string", "description": "commit: 提交信息" }
            }
        }),
    )
});


impl LocalTool for GitTool {
    fn spec(&self) -> &ToolSpec {
        &SPEC_GIT
    }

    fn execute(&self, ctx: &ToolContext, arguments: &str) -> Result<ToolOutput, String> {
        cli::ensure_shell_enabled(ctx)?;
        let value: Value =
            serde_json::from_str(arguments).map_err(|err| format!("工具参数解析失败：{err}"))?;
        let action = git::GitAction::parse(value.get("action").and_then(Value::as_str))?;
        let repo = cli::resolve_repo(ctx, value.get("repo").and_then(Value::as_str))?;
        let data_dir = cli::data_dir(ctx)?;
        let log_dir = process::log_root(&data_dir);
        let run = git::run(action, &value, &repo, &log_dir)?;
        process::write_audit(
            &data_dir,
            &json!({
                "ts": now_secs_helper(),
                "tool": "git",
                "agent": ctx.agent.name(),
                "session_id": ctx.session_id,
                "action": action.as_str(),
                "repo": repo.to_string_lossy(),
                "command": run.command_line,
                "exit_code": run.capture.exit_code,
                "timed_out": run.capture.timed_out,
                "duration_ms": run.capture.duration_ms,
                "stdout_log": run.capture.stdout_path.to_string_lossy(),
                "stderr_log": run.capture.stderr_path.to_string_lossy(),
                "stdout_bytes": run.capture.stdout_bytes,
                "stderr_bytes": run.capture.stderr_bytes,
            }),
        );
        let header = format!(
            "{} · repo={} · {} · {}ms\n",
            run.command_line,
            repo.display(),
            run.capture.status_text(),
            run.capture.duration_ms
        );
        Ok(ToolOutput::text(format!("{header}{}", run.capture.sections())))
    }
}
