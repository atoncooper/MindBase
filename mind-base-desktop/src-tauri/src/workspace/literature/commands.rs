//! `#[tauri::command]` 文献命令（统一在 `app/commands.rs` 注册）。

use serde_json::json;
use tauri::State;

use crate::infra::db::Db;

use super::bibtex::{export_bibtex_conn, parse_bibtex};
use super::csl::parse_csl;
use super::crossref::verify_blocking;
use super::store::{
    apply_verified_conn, delete_ref_conn, get_ref_conn, insert_parsed_conn, list_refs_conn,
    mark_status_conn, project_exists, record_event_conn,
};
use super::types::{LiteratureImportResult, LiteratureRef, VerifyOutcome, STATUS_MISSING};

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

/// 列出项目文献（按导入时间倒序）。
#[tauri::command]
pub fn literature_list(
    db: State<'_, Db>,
    project_id: String,
) -> Result<Vec<LiteratureRef>, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("获取数据库锁失败：{err}"))?;
    list_refs_conn(&conn, &project_id)
}

/// 导入 BibTeX / CSL-JSON 文本。
#[tauri::command]
pub fn literature_import(
    db: State<'_, Db>,
    project_id: String,
    format: String,
    content: String,
) -> Result<LiteratureImportResult, String> {
    let mut conn = db
        .conn
        .lock()
        .map_err(|err| format!("获取数据库锁失败：{err}"))?;
    import_text_conn(&mut conn, &project_id, &format, &content)
}

/// 核验单条文献：DOI 精确查询，或（无 DOI 时）按标题检索 Crossref。
///
/// ureq 是阻塞 IO，必须放到 blocking 线程池；持锁只在读写数据库的瞬间。
#[tauri::command]
pub async fn literature_verify(
    db: State<'_, Db>,
    project_id: String,
    ref_id: String,
) -> Result<LiteratureRef, String> {
    let existing = {
        let conn = db
            .conn
            .lock()
            .map_err(|err| format!("获取数据库锁失败：{err}"))?;
        if !project_exists(&conn, &project_id)? {
            return Err(format!("研究项目不存在：{project_id}"));
        }
        get_ref_conn(&conn, &project_id, &ref_id)?.ok_or_else(|| format!("文献不存在：{ref_id}"))?
    };
    if existing.doi.trim().is_empty() && existing.title.trim().is_empty() {
        return Err("该文献既没有 DOI 也没有标题，无法核验".to_string());
    }

    let doi = existing.doi.clone();
    let title = existing.title.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || verify_blocking(&doi, &title))
        .await
        .map_err(|err| format!("核验任务执行失败：{err}"))?;

    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("获取数据库锁失败：{err}"))?;
    let updated = match outcome? {
        VerifyOutcome::Verified(meta) => {
            apply_verified_conn(&conn, &project_id, &ref_id, &existing, &meta)?
        }
        VerifyOutcome::Missing => mark_status_conn(&conn, &project_id, &ref_id, STATUS_MISSING)?,
    };
    record_event_conn(
        &conn,
        &project_id,
        "literature.verified",
        &json!({ "refId": ref_id, "status": updated.status }).to_string(),
    );
    Ok(updated)
}

/// 导入 BibTeX / CSL 文本（工具层复用；调用方持有连接）。
pub(crate) fn import_text_conn(
    conn: &mut rusqlite::Connection,
    project_id: &str,
    format: &str,
    content: &str,
) -> Result<LiteratureImportResult, String> {
    if content.trim().is_empty() {
        return Err("导入内容不能为空".to_string());
    }
    let format = format.trim().to_ascii_lowercase();
    let (entries, errors) = match format.as_str() {
        "bibtex" | "bib" => parse_bibtex(content),
        "csl" | "csl-json" | "json" => parse_csl(content)?,
        other => return Err(format!("不支持的文献格式：{other}（仅支持 bibtex 或 csl）")),
    };
    let failed = errors.len();
    if entries.is_empty() {
        let detail = if errors.is_empty() {
            String::new()
        } else {
            format!("：{}", errors.join("；"))
        };
        return Err(format!("未能从内容中解析出任何文献条目{detail}"));
    }
    if !project_exists(conn, project_id)? {
        return Err(format!("研究项目不存在：{project_id}"));
    }
    let (imported, skipped, refs) = insert_parsed_conn(conn, project_id, entries)?;
    record_event_conn(
        conn,
        project_id,
        "literature.imported",
        &json!({ "imported": imported, "skipped": skipped, "failed": failed }).to_string(),
    );
    Ok(LiteratureImportResult {
        imported,
        skipped,
        failed,
        refs,
        errors,
    })
}

/// Agent / 工具层：核验一条文献（阻塞网络，调用方在自己的工作线程里跑）。
pub(crate) fn verify_ref_conn(
    conn: &rusqlite::Connection,
    project_id: &str,
    ref_id: &str,
) -> Result<LiteratureRef, String> {
    if !project_exists(conn, project_id)? {
        return Err(format!("研究项目不存在：{project_id}"));
    }
    let existing = get_ref_conn(conn, project_id, ref_id)?
        .ok_or_else(|| format!("文献不存在：{ref_id}"))?;
    if existing.doi.trim().is_empty() && existing.title.trim().is_empty() {
        return Err("该文献既没有 DOI 也没有标题，无法核验".to_string());
    }
    let outcome = verify_blocking(&existing.doi, &existing.title)?;
    let updated = match outcome {
        VerifyOutcome::Verified(meta) => {
            apply_verified_conn(conn, project_id, ref_id, &existing, &meta)?
        }
        VerifyOutcome::Missing => mark_status_conn(conn, project_id, ref_id, STATUS_MISSING)?,
    };
    record_event_conn(
        conn,
        project_id,
        "literature.verified",
        &json!({ "refId": ref_id, "status": updated.status }).to_string(),
    );
    Ok(updated)
}

/// 删除一条文献（幂等）并清理它的引用锚点。
#[tauri::command]
pub fn literature_delete(
    db: State<'_, Db>,
    project_id: String,
    ref_id: String,
) -> Result<(), String> {
    let mut conn = db
        .conn
        .lock()
        .map_err(|err| format!("获取数据库锁失败：{err}"))?;
    delete_ref_conn(&mut conn, &project_id, &ref_id)?;
    record_event_conn(
        &conn,
        &project_id,
        "literature.deleted",
        &json!({ "refId": ref_id }).to_string(),
    );
    Ok(())
}

/// 导出项目全部文献为 BibTeX 文本（空库返回空串）。
#[tauri::command]
pub fn literature_export_bibtex(db: State<'_, Db>, project_id: String) -> Result<String, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("获取数据库锁失败：{err}"))?;
    export_bibtex_conn(&conn, &project_id)
}

/// 下载文献 PDF；非 PDF（订阅/登录页）返回在线地址，供前端在线预览。
#[tauri::command]
pub async fn literature_download_pdf(
    db: State<'_, Db>,
    project_id: String,
    ref_id: String,
) -> Result<super::LiteraturePdf, String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db
            .conn
            .lock()
            .map_err(|err| format!("获取数据库锁失败：{err}"))?;
        let data_dir = db
            .data_dir
            .lock()
            .map_err(|err| format!("获取数据目录锁失败：{err}"))?
            .clone();
        super::pdf::download_conn(&conn, &data_dir, &project_id, &ref_id)
    })
    .await
    .map_err(|err| format!("PDF 下载任务执行失败：{err}"))?
}
