//! Agent 工具层专用辅助：配置开关、数据目录解析、repo 路径解析。
//!
//! 通用进程执行 / 输出落文件 / 审计在 `crate::toolkit::process`；
//! 本模块只保留需要 `ToolContext`（即 harness 概念）的部分。

use std::path::PathBuf;

use super::super::registry::ToolContext;

/// 命令执行总开关（AppConfig.shell_enabled，默认关闭）。每次调用都读配置。
pub(super) fn ensure_shell_enabled(ctx: &ToolContext) -> Result<(), String> {
    let enabled = {
        let conn = ctx
            .db
            .conn
            .lock()
            .map_err(|err| format!("failed to acquire database lock: {err}"))?;
        crate::infra::config::load(&conn)?.shell_enabled
    };
    if !enabled {
        return Err("命令执行已关闭：请在「系统设置 → 命令执行」开启后再试（默认关闭，避免 Agent 未经授权执行本机命令）。".to_string());
    }
    Ok(())
}

/// 当前数据目录（工具用于日志 / 审计定位）。
pub(super) fn data_dir(ctx: &ToolContext) -> Result<PathBuf, String> {
    Ok(ctx
        .db
        .data_dir
        .lock()
        .map_err(|err| format!("failed to acquire data dir lock: {err}"))?
        .clone())
}

/// 解析 git / gh 的仓库目录：显式传入时必须是已存在的绝对路径目录；
/// 省略时回退到应用数据目录（通常不是 git 仓库，命令会自行报错）。
pub(super) fn resolve_repo(ctx: &ToolContext, raw: Option<&str>) -> Result<PathBuf, String> {
    let fallback = data_dir(ctx)?;
    let raw = raw.map(str::trim).filter(|value| !value.is_empty());
    match raw {
        None => Ok(fallback),
        Some(path) => {
            let candidate = PathBuf::from(path);
            if !candidate.is_absolute() {
                return Err(format!(
                    "repo 必须是绝对路径（收到 {path:?}）；例如 D:/code/my-project 或 /home/me/project"
                ));
            }
            if !candidate.exists() {
                return Err(format!("repo 不存在：{}", candidate.display()));
            }
            if !candidate.is_dir() {
                return Err(format!("repo 不是目录：{}", candidate.display()));
            }
            std::fs::canonicalize(&candidate)
                .map_err(|err| format!("无法解析 repo 路径（{}）：{err}", candidate.display()))
        }
    }
}
