//! Manuscript documents + sections + DOCX/LaTeX export.
//!
//! 写作从「单篇稿件」升级为「文档类型 + 每类独立章节/导出」：一个项目下可以有
//! 多份文档（开题报告 / 初稿 / 修改稿 / 投稿信 / 自定义），章节通过 document_id
//! 归属到文档。章节正文落在 <data_dir>/research/<project>/manuscript/documents/
//! <document_id>/<section>.md（旧路径仍可读，不强制搬迁）。
//!
//! DOCX 渲染走内置 Python（scripts/build_docx.py, python-docx），LaTeX 由
//! manuscript_latex 纯 Rust 生成，两条链路都以文档 title 作为导出标题。

use std::io::Write;
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde::Serialize;
use tauri::State;

use crate::infra::db::{self, Db};
use crate::repositories::manuscript as manuscript_repo;

/// Canonical section order for a journal manuscript.
pub(crate) const DEFAULT_SECTIONS: [&str; 8] = [
    "摘要",
    "1 引言",
    "2 相关工作",
    "3 方法",
    "4 实验",
    "5 讨论",
    "6 结论",
    "参考文献",
];

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|delta| delta.as_secs() as i64)
        .unwrap_or_default()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManuscriptSection {
    pub id: String,
    pub section: String,
    pub ord: i64,
    pub path: String,
    pub words: i64,
    pub status: String,
    pub updated_at: i64,
    /// Current body (read from the section file) so the editor can re-hydrate.
    pub content: String,
}

/// 写作文件（文档类型 + 每类独立章节）。列表带章节数 / 字数统计。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManuscriptDocument {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub section_count: i64,
    pub words: i64,
    pub updated_at: i64,
    /// 导入的原始文件（项目根内相对路径；空串=非导入文档）。
    pub source_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxExport {
    pub path: String,
    pub sections: i64,
    pub words: i64,
}

fn section_ord(section: &str) -> i64 {
    DEFAULT_SECTIONS
        .iter()
        .position(|candidate| candidate == &section)
        .map(|index| index as i64)
        .unwrap_or(DEFAULT_SECTIONS.len() as i64)
}

fn into_section(row: manuscript_repo::SectionRow, content: String) -> ManuscriptSection {
    ManuscriptSection {
        id: row.id,
        section: row.section,
        ord: row.ord,
        path: row.path,
        words: row.words,
        status: row.status,
        updated_at: row.updated_at,
        content,
    }
}

fn into_document(row: manuscript_repo::DocumentSummaryRow) -> ManuscriptDocument {
    ManuscriptDocument {
        id: row.id,
        kind: row.kind,
        title: row.title,
        section_count: row.section_count,
        words: row.words,
        updated_at: row.updated_at,
        source_path: row.source_path,
    }
}

fn document_dir(data_dir: &Path, project_id: &str, document_id: &str) -> PathBuf {
    data_dir
        .join("research")
        .join(project_id)
        .join("manuscript")
        .join("documents")
        .join(document_id)
}

fn project_meta_conn(
    conn: &Connection,
    project_id: &str,
) -> Result<manuscript_repo::ProjectMeta, String> {
    manuscript_repo::project_meta(conn, project_id)?
        .ok_or_else(|| format!("研究项目不存在：{project_id}"))
}

/// 按 (project_id, document_id) 取文档，不存在时返回中文错误。
fn document_or_err(
    conn: &Connection,
    project_id: &str,
    document_id: &str,
) -> Result<manuscript_repo::DocumentRow, String> {
    manuscript_repo::documents_find(conn, project_id, document_id)?
        .ok_or_else(|| format!("写作文档不存在：{document_id}"))
}

// ---------------------------------------------------------------------------
// 文档 / 章节读写（命令与 agent 工具共用）
// ---------------------------------------------------------------------------

/// 项目文档列表（含章节数 / 字数）。
pub(crate) fn document_list(
    conn: &Connection,
    project_id: &str,
) -> Result<Vec<ManuscriptDocument>, String> {
    Ok(manuscript_repo::documents_list(conn, project_id)?
        .into_iter()
        .map(into_document)
        .collect())
}

/// 解析 agent 传入的 document_id：缺省 = 最近更新的文档；没有任何文档时自动
/// 创建 kind='draft' title='初稿' 的默认文档。
pub(crate) fn resolve_document(
    conn: &Connection,
    project_id: &str,
    document_id: Option<&str>,
) -> Result<manuscript_repo::DocumentRow, String> {
    if let Some(document_id) = document_id {
        return document_or_err(conn, project_id, document_id);
    }
    if let Some(document) = manuscript_repo::documents_latest(conn, project_id)? {
        return Ok(document);
    }
    create_default_document_conn(conn, project_id)
}

fn create_default_document_conn(
    conn: &Connection,
    project_id: &str,
) -> Result<manuscript_repo::DocumentRow, String> {
    project_meta_conn(conn, project_id)?;
    let now = now_secs();
    let id = db::local_id();
    manuscript_repo::documents_insert(conn, &id, project_id, "draft", "初稿", now, now)?;
    manuscript_repo::touch_project(conn, project_id, now)?;
    Ok(manuscript_repo::DocumentRow {
        id,
        project_id: project_id.to_string(),
        kind: "draft".to_string(),
        title: "初稿".to_string(),
        source_path: String::new(),
        created_at: now,
        updated_at: now,
    })
}

/// 新建文档：校验项目/标题、建目录、按传入顺序插入空章节行。
///
/// 命令与 agent 工具（academic_manuscript create_document）共用这一实现。
pub(crate) fn create_document(
    conn: &Connection,
    data_dir: &Path,
    project_id: &str,
    kind: &str,
    title: &str,
    sections: &[String],
) -> Result<ManuscriptDocument, String> {
    project_meta_conn(conn, project_id)?;
    let kind = kind.trim();
    let kind = if kind.is_empty() { "draft" } else { kind };
    let title = title.trim();
    let title = if title.is_empty() {
        "未命名文档"
    } else {
        title
    };
    let now = now_secs();
    let id = db::local_id();
    manuscript_repo::documents_insert(conn, &id, project_id, kind, title, now, now)?;

    let dir = document_dir(data_dir, project_id, &id);
    std::fs::create_dir_all(&dir)
        .map_err(|err| format!("创建写作文档目录失败（{}）：{err}", dir.display()))?;

    let mut created: Vec<String> = Vec::new();
    for (index, section) in sections.iter().enumerate() {
        let section = section.trim();
        if section.is_empty() || created.iter().any(|existing| existing == section) {
            continue;
        }
        created.push(section.to_string());
        let section_id = db::local_id();
        manuscript_repo::insert(
            conn,
            &section_id,
            project_id,
            &id,
            section,
            index as i64,
            0,
            "draft",
            now,
        )?;
    }
    manuscript_repo::touch_project(conn, project_id, now)?;

    Ok(ManuscriptDocument {
        id,
        kind: kind.to_string(),
        title: title.to_string(),
        section_count: created.len() as i64,
        words: 0,
        updated_at: now,
        source_path: String::new(),
    })
}

/// 记录导入文档的原始文件路径（项目根内相对路径；空串=清除）。
pub(crate) fn set_document_source(
    conn: &Connection,
    project_id: &str,
    document_id: &str,
    source_path: &str,
) -> Result<(), String> {
    document_or_err(conn, project_id, document_id)?;
    let now = now_secs();
    manuscript_repo::documents_set_source(conn, project_id, document_id, source_path, now)?;
    manuscript_repo::touch_project(conn, project_id, now)?;
    Ok(())
}

fn update_document_conn(
    conn: &Connection,
    project_id: &str,
    document_id: &str,
    title: &str,
) -> Result<ManuscriptDocument, String> {
    document_or_err(conn, project_id, document_id)?;
    let title = title.trim();
    if title.is_empty() {
        return Err("文档标题不能为空".to_string());
    }
    let now = now_secs();
    manuscript_repo::documents_update_title(conn, project_id, document_id, title, now)?;
    manuscript_repo::touch_project(conn, project_id, now)?;
    let summary = manuscript_repo::documents_list(conn, project_id)?
        .into_iter()
        .find(|row| row.id == document_id)
        .ok_or_else(|| format!("写作文档不存在：{document_id}"))?;
    Ok(into_document(summary))
}

fn delete_document_conn(
    conn: &mut Connection,
    project_id: &str,
    document_id: &str,
) -> Result<(), String> {
    document_or_err(conn, project_id, document_id)?;
    let removed = manuscript_repo::documents_delete(conn, project_id, document_id)?;
    if removed == 0 {
        return Err(format!("写作文档不存在：{document_id}"));
    }
    let now = now_secs();
    manuscript_repo::touch_project(conn, project_id, now)?;
    Ok(())
}

fn list_sections_conn(
    conn: &Connection,
    project_id: &str,
    document_id: &str,
) -> Result<Vec<ManuscriptSection>, String> {
    let rows = manuscript_repo::list(conn, project_id, document_id)?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let content = if row.path.is_empty() {
                String::new()
            } else {
                std::fs::read_to_string(&row.path).unwrap_or_default()
            };
            into_section(row, content)
        })
        .collect())
}

/// Agent / 工具层：列出文档章节（含正文）。
pub(crate) fn sections(
    conn: &Connection,
    project_id: &str,
    document_id: &str,
) -> Result<Vec<ManuscriptSection>, String> {
    project_meta_conn(conn, project_id)?;
    document_or_err(conn, project_id, document_id)?;
    list_sections_conn(conn, project_id, document_id)
}

/// Agent / 工具层：写入/更新一个章节（正文落盘 + 更新 DB）。
pub(crate) fn save_section(
    conn: &Connection,
    data_dir: &Path,
    project_id: &str,
    document_id: &str,
    section: &str,
    content: &str,
) -> Result<ManuscriptSection, String> {
    let section = section.trim().to_string();
    if section.is_empty() {
        return Err("章节名称不能为空".to_string());
    }
    project_meta_conn(conn, project_id)?;
    document_or_err(conn, project_id, document_id)?;
    let now = now_secs();
    let words = content.chars().count() as i64;
    let id = match manuscript_repo::find(conn, project_id, document_id, &section)? {
        Some(row) => {
            manuscript_repo::update_body(conn, project_id, document_id, &section, words, now)?;
            row.id
        }
        None => {
            let id = db::local_id();
            manuscript_repo::insert(
                conn,
                &id,
                project_id,
                document_id,
                &section,
                section_ord(&section),
                words,
                "draft",
                now,
            )?;
            id
        }
    };
    let dir = document_dir(data_dir, project_id, document_id);
    let _ = std::fs::create_dir_all(&dir);
    let file = dir.join(format!("{}.md", safe_name(&section)));
    std::fs::write(&file, content.as_bytes()).ok();
    let content_path = file.to_string_lossy().to_string();
    manuscript_repo::set_path(conn, &id, &content_path)?;
    manuscript_repo::documents_touch(conn, project_id, document_id, now)?;
    manuscript_repo::touch_project(conn, project_id, now)?;
    let row = manuscript_repo::find_by_id(conn, &id)?
        .ok_or_else(|| format!("保存章节后读取失败：{id}"))?;
    Ok(into_section(row, content.to_string()))
}

// ---------------------------------------------------------------------------
// Tauri 命令：文档管理
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn manuscript_documents_list(
    db: State<'_, Db>,
    project_id: String,
) -> Result<Vec<ManuscriptDocument>, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    project_meta_conn(&conn, &project_id)?;
    document_list(&conn, &project_id)
}

#[tauri::command]
pub fn manuscript_document_create(
    db: State<'_, Db>,
    project_id: String,
    kind: String,
    title: String,
    sections: Vec<String>,
) -> Result<ManuscriptDocument, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    // 锁顺序：先 conn 后 data_dir（项目约定，避免死锁）。
    let data_dir = db
        .data_dir
        .lock()
        .map_err(|err| format!("failed to acquire data dir lock: {err}"))?
        .clone();
    create_document(
        &conn,
        Path::new(&data_dir),
        &project_id,
        &kind,
        &title,
        &sections,
    )
}

#[tauri::command]
pub fn manuscript_document_update(
    db: State<'_, Db>,
    project_id: String,
    document_id: String,
    title: String,
) -> Result<ManuscriptDocument, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    update_document_conn(&conn, &project_id, &document_id, &title)
}

#[tauri::command]
pub fn manuscript_document_delete(
    db: State<'_, Db>,
    project_id: String,
    document_id: String,
) -> Result<(), String> {
    let mut conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    delete_document_conn(&mut conn, &project_id, &document_id)
}

// ---------------------------------------------------------------------------
// Tauri 命令：章节
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn manuscript_list(
    db: State<'_, Db>,
    project_id: String,
    document_id: String,
) -> Result<Vec<ManuscriptSection>, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    sections(&conn, &project_id, &document_id)
}

#[tauri::command]
pub fn manuscript_save(
    db: State<'_, Db>,
    project_id: String,
    document_id: String,
    section: String,
    content: String,
) -> Result<ManuscriptSection, String> {
    let section = section.trim().to_string();
    if section.is_empty() {
        return Err("章节名称不能为空".to_string());
    }
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    // 锁顺序：先 conn 后 data_dir（项目约定，避免死锁）。
    let data_dir = db
        .data_dir
        .lock()
        .map_err(|err| format!("failed to acquire data dir lock: {err}"))?
        .clone();
    save_section(
        &conn,
        Path::new(&data_dir),
        &project_id,
        &document_id,
        &section,
        &content,
    )
}

#[tauri::command]
pub fn manuscript_delete(
    db: State<'_, Db>,
    project_id: String,
    document_id: String,
    section: String,
) -> Result<(), String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    document_or_err(&conn, &project_id, &document_id)?;
    manuscript_repo::delete(&conn, &project_id, &document_id, &section)?;
    Ok(())
}

fn safe_name(text: &str) -> String {
    let mut out = String::new();
    for ch in text.chars() {
        if ch.is_alphanumeric() || ch == '-' || ch == '_' || ch == ' ' {
            out.push(ch);
        } else {
            out.push('-');
        }
    }
    let trimmed = out.trim().trim_matches('-').to_string();
    if trimmed.is_empty() {
        "section".to_string()
    } else {
        trimmed
    }
}

/// Dev: CARGO_MANIFEST_DIR/scripts; packaged: resources/scripts.
fn script_path() -> PathBuf {
    let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("scripts")
        .join("build_docx.py");
    if dev.exists() {
        return dev;
    }
    Path::new("scripts").join("build_docx.py").to_path_buf()
}

/// 组装 DOCX 导出的 payload（文档标题/项目元信息/章节正文/参考文献），
/// 返回 (payload, 章节数, 字数)。标题取文档 title（区别于项目 title）。
pub(crate) fn build_docx_payload(
    conn: &Connection,
    project_id: &str,
    document_id: &str,
) -> Result<(serde_json::Value, i64, i64), String> {
    let document = document_or_err(conn, project_id, document_id)?;
    let meta = project_meta_conn(conn, project_id)?;
    // repository 已按 ord ASC, updated_at ASC 排序（与原实现一致）。
    let sections = manuscript_repo::list(conn, project_id, document_id)?;
    let mut section_payload: Vec<serde_json::Value> = Vec::new();
    let mut words: i64 = 0;
    for section in &sections {
        let body = if section.path.is_empty() {
            String::new()
        } else {
            std::fs::read_to_string(&section.path).unwrap_or_default()
        };
        words += body.chars().count() as i64;
        section_payload.push(serde_json::json!({
            "heading": section.section,
            "body": body,
        }));
    }
    let sections_count = section_payload.len() as i64;
    let references: Vec<serde_json::Value> =
        crate::repositories::literature::references_for_export(conn, project_id)?
            .into_iter()
            .map(|reference| {
                serde_json::json!({
                    "title": reference.title,
                    "authors": reference.authors_json,
                    "year": reference.year,
                    "venue": reference.venue,
                    "doi": reference.doi,
                })
            })
            .collect();
    let payload = serde_json::json!({
        "title": document.title,
        "paperKind": meta.paper_kind,
        "venue": meta.target_venue,
        "sections": section_payload,
        "references": references,
    });
    Ok((payload, sections_count, words))
}

/// payload 里的论文标题（导出文件名用）。
pub(crate) fn payload_title(payload: &serde_json::Value) -> &str {
    payload
        .get("title")
        .and_then(|value| value.as_str())
        .unwrap_or("manuscript")
}

/// DOCX 导出路径：exports/research/<安全标题>-<时间戳>.docx。
pub(crate) fn docx_export_path(data_dir: &Path, title: &str) -> Result<PathBuf, String> {
    let exports = data_dir.join("exports").join("research");
    std::fs::create_dir_all(&exports)
        .map_err(|err| format!("failed to create exports dir: {err}"))?;
    Ok(exports.join(format!("{}-{}.docx", safe_name(title), chrono_like_stamp())))
}

/// 调 bundled Python（python-docx）把 payload 渲染成 .docx。
///
/// 阻塞调用（子进程），命令/工具层要放进 spawn_blocking 或先释放 DB 锁。
pub(crate) fn render_docx(
    data_dir: &Path,
    payload: &serde_json::Value,
    out_path: &Path,
) -> Result<(), String> {
    let script = script_path();
    if !script.is_file() {
        return Err(format!("导出脚本缺失：{}", script.display()));
    }
    let direction = String::from_utf8(
        serde_json::to_vec(payload).map_err(|err| format!("failed to encode manuscript: {err}"))?,
    )
    .map_err(|err| format!("failed to encode manuscript: {err}"))?;
    let exe =
        crate::infra::python_runtime::ensure_doc_extract_python(data_dir, false, true, false)?;
    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let mut command = std::process::Command::new(&exe);
        command.creation_flags(0x0800_0000);
        command
    };
    #[cfg(not(windows))]
    let mut cmd = std::process::Command::new(&exe);
    let mut child = cmd
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .arg(&script)
        .arg(out_path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|err| format!("无法启动导出脚本：{err}"))?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(direction.as_bytes())
            .map_err(|err| format!("写入导出数据失败：{err}"))?;
    }
    let result = child
        .wait_with_output()
        .map_err(|err| format!("等待导出脚本失败：{err}"))?;
    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr);
        return Err(format!("DOCX 导出失败：{}", stderr.trim()));
    }
    Ok(())
}

/// 把导出文件登记为写作产物（best effort：导出已生成，登记失败不回滚）。
pub(crate) fn register_export_artifact(conn: &Connection, project_id: &str, out_path: &Path) {
    let now = now_secs();
    let artifact_title = out_path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "manuscript.docx".to_string());
    let _ = manuscript_repo::insert_export_artifact(
        conn,
        project_id,
        &artifact_title,
        &out_path.to_string_lossy(),
        now,
    );
    let _ = manuscript_repo::touch_project(conn, project_id, now);
}

#[tauri::command]
pub async fn export_docx(
    db: State<'_, Db>,
    project_id: String,
    document_id: String,
) -> Result<DocxExport, String> {
    let ((payload, sections_count, words), data_dir) = {
        let conn = db
            .conn
            .lock()
            .map_err(|err| format!("failed to acquire database lock: {err}"))?;
        let payload = build_docx_payload(&conn, &project_id, &document_id)?;
        let data_dir = db
            .data_dir
            .lock()
            .map_err(|err| format!("failed to acquire data dir lock: {err}"))?
            .clone();
        (payload, data_dir)
    };

    let out_path = docx_export_path(Path::new(&data_dir), payload_title(&payload))?;
    let data_dir_for_render = data_dir.clone();
    let payload_for_render = payload.clone();
    let out_for_render = out_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        render_docx(
            Path::new(&data_dir_for_render),
            &payload_for_render,
            &out_for_render,
        )
    })
    .await
    .map_err(|err| format!("导出任务执行失败：{err}"))??;

    // Register the export as an artifact (best effort — export already exists).
    if let Ok(conn) = db.conn.lock() {
        register_export_artifact(&conn, &project_id, &out_path);
    }

    Ok(DocxExport {
        path: out_path.to_string_lossy().to_string(),
        sections: sections_count,
        words,
    })
}

/// 导出文档 LaTeX 稿件（.tex + 可选 references.bib），纯 Rust 生成，无需 TeX 工具链。
#[tauri::command]
pub fn export_latex(
    db: State<'_, Db>,
    project_id: String,
    document_id: String,
) -> Result<crate::workspace::manuscript_latex::LatexExport, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    let data_dir = db
        .data_dir
        .lock()
        .map_err(|err| format!("failed to acquire data dir lock: {err}"))?
        .clone();
    crate::workspace::manuscript_latex::export_latex(
        &conn,
        Path::new(&data_dir),
        &project_id,
        &document_id,
    )
}

fn chrono_like_stamp() -> String {
    let secs = now_secs();
    let days = secs / 86_400;
    let (year, month, day) = civil_from_days(days);
    let rem = secs % 86_400;
    format!(
        "{year:04}{month:02}{day:02}-{:02}{:02}",
        rem / 3600,
        (rem % 3600) / 60
    )
}

/// Howard Hinnant's civil_from_days — avoids pulling in chrono for a filename.
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repositories::manuscript::open_test_connection;

    fn seed() -> (Connection, PathBuf, String) {
        let conn = open_test_connection();
        let dir = std::env::temp_dir().join(format!("mb-manuscript-test-{}", db::local_id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let project_id = "project-1".to_string();
        crate::repositories::manuscript::insert_project_for_test(
            &conn,
            &project_id,
            "测试项目",
            "writing",
            1_000,
        )
        .expect("insert project");
        (conn, dir, project_id)
    }

    #[test]
    fn documents_isolate_sections_and_save_updates_stats() {
        let (conn, dir, project_id) = seed();
        let draft = create_document(
            &conn,
            &dir,
            &project_id,
            "draft",
            "初稿",
            &["摘要".to_string(), "1 引言".to_string()],
        )
        .expect("create draft");
        assert_eq!(draft.section_count, 2);

        let saved = save_section(&conn, &dir, &project_id, &draft.id, "摘要", "摘要正文")
            .expect("save abstract");
        assert_eq!(saved.words, "摘要正文".chars().count() as i64);

        let letter = create_document(
            &conn,
            &dir,
            &project_id,
            "cover_letter",
            "投稿信",
            &["投稿信正文".to_string()],
        )
        .expect("create letter");
        assert_eq!(
            sections(&conn, &project_id, &draft.id)
                .expect("draft sections")
                .len(),
            2
        );
        assert_eq!(
            sections(&conn, &project_id, &letter.id)
                .expect("letter sections")
                .len(),
            1
        );

        // 文档列表统计（字数来自章节行）。
        let documents = document_list(&conn, &project_id).expect("documents");
        let draft_row = documents
            .iter()
            .find(|document| document.id == draft.id)
            .expect("draft row");
        assert_eq!(draft_row.section_count, 2);
        assert_eq!(draft_row.words, "摘要正文".chars().count() as i64);

        // 保存后的正文可从文件读回。
        let listed = sections(&conn, &project_id, &draft.id).expect("sections");
        let abstract_section = listed
            .iter()
            .find(|section| section.section == "摘要")
            .expect("abstract section");
        assert_eq!(abstract_section.content, "摘要正文");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn document_source_path_defaults_empty_and_roundtrips() {
        let (conn, dir, project_id) = seed();
        let document = create_document(
            &conn,
            &dir,
            &project_id,
            "draft",
            "导入论文",
            &["正文".to_string()],
        )
        .expect("create document");
        let listed = document_list(&conn, &project_id).expect("documents");
        assert_eq!(listed[0].source_path, "", "新文档 sourcePath 默认空串");

        set_document_source(&conn, &project_id, &document.id, "imported/论文.docx")
            .expect("set source");
        let listed = document_list(&conn, &project_id).expect("documents");
        assert_eq!(listed[0].source_path, "imported/论文.docx");

        assert!(
            set_document_source(&conn, &project_id, "missing-doc", "imported/x.docx").is_err()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn default_document_is_created_on_demand_and_resolved_as_latest() {
        let (conn, dir, project_id) = seed();
        assert!(document_list(&conn, &project_id)
            .expect("empty docs")
            .is_empty());
        let document = resolve_document(&conn, &project_id, None).expect("auto create");
        assert_eq!(document.kind, "draft");
        assert_eq!(document.title, "初稿");
        // 第二次解析复用同一文档（不再重复创建）。
        let again = resolve_document(&conn, &project_id, None).expect("resolve again");
        assert_eq!(again.id, document.id);
        assert_eq!(document_list(&conn, &project_id).expect("docs").len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn document_rename_and_delete_cascade_round_trip() {
        let (mut conn, dir, project_id) = seed();
        let document = create_document(
            &conn,
            &dir,
            &project_id,
            "proposal",
            "开题报告",
            &["研究背景与意义".to_string()],
        )
        .expect("create");
        let renamed = update_document_conn(&conn, &project_id, &document.id, "开题报告（终版）")
            .expect("rename");
        assert_eq!(renamed.title, "开题报告（终版）");
        assert_eq!(renamed.section_count, 1);

        delete_document_conn(&mut conn, &project_id, &document.id).expect("delete");
        assert!(document_list(&conn, &project_id).expect("docs").is_empty());
        let err = sections(&conn, &project_id, &document.id)
            .expect_err("deleted document must not be readable");
        assert!(err.contains("写作文档不存在"), "unexpected: {err}");

        let err = update_document_conn(&conn, &project_id, "no-such-doc", "标题")
            .expect_err("missing document must fail");
        assert!(err.contains("写作文档不存在"), "unexpected: {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
