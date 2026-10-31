//! git 参数构造与执行（结构化 action，不经过 shell 拼接）。

use std::path::Path;
use std::time::Duration;

use serde_json::Value;

use super::process::{run_to_files, RunCapture};

/// git 命令墙钟上限。
pub const GIT_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_ARG_CHARS: usize = 4096;
const MAX_LIMIT: i64 = 200;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GitAction {
    Status,
    Diff,
    Log,
    Show,
    Branch,
    Add,
    Commit,
}

impl GitAction {
    pub fn parse(raw: Option<&str>) -> Result<Self, String> {
        match raw.map(str::trim).filter(|value| !value.is_empty()) {
            None | Some("status") => Ok(GitAction::Status),
            Some("diff") => Ok(GitAction::Diff),
            Some("log") => Ok(GitAction::Log),
            Some("show") => Ok(GitAction::Show),
            Some("branch") => Ok(GitAction::Branch),
            Some("add") => Ok(GitAction::Add),
            Some("commit") => Ok(GitAction::Commit),
            Some(other) => Err(format!(
                "不支持的 git action：{other}（可选 status / diff / log / show / branch / add / commit）"
            )),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            GitAction::Status => "status",
            GitAction::Diff => "diff",
            GitAction::Log => "log",
            GitAction::Show => "show",
            GitAction::Branch => "branch",
            GitAction::Add => "add",
            GitAction::Commit => "commit",
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
    if raw.chars().count() > MAX_ARG_CHARS {
        return Err(format!("{name} 过长（上限 {MAX_ARG_CHARS} 字符）"));
    }
    Ok(raw.to_string())
}

fn optional_str(value: &Value, name: &str) -> Result<Option<String>, String> {
    let Some(raw) = value.get(name).and_then(Value::as_str) else {
        return Ok(None);
    };
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(None);
    }
    if raw.chars().count() > MAX_ARG_CHARS {
        return Err(format!("{name} 过长（上限 {MAX_ARG_CHARS} 字符）"));
    }
    Ok(Some(raw.to_string()))
}

/// 构造 git argv（纯函数，拒绝把用户输入拼进 shell 字符串）。
pub fn build_args(action: GitAction, value: &Value) -> Result<Vec<String>, String> {
    let mut args: Vec<String> = Vec::new();
    match action {
        GitAction::Status => {
            for part in ["status", "--short", "--branch"] {
                args.push(part.to_string());
            }
        }
        GitAction::Diff => {
            args.push("diff".to_string());
            if value.get("staged").and_then(Value::as_bool).unwrap_or(false) {
                args.push("--staged".to_string());
            }
            if value.get("stat").and_then(Value::as_bool).unwrap_or(false) {
                args.push("--stat".to_string());
            }
            if let Some(path) = optional_str(value, "path")? {
                args.push("--".to_string());
                args.push(path);
            }
        }
        GitAction::Log => {
            args.push("log".to_string());
            args.push("--oneline".to_string());
            args.push("--decorate".to_string());
            let limit = value
                .get("limit")
                .and_then(Value::as_i64)
                .unwrap_or(20)
                .clamp(1, MAX_LIMIT);
            args.push("-n".to_string());
            args.push(limit.to_string());
            if let Some(path) = optional_str(value, "path")? {
                args.push("--".to_string());
                args.push(path);
            }
        }
        GitAction::Show => {
            args.push("show".to_string());
            let rev = value
                .get("rev")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("HEAD")
                .to_string();
            if rev.chars().count() > MAX_ARG_CHARS {
                return Err("rev 过长".to_string());
            }
            args.push(rev);
            if value.get("stat").and_then(Value::as_bool).unwrap_or(false) {
                args.push("--stat".to_string());
            }
        }
        GitAction::Branch => {
            for part in ["branch", "--list", "-vv"] {
                args.push(part.to_string());
            }
        }
        GitAction::Add => {
            args.push("add".to_string());
            if value.get("all").and_then(Value::as_bool).unwrap_or(false) {
                args.push("-A".to_string());
            } else {
                let paths = value
                    .get("paths")
                    .and_then(Value::as_array)
                    .ok_or("add 需要 paths 数组（或 all:true）")?;
                if paths.is_empty() {
                    return Err("paths 不能为空".to_string());
                }
                args.push("--".to_string());
                for raw in paths {
                    let path = raw.as_str().map(str::trim).unwrap_or_default();
                    if path.is_empty() {
                        return Err("paths 里有空字符串".to_string());
                    }
                    if path.chars().count() > MAX_ARG_CHARS {
                        return Err("paths 里有过长路径".to_string());
                    }
                    args.push(path.to_string());
                }
            }
        }
        GitAction::Commit => {
            args.push("commit".to_string());
            let message = required_str(value, "message")?;
            args.push("-m".to_string());
            args.push(message);
        }
    }
    Ok(args)
}

/// 一次 git 执行：命令展示串 + 执行结果。
pub struct GitRun {
    pub command_line: String,
    pub capture: RunCapture,
}

/// 在 repo 目录执行 git action（stdout/stderr 落文件）。
pub fn run(
    action: GitAction,
    value: &Value,
    repo: &Path,
    log_dir: &Path,
) -> Result<GitRun, String> {
    let args = build_args(action, value)?;
    let command_line = format!("git {}", args.join(" "));
    let capture = run_to_files("git", &args, repo, GIT_TIMEOUT, log_dir, "git")
        .map_err(|err| format!("{err}\n提示：git 工具需要本机已安装 git 并在 PATH 中。"))?;
    Ok(GitRun { command_line, capture })
}
