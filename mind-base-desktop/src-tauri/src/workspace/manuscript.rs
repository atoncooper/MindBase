//! Manuscript sections + DOCX export (Phase 1, journal line).
//!
//! Sections are stored in the Phase 0 `manuscript_sections` table. Export
//! renders them through the bundled Python pipeline (`scripts/build_docx.py`,
//! python-docx) so the desktop app ships a real Word deliverable without a
//! LaTeX toolchain.

use std::io::Write;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::State;

use crate::infra::db::{self, Db};

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

fn list_sections_conn(
    conn: &Connection,
    project_id: &str,
) -> Result<Vec<ManuscriptSection>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, section, ord, path, words, status, updated_at \
             FROM manuscript_sections WHERE project_id = ?1 ORDER BY ord ASC, updated_at ASC",
        )
        .map_err(|err| format!("failed to prepare manuscript list: {err}"))?;
    let rows = stmt
        .query_map(params![project_id], |row| {
            Ok(ManuscriptSection {
                id: row.get(0)?,
                section: row.get(1)?,
                ord: row.get(2)?,
                path: row.get(3)?,
                words: row.get(4)?,
                status: row.get(5)?,
                updated_at: row.get(6)?,
                content: String::new(),
            })
        })
        .map_err(|err| format!("failed to query manuscript sections: {err}"))?;
    let mut sections = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("failed to read manuscript sections: {err}"))?;
    for section in &mut sections {
        if !section.path.is_empty() {
            section.content = std::fs::read_to_string(&section.path).unwrap_or_default();
        }
    }
    Ok(sections)
}

fn project_meta_conn(
    conn: &Connection,
    project_id: &str,
) -> Result<(String, String, String), String> {
    conn.query_row(
        "SELECT title, paper_kind, target_venue FROM research_projects WHERE id = ?1",
        params![project_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )
    .optional()
    .map_err(|err| format!("failed to load research project: {err}"))?
    .ok_or_else(|| format!("研究项目不存在：{project_id}"))
}

#[tauri::command]
pub fn manuscript_list(
    db: State<'_, Db>,
    project_id: String,
) -> Result<Vec<ManuscriptSection>, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    project_meta_conn(&conn, &project_id)?;
    list_sections_conn(&conn, &project_id)
}

#[tauri::command]
pub fn manuscript_save(
    db: State<'_, Db>,
    project_id: String,
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
    project_meta_conn(&conn, &project_id)?;
    let now = now_secs();
    let words = content.chars().count() as i64;
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM manuscript_sections WHERE project_id = ?1 AND section = ?2",
            params![project_id, section],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| format!("failed to look up section: {err}"))?;

    let id = match existing {
        Some(id) => {
            conn.execute(
                "UPDATE manuscript_sections SET words = ?3, status = 'draft', updated_at = ?4 \
                 WHERE project_id = ?1 AND section = ?2",
                params![project_id, section, words, now],
            )
            .map_err(|err| format!("failed to update section: {err}"))?;
            id
        }
        None => {
            let id = db::local_id();
            conn.execute(
                "INSERT INTO manuscript_sections(id, project_id, section, ord, path, words, status, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, '', ?5, 'draft', ?6)",
                params![id, project_id, section, section_ord(&section), words, now],
            )
            .map_err(|err| format!("failed to insert section: {err}"))?;
            id
        }
    };

    // Content is stored beside the DB so it stays greppable/portable.
    let content_path = if let Ok(data_dir) = db.data_dir.lock() {
        let dir = PathBuf::from(&*data_dir)
            .join("research")
            .join(&project_id)
            .join("manuscript")
            .join("sections");
        let _ = std::fs::create_dir_all(&dir);
        let file = dir.join(format!("{}.md", safe_name(&section)));
        std::fs::write(&file, content.as_bytes()).ok();
        file.to_string_lossy().to_string()
    } else {
        String::new()
    };
    if !content_path.is_empty() {
        conn.execute(
            "UPDATE manuscript_sections SET path = ?2 WHERE id = ?1",
            params![id, content_path],
        )
        .map_err(|err| format!("failed to record section path: {err}"))?;
    }
    conn.execute(
        "UPDATE research_projects SET updated_at = ?2 WHERE id = ?1",
        params![project_id, now],
    )
    .map_err(|err| format!("failed to touch project: {err}"))?;
    let mut saved = conn
        .query_row(
            "SELECT id, section, ord, path, words, status, updated_at \
             FROM manuscript_sections WHERE id = ?1",
            params![id],
            |row| {
                Ok(ManuscriptSection {
                    id: row.get(0)?,
                    section: row.get(1)?,
                    ord: row.get(2)?,
                    path: row.get(3)?,
                    words: row.get(4)?,
                    status: row.get(5)?,
                    updated_at: row.get(6)?,
                    content: String::new(),
                })
            },
        )
        .map_err(|err| format!("failed to reload section: {err}"))?;
    saved.content = content;
    Ok(saved)
}

#[tauri::command]
pub fn manuscript_delete(
    db: State<'_, Db>,
    project_id: String,
    section: String,
) -> Result<(), String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    conn.execute(
        "DELETE FROM manuscript_sections WHERE project_id = ?1 AND section = ?2",
        params![project_id, section],
    )
    .map_err(|err| format!("failed to delete section: {err}"))?;
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

#[tauri::command]
pub async fn export_docx(db: State<'_, Db>, project_id: String) -> Result<DocxExport, String> {
    let (payload, data_dir) = {
        let conn = db
            .conn
            .lock()
            .map_err(|err| format!("failed to acquire database lock: {err}"))?;
        let (title, paper_kind, target_venue) = project_meta_conn(&conn, &project_id)?;
        let mut sections = list_sections_conn(&conn, &project_id)?;
        sections.sort_by_key(|section| section.ord);
        let mut section_payload: Vec<serde_json::Value> = Vec::new();
        for section in &sections {
            let body = if section.path.is_empty() {
                String::new()
            } else {
                std::fs::read_to_string(&section.path).unwrap_or_default()
            };
            section_payload.push(serde_json::json!({
                "heading": section.section,
                "body": body,
            }));
        }
        let mut stmt = conn
            .prepare(
                "SELECT title, authors_json, year, venue, doi FROM literature_refs \
                 WHERE project_id = ?1 ORDER BY created_at ASC",
            )
            .map_err(|err| format!("failed to prepare references: {err}"))?;
        let rows = stmt
            .query_map(params![project_id], |row| {
                Ok(serde_json::json!({
                    "title": row.get::<_, String>(0)?,
                    "authors": row.get::<_, String>(1)?,
                    "year": row.get::<_, Option<i64>>(2)?,
                    "venue": row.get::<_, String>(3)?,
                    "doi": row.get::<_, String>(4)?,
                }))
            })
            .map_err(|err| format!("failed to query references: {err}"))?;
        let references: Vec<serde_json::Value> = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| format!("failed to read references: {err}"))?;
        let payload = serde_json::json!({
            "title": title,
            "paperKind": paper_kind,
            "venue": target_venue,
            "sections": section_payload,
            "references": references,
        });
        let dir = db
            .data_dir
            .lock()
            .map_err(|err| format!("failed to acquire data dir lock: {err}"))?
            .clone();
        (payload, dir)
    };

    let sections_count = payload
        .get("sections")
        .and_then(|value| value.as_array())
        .map(|items| items.len() as i64)
        .unwrap_or(0);
    let words: i64 = payload
        .get("sections")
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    item.get("body")
                        .and_then(|body| body.as_str())
                        .map(|body| body.chars().count() as i64)
                        .unwrap_or(0)
                })
                .sum()
        })
        .unwrap_or(0);

    let out_path = {
        let exports = PathBuf::from(&data_dir).join("exports").join("research");
        std::fs::create_dir_all(&exports)
            .map_err(|err| format!("failed to create exports dir: {err}"))?;
        let stamp = chrono_like_stamp();
        let title = payload
            .get("title")
            .and_then(|value| value.as_str())
            .unwrap_or("manuscript");
        exports.join(format!("{}-{stamp}.docx", safe_name(title)))
    };
    let out_for_python = out_path.to_string_lossy().to_string();
    let script = script_path();
    if !script.is_file() {
        return Err(format!("导出脚本缺失：{}", script.display()));
    }
    let direction = String::from_utf8(
        serde_json::to_vec(&payload)
            .map_err(|err| format!("failed to encode manuscript: {err}"))?,
    )
    .map_err(|err| format!("failed to encode manuscript: {err}"))?;
    let dir_for_python = data_dir.clone();

    let joined = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let exe =
            crate::infra::python_runtime::ensure_doc_extract_python(&dir_for_python, false, true, false)?;
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
            .arg(&out_for_python)
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
    })
    .await
    .map_err(|err| format!("导出任务执行失败：{err}"))?;
    joined?;

    // Register the export as an artifact (best effort — export already exists).
    if let Ok(conn) = db.conn.lock() {
        let now = now_secs();
        let artifact_id = db::local_id();
        let _ = conn.execute(
            "INSERT INTO project_artifacts(id, project_id, stage, kind, title, path, version, sha256, status, meta_json, created_at) \
             VALUES (?1, ?2, 'writing', 'export', ?3, ?4, 1, '', 'confirmed', '{}', ?5)",
            params![
                artifact_id,
                project_id,
                out_path
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_else(|| "manuscript.docx".to_string()),
                out_path.to_string_lossy().to_string(),
                now
            ],
        );
        let _ = conn.execute(
            "UPDATE research_projects SET updated_at = ?2 WHERE id = ?1",
            params![project_id, now],
        );
    }

    Ok(DocxExport {
        path: out_path.to_string_lossy().to_string(),
        sections: sections_count,
        words,
    })
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
