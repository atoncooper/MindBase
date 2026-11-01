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
//! - SQL 全部在 `crate::repositories::dataset`（repository 层）。
//! - [`import`] — archiving + MD5 + Python profiling + slug.
//! - [`analysis`] — analysis script execution.
//! - [`commands`] — Tauri commands.

use std::path::{Path, PathBuf};

mod analysis;
mod commands;
mod import;
mod script;
mod types;

pub(crate) use commands::*;
pub(crate) use script::*;
pub(crate) use types::{AnalysisResult, DatasetRow};

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|delta| delta.as_secs() as i64)
        .unwrap_or_default()
}

/// 校验研究项目存在（和 research 模块的报错口径一致）。
pub(super) fn ensure_project(
    conn: &rusqlite::Connection,
    project_id: &str,
) -> Result<(), String> {
    if crate::repositories::dataset::project_exists(conn, project_id)? {
        Ok(())
    } else {
        Err(format!("研究项目不存在：{project_id}"))
    }
}

/// 追加审计事件；事件流是附加信息，写失败不能影响业务写入。
pub(super) fn record_event(
    conn: &rusqlite::Connection,
    project_id: &str,
    kind: &str,
    payload: &serde_json::Value,
) {
    let _ = crate::repositories::dataset::record_event(conn, project_id, kind, &payload.to_string());
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

/// Agent / 工具层：列出项目数据集（不经过 Tauri State）。
pub(crate) fn list_datasets(
    conn: &rusqlite::Connection,
    project_id: &str,
) -> Result<Vec<DatasetRow>, String> {
    ensure_project(conn, project_id)?;
    crate::repositories::dataset::list(conn, project_id).map_err(Into::into)
}

/// Agent / 工具层：导入本地数据文件（阻塞；归档 + MD5 + Python 画像 + 落库）。
pub(crate) fn import_dataset(
    conn: &rusqlite::Connection,
    data_dir: &Path,
    project_id: &str,
    source: &Path,
) -> Result<DatasetRow, String> {
    ensure_project(conn, project_id)?;
    if !source.is_file() {
        return Err(format!("源文件不存在：{}", source.display()));
    }
    let ext = source
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_lowercase())
        .unwrap_or_default();
    if !import::ALLOWED_EXT.contains(&ext.as_str()) {
        return Err(format!(
            "不支持的数据文件格式：{}（仅支持 {}）",
            if ext.is_empty() { "未知" } else { ext.as_str() },
            import::ALLOWED_EXT.join(" / ")
        ));
    }
    let root = project_root(data_dir, project_id);
    ensure_project_dirs(&root)?;
    let display_name = source
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
        .filter(|stem| !stem.trim().is_empty())
        .unwrap_or_else(|| "dataset".to_string());
    let need_excel = ext != "csv";
    let (target, sha256, profile) =
        import::archive_and_profile(source, data_dir, &root, need_excel)?;
    let rows = profile.get("rows").and_then(serde_json::Value::as_i64);
    let cols = profile.get("cols").and_then(serde_json::Value::as_i64);
    let schema_json = profile
        .get("columns")
        .cloned()
        .unwrap_or_else(|| serde_json::json!([]))
        .to_string();
    let profile_json = profile.to_string();
    let stored_path = target.to_string_lossy().to_string();
    let row = DatasetRow {
        id: crate::infra::db::local_id(),
        name: display_name,
        path: stored_path,
        sha256,
        rows,
        cols,
        privacy: "local".to_string(),
        schema_json,
        profile_json,
        created_at: now_secs(),
    };
    crate::repositories::dataset::insert(conn, project_id, &row)?;
    record_event(
        conn,
        project_id,
        "dataset.imported",
        &serde_json::json!({"dataset": row.id, "name": row.name, "rows": row.rows, "cols": row.cols}),
    );
    Ok(row)
}

/// Agent / 工具层：执行分析脚本（阻塞；120s 超时 kill；输出落 analysis/outputs）。
pub(crate) fn run_analysis(
    conn: &rusqlite::Connection,
    data_dir: &Path,
    project_id: &str,
    name: &str,
    script: &str,
) -> Result<AnalysisResult, String> {
    if script.trim().is_empty() {
        return Err("分析脚本内容不能为空".to_string());
    }
    ensure_project(conn, project_id)?;
    let slug = import::slugify(name);
    let root = project_root(data_dir, project_id);
    ensure_project_dirs(&root)?;
    let result = analysis::run_analysis_script(data_dir, &root, &slug, script)?;
    record_event(
        conn,
        project_id,
        "analysis.run",
        &serde_json::json!({"script": result.script_path, "exitCode": result.exit_code}),
    );
    Ok(result)
}
