//! Tauri commands for research datasets and analysis runs.

use std::path::PathBuf;

use rusqlite::params;
use serde_json::{json, Value};
use tauri::State;

use crate::infra::db::{self, Db};

use super::analysis::run_analysis_script;
use super::import::{archive_and_profile, slugify, ALLOWED_EXT};
use super::store::{dataset_from_row, ensure_project, record_event, DATASET_COLS};
use super::{ensure_project_dirs, now_secs, project_root, AnalysisResult, DatasetRow};

/// 列出某研究项目已导入的数据集（最新在前）。
#[tauri::command]
pub fn dataset_list(db: State<'_, Db>, project_id: String) -> Result<Vec<DatasetRow>, String> {
    let project_id = project_id.trim().to_string();
    if project_id.is_empty() {
        return Err("研究项目 ID 不能为空".to_string());
    }
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("无法获取数据库锁：{err}"))?;
    ensure_project(&conn, &project_id)?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {DATASET_COLS} FROM datasets WHERE project_id = ?1 ORDER BY created_at DESC"
        ))
        .map_err(|err| format!("准备数据集查询失败：{err}"))?;
    let rows = stmt
        .query_map(params![project_id], |row| dataset_from_row(row))
        .map_err(|err| format!("查询数据集失败：{err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("读取数据集失败：{err}"))
}

/// 导入一个本地数据文件：归档到项目目录 → MD5 → Python 画像 → 写库。
#[tauri::command]
pub async fn dataset_import(
    db: State<'_, Db>,
    project_id: String,
    path: String,
) -> Result<DatasetRow, String> {
    let source = PathBuf::from(path.trim());
    if !source.is_file() {
        return Err(format!("源文件不存在：{}", source.display()));
    }
    let ext = source
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_lowercase())
        .unwrap_or_default();
    if !ALLOWED_EXT.contains(&ext.as_str()) {
        let shown = if ext.is_empty() {
            "未知"
        } else {
            ext.as_str()
        };
        return Err(format!(
            "不支持的数据文件格式：{shown}（仅支持 {}）",
            ALLOWED_EXT.join(" / ")
        ));
    }
    let project_id = project_id.trim().to_string();
    if project_id.is_empty() {
        return Err("研究项目 ID 不能为空".to_string());
    }

    // 锁顺序：先 conn 后 data_dir；两者都在进入 await 前释放。
    let data_dir = {
        let conn = db
            .conn
            .lock()
            .map_err(|err| format!("无法获取数据库锁：{err}"))?;
        ensure_project(&conn, &project_id)?;
        drop(conn);
        db.data_dir
            .lock()
            .map_err(|err| format!("无法获取数据目录锁：{err}"))?
            .clone()
    };
    let root = project_root(&data_dir, &project_id);
    ensure_project_dirs(&root)?;

    let display_name = source
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
        .filter(|stem| !stem.trim().is_empty())
        .unwrap_or_else(|| "dataset".to_string());
    let need_excel = ext != "csv";

    let blocking_source = source.clone();
    let blocking_dir = data_dir.clone();
    let blocking_root = root.clone();
    let (target, sha256, profile) = tauri::async_runtime::spawn_blocking(move || {
        archive_and_profile(&blocking_source, &blocking_dir, &blocking_root, need_excel)
    })
    .await
    .map_err(|err| format!("数据集导入任务执行失败：{err}"))??;

    let rows = profile.get("rows").and_then(Value::as_i64);
    let cols = profile.get("cols").and_then(Value::as_i64);
    let schema_json = profile
        .get("columns")
        .cloned()
        .unwrap_or_else(|| json!([]))
        .to_string();
    let profile_json = profile.to_string();
    let stored_path = target.to_string_lossy().to_string();

    let id = db::local_id();
    let created_at = now_secs();
    {
        let conn = db
            .conn
            .lock()
            .map_err(|err| format!("无法获取数据库锁：{err}"))?;
        conn.execute(
            "INSERT INTO datasets(
                 id, project_id, name, path, sha256, rows, cols, privacy,
                 schema_json, profile_json, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'local', ?8, ?9, ?10)",
            params![
                id,
                project_id,
                display_name,
                stored_path,
                sha256,
                rows,
                cols,
                schema_json,
                profile_json,
                created_at,
            ],
        )
        .map_err(|err| format!("写入数据集记录失败：{err}"))?;
        record_event(
            &conn,
            &project_id,
            "dataset.imported",
            &json!({
                "dataset": id.clone(),
                "name": display_name.clone(),
                "rows": rows,
                "cols": cols,
            }),
        );
    }

    Ok(DatasetRow {
        id,
        name: display_name,
        path: stored_path,
        sha256,
        rows,
        cols,
        privacy: "local".to_string(),
        schema_json,
        profile_json,
        created_at,
    })
}

/// 在项目根目录执行一段分析脚本，返回 stdout / stderr / 退出码。
/// 默认 120 秒超时（超时即 kill，返回中文错误）；脚本非 0 退出不算命令失败。
#[tauri::command]
pub async fn analysis_run(
    db: State<'_, Db>,
    project_id: String,
    name: String,
    script: String,
) -> Result<AnalysisResult, String> {
    if script.trim().is_empty() {
        return Err("分析脚本内容不能为空".to_string());
    }
    let project_id = project_id.trim().to_string();
    if project_id.is_empty() {
        return Err("研究项目 ID 不能为空".to_string());
    }
    let slug = slugify(&name);

    let (data_dir, root) = {
        let conn = db
            .conn
            .lock()
            .map_err(|err| format!("无法获取数据库锁：{err}"))?;
        ensure_project(&conn, &project_id)?;
        drop(conn);
        let dir = db
            .data_dir
            .lock()
            .map_err(|err| format!("无法获取数据目录锁：{err}"))?
            .clone();
        let root = project_root(&dir, &project_id);
        (dir, root)
    };

    let result = tauri::async_runtime::spawn_blocking(move || {
        run_analysis_script(&data_dir, &root, &slug, &script)
    })
    .await
    .map_err(|err| format!("分析任务执行失败：{err}"))??;

    // 审计事件：失败不影响返回结果。
    if let Ok(conn) = db.conn.lock() {
        record_event(
            &conn,
            &project_id,
            "analysis.run",
            &json!({
                "script": result.script_path.clone(),
                "exitCode": result.exit_code,
            }),
        );
    }
    Ok(result)
}
