//! GitHub CLI（gh）参数构造与执行。

use std::path::Path;
use std::time::Duration;

use serde_json::Value;

use super::process::{run_to_files, RunCapture};

/// gh 命令墙钟上限。
pub const GH_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_LIMIT: i64 = 100;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GhAction {
    AuthStatus,
    PrList,
    PrView,
    PrDiff,
    PrChecks,
    IssueList,
    IssueView,
    PrCreate,
}

impl GhAction {
    pub fn parse(raw: Option<&str>) -> Result<Self, String> {
        match raw.map(str::trim).filter(|value| !value.is_empty()) {
            Some("auth_status") | Some("auth") => Ok(GhAction::AuthStatus),
            Some("pr_list") | Some("prs") => Ok(GhAction::PrList),
            Some("pr_view") => Ok(GhAction::PrView),
            Some("pr_diff") => Ok(GhAction::PrDiff),
            Some("pr_checks") => Ok(GhAction::PrChecks),
            Some("issue_list") | Some("issues") => Ok(GhAction::IssueList),
            Some("issue_view") => Ok(GhAction::IssueView),
            Some("pr_create") => Ok(GhAction::PrCreate),
            None => Err(
                "缺少 action（可选 auth_status / pr_list / pr_view / pr_diff / pr_checks / issue_list / issue_view / pr_create）"
                    .to_string(),
            ),
            Some(other) => Err(format!(
                "不支持的 gh action：{other}（可选 auth_status / pr_list / pr_view / pr_diff / pr_checks / issue_list / issue_view / pr_create）"
            )),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            GhAction::AuthStatus => "auth_status",
            GhAction::PrList => "pr_list",
            GhAction::PrView => "pr_view",
            GhAction::PrDiff => "pr_diff",
            GhAction::PrChecks => "pr_checks",
            GhAction::IssueList => "issue_list",
            GhAction::IssueView => "issue_view",
            GhAction::PrCreate => "pr_create",
        }
    }
}

fn required_str(value: &Value, name: &str) -> Result<String, String> {
    let raw = value
        .get(name)
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if raw.is_empty() {
        return Err(format!("缺少 {name}"));
    }
    Ok(raw.to_string())
}

fn optional_str(value: &Value, name: &str) -> Option<String> {
    value
        .get(name)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|raw| !raw.is_empty())
        .map(str::to_string)
}

fn required_number(value: &Value, name: &str) -> Result<String, String> {
    let number = value
        .get(name)
        .and_then(Value::as_i64)
        .ok_or(format!("缺少 {name}（数字）"))?;
    if number <= 0 {
        return Err(format!("{name} 必须是正整数"));
    }
    Ok(number.to_string())
}

fn limit_of(value: &Value) -> String {
    value
        .get("limit")
        .and_then(Value::as_i64)
        .unwrap_or(20)
        .clamp(1, MAX_LIMIT)
        .to_string()
}

/// 构造 gh argv（纯函数，便于单测）。
pub fn build_args(action: GhAction, value: &Value) -> Result<Vec<String>, String> {
    let mut args: Vec<String> = Vec::new();
    let push = |args: &mut Vec<String>, part: &str| args.push(part.to_string());
    match action {
        GhAction::AuthStatus => {
            push(&mut args, "auth");
            push(&mut args, "status");
        }
        GhAction::PrList => {
            push(&mut args, "pr");
            push(&mut args, "list");
            push(&mut args, "--limit");
            args.push(limit_of(value));
            if let Some(state) = optional_str(value, "state") {
                let state = state.to_ascii_lowercase();
                if !matches!(state.as_str(), "open" | "closed" | "merged" | "all") {
                    return Err("state 只能是 open / closed / merged / all".to_string());
                }
                push(&mut args, "--state");
                args.push(state);
            }
            push(&mut args, "--json");
            push(
                &mut args,
                "number,title,state,author,url,updatedAt,isDraft,mergeable",
            );
        }
        GhAction::PrView => {
            push(&mut args, "pr");
            push(&mut args, "view");
            args.push(required_number(value, "number")?);
            push(&mut args, "--json");
            push(
                &mut args,
                "number,title,state,author,body,url,mergeable,isDraft,baseRefName,headRefName",
            );
        }
        GhAction::PrDiff => {
            push(&mut args, "pr");
            push(&mut args, "diff");
            args.push(required_number(value, "number")?);
        }
        GhAction::PrChecks => {
            push(&mut args, "pr");
            push(&mut args, "checks");
            args.push(required_number(value, "number")?);
        }
        GhAction::IssueList => {
            push(&mut args, "issue");
            push(&mut args, "list");
            push(&mut args, "--limit");
            args.push(limit_of(value));
            if let Some(state) = optional_str(value, "state") {
                let state = state.to_ascii_lowercase();
                if !matches!(state.as_str(), "open" | "closed" | "all") {
                    return Err("state 只能是 open / closed / all".to_string());
                }
                push(&mut args, "--state");
                args.push(state);
            }
            push(&mut args, "--json");
            push(&mut args, "number,title,state,author,url,updatedAt");
        }
        GhAction::IssueView => {
            push(&mut args, "issue");
            push(&mut args, "view");
            args.push(required_number(value, "number")?);
            push(&mut args, "--json");
            push(&mut args, "number,title,state,author,body,url");
        }
        GhAction::PrCreate => {
            push(&mut args, "pr");
            push(&mut args, "create");
            push(&mut args, "--title");
            args.push(required_str(value, "title")?);
            push(&mut args, "--body");
            args.push(optional_str(value, "body").unwrap_or_default());
            if let Some(base) = optional_str(value, "base") {
                push(&mut args, "--base");
                args.push(base);
            }
            if value.get("draft").and_then(Value::as_bool).unwrap_or(false) {
                push(&mut args, "--draft");
            }
        }
    }
    Ok(args)
}

/// 一次 gh 执行：命令展示串 + 执行结果。
pub struct GhRun {
    pub command_line: String,
    pub capture: RunCapture,
}

/// 在 repo 目录执行 gh action（stdout/stderr 落文件）。
pub fn run(action: GhAction, value: &Value, repo: &Path, log_dir: &Path) -> Result<GhRun, String> {
    let args = build_args(action, value)?;
    let command_line = format!("gh {}", args.join(" "));
    let capture = run_to_files("gh", &args, repo, GH_TIMEOUT, log_dir, "gh").map_err(|err| {
        format!(
            "{err}\n未检测到可用的 GitHub CLI（gh）。请先安装 https://cli.github.com/ 并执行 gh auth login 后重试。"
        )
    })?;
    Ok(GhRun { command_line, capture })
}
