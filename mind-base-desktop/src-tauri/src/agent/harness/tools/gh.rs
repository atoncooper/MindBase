//! gh 工具适配层：JSON 参数 -> toolkit::gh 执行 -> 结果格式化 / 审计。

use serde_json::{json, Value};

use crate::toolkit::{gh, process};

use super::cli;
use super::common::{now_secs_helper, spec};
use super::super::registry::{LocalTool, ToolContext, ToolOutput, ToolSpec};

pub(crate) struct GhTool;

static SPEC_GH: std::sync::LazyLock<ToolSpec> = std::sync::LazyLock::new(|| {
    spec(
        "gh",
        "通过本机 GitHub CLI（gh）查询/创建 GitHub 资源。前提：本机已安装 gh 并完成 gh auth login；\
         工具本身不保存 token。需在「系统设置 → 命令执行」开启。\
         action：auth_status（诊断登录态与 host）/ pr_list（可选 state open|closed|merged|all、limit）/ \
         pr_view（number，含正文与合并状态）/ pr_diff（number）/ pr_checks（number，CI 状态）/ \
         issue_list / issue_view / pr_create（title、body，可选 base、draft）。\
         repo 必须是仓库根的绝对路径（如 D:/code/MindBase），gh 从该目录的 git remote 推断仓库；\
         省略时用应用数据目录（通常不是仓库）。pr_create 属写操作，只在用户明确要求时调用。\
         输出用 gh --json 结构化结果；每次调用写入 <data_dir>/logs/shell-audit.jsonl。",
        json!({
            "type": "object",
            "required": ["action"],
            "properties": {
                "action": {
                    "type": "string",
                    "enum": [
                        "auth_status",
                        "pr_list",
                        "pr_view",
                        "pr_diff",
                        "pr_checks",
                        "issue_list",
                        "issue_view",
                        "pr_create"
                    ],
                    "description": "gh 操作"
                },
                "repo": { "type": "string", "description": "仓库根的绝对路径（gh 据此推断 owner/name）" },
                "number": { "type": "integer", "description": "pr_view / pr_diff / pr_checks / issue_view 的编号" },
                "state": { "type": "string", "description": "列表过滤：pr=open|closed|merged|all；issue=open|closed|all" },
                "limit": { "type": "integer", "minimum": 1, "maximum": 100, "description": "列表条数（默认 20）" },
                "title": { "type": "string", "description": "pr_create: 标题" },
                "body": { "type": "string", "description": "pr_create: 正文（Markdown）" },
                "base": { "type": "string", "description": "pr_create: 目标分支（默认仓库默认分支）" },
                "draft": { "type": "boolean", "description": "pr_create: true=草稿 PR" }
            }
        }),
    )
});


impl LocalTool for GhTool {
    fn spec(&self) -> &ToolSpec {
        &SPEC_GH
    }

    fn execute(&self, ctx: &ToolContext, arguments: &str) -> Result<ToolOutput, String> {
        cli::ensure_shell_enabled(ctx)?;
        let value: Value =
            serde_json::from_str(arguments).map_err(|err| format!("工具参数解析失败：{err}"))?;
        let action = gh::GhAction::parse(value.get("action").and_then(Value::as_str))?;
        let repo = cli::resolve_repo(ctx, value.get("repo").and_then(Value::as_str))?;
        let data_dir = cli::data_dir(ctx)?;
        let log_dir = process::log_root(&data_dir);
        let run = gh::run(action, &value, &repo, &log_dir)?;
        process::write_audit(
            &data_dir,
            &json!({
                "ts": now_secs_helper(),
                "tool": "gh",
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
