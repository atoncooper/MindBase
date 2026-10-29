//! 学术项目数据层（Phase 1）：数据集导入 / 画像列表 / 分析脚本执行。
//!
//! 契约见 `plan/1.0.12-AcademicAgent/phase1-spec.md` §2：
//!
//! - `dataset_list` / `dataset_import`：源文件复制到
//!   `<data_dir>/research/<project_id>/data/original/<文件名>`（重名加序号），
//!   MD5 摘要写入 `datasets.sha256` 列（项目无 sha2 依赖，按契约用 MD5），
//!   画像由 `scripts/dataset_profile.py`（嵌入式 Python）计算后落库；
//! - `analysis_run`：脚本写到
//!   `analysis/scripts/<slug>.py`，以项目根目录为 cwd 用嵌入式 Python 执行
//!   （pandas / numpy / matplotlib / openpyxl），默认 120 秒超时后 kill，
//!   stdout 另存 `analysis/outputs/<slug>.txt`。
//!
//! 约定：
//! - 计算密集 / 可能阻塞数分钟的部分（首次安装 Python 依赖）全部走
//!   `spawn_blocking`，不阻塞 Tauri 主线程；
//! - 数据库锁沿用项目约定「先 conn 后 data_dir」，且不在 await 期间持有；
//! - 用户可见错误一律中文。
//!
//! Module layout:
//! - [`types`] — webview DTOs.
//! - [`store`] — dataset row mapping, project check and audit events.
//! - [`import`] — archiving + MD5 + Python profiling + slug.
//! - [`analysis`] — analysis script execution.
//! - [`commands`] — Tauri commands.

use std::path::{Path, PathBuf};

mod analysis;
mod commands;
mod import;
mod store;
mod types;

pub(crate) use commands::*;
pub(crate) use types::{AnalysisResult, DatasetRow};

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|delta| delta.as_secs() as i64)
        .unwrap_or_default()
}

/// 项目根目录：`<data_dir>/research/<project_id>`（与 research.rs 一致）。
fn project_root(data_dir: &Path, project_id: &str) -> PathBuf {
    data_dir.join("research").join(project_id)
}

/// 项目目录骨架（幂等）。旧版本创建的项目可能缺 analysis 目录。
fn ensure_project_dirs(root: &Path) -> Result<(), String> {
    for sub in [
        "data/original",
        "data/derived",
        "analysis/scripts",
        "analysis/outputs",
        "analysis/figures",
    ] {
        let dir = root.join(sub);
        std::fs::create_dir_all(&dir)
            .map_err(|err| format!("无法创建项目目录 {}：{err}", dir.display()))?;
    }
    Ok(())
}
