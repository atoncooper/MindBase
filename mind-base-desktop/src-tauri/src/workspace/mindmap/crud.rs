//! Mind map CRUD commands plus PNG/SVG/PDF export into the shared exports dir.

use tauri::AppHandle;

use crate::infra::db::Db;
use crate::workspace::resume::{export_file_name, exports_dir};

use super::{now_secs, MindMapDetail, MindMapMeta};

/// Validate the object kind; empty/None falls back to `mindmap` so older
/// frontends keep working unchanged.
fn normalize_kind(kind: Option<&str>) -> Result<String, String> {
    let value = kind
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("mindmap");
    match value {
        "mindmap" | "whiteboard" => Ok(value.to_string()),
        other => Err(format!("未知的对象类型：{other}")),
    }
}

/// Create an empty map; the editor renders and fills it on first save.
#[tauri::command]
pub async fn mindmap_create(
    app: AppHandle,
    title: Option<String>,
    kind: Option<String>,
) -> Result<MindMapMeta, String> {
    use tauri::Manager;

    let kind = normalize_kind(kind.as_deref())?;
    let default_title = if kind == "whiteboard" {
        "未命名白板"
    } else {
        "未命名导图"
    };
    let id = crate::infra::db::local_id();
    let now = now_secs();
    let title = match title.as_deref().map(str::trim) {
        Some(trimmed) if !trimmed.is_empty() => trimmed.chars().take(60).collect(),
        _ => default_title.to_string(),
    };
    let db = app.state::<Db>();
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    conn.execute(
        "INSERT INTO mind_maps(id, title, kind, data, created_at, updated_at)
         VALUES(?1, ?2, ?3, '', ?4, ?4)",
        rusqlite::params![id, title, kind, now],
    )
    .map_err(|err| format!("failed to create mind map: {err}"))?;
    Ok(MindMapMeta {
        id,
        title,
        kind,
        created_at: now,
        updated_at: now,
    })
}

/// List maps, most recently updated first. `kind` filters by object type;
/// None/empty returns everything (older frontends).
#[tauri::command]
pub async fn mindmap_list(
    app: AppHandle,
    kind: Option<String>,
) -> Result<Vec<MindMapMeta>, String> {
    use tauri::Manager;

    let db = app.state::<Db>();
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    let kind = kind
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let mut statement = match kind.as_deref() {
        Some(_) => conn
            .prepare(
                "SELECT id, title, kind, created_at, updated_at
                 FROM mind_maps WHERE kind = ?1 ORDER BY updated_at DESC, rowid DESC",
            )
            .map_err(|err| format!("failed to list mind maps: {err}"))?,
        None => conn
            .prepare(
                "SELECT id, title, kind, created_at, updated_at
                 FROM mind_maps ORDER BY updated_at DESC, rowid DESC",
            )
            .map_err(|err| format!("failed to list mind maps: {err}"))?,
    };
    let map_row = |row: &rusqlite::Row| -> rusqlite::Result<MindMapMeta> {
        Ok(MindMapMeta {
            id: row.get(0)?,
            title: row.get(1)?,
            kind: row.get(2)?,
            created_at: row.get(3)?,
            updated_at: row.get(4)?,
        })
    };
    let rows = match kind.as_deref() {
        Some(kind) => statement.query_map(rusqlite::params![kind], map_row),
        None => statement.query_map([], map_row),
    }
    .map_err(|err| format!("failed to list mind maps: {err}"))?;
    let mut maps = Vec::new();
    for row in rows {
        maps.push(row.map_err(|err| format!("failed to read mind map: {err}"))?);
    }
    Ok(maps)
}

/// Load one map in full. Returns None when the id is unknown.
#[tauri::command]
pub async fn mindmap_get(app: AppHandle, id: String) -> Result<Option<MindMapDetail>, String> {
    use tauri::Manager;

    let db = app.state::<Db>();
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    let row = conn.query_row(
        "SELECT id, title, kind, data, created_at, updated_at FROM mind_maps WHERE id = ?1",
        rusqlite::params![id],
        |row| {
            Ok(MindMapDetail {
                id: row.get(0)?,
                title: row.get(1)?,
                kind: row.get(2)?,
                data: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        },
    );
    match row {
        Ok(detail) => Ok(Some(detail)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(err) => Err(format!("failed to load mind map: {err}")),
    }
}

/// Overwrite title + document (the editor's whole-map autosave); returns the
/// new updated_at.
#[tauri::command]
pub async fn mindmap_save(
    app: AppHandle,
    id: String,
    title: String,
    data: String,
) -> Result<i64, String> {
    use tauri::Manager;

    if data.len() > 30 * 1024 * 1024 {
        return Err("导图文档过大，已拒绝保存".to_string());
    }
    let now = now_secs();
    let db = app.state::<Db>();
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    // 空标题回退按对象类型取默认名（白板 ≠ 导图）。
    let trimmed = title.trim();
    let title = if trimmed.is_empty() {
        let kind: String = conn
            .query_row(
                "SELECT kind FROM mind_maps WHERE id = ?1",
                rusqlite::params![id],
                |row| row.get(0),
            )
            .unwrap_or_else(|_| "mindmap".to_string());
        if kind == "whiteboard" {
            "未命名白板".to_string()
        } else {
            "未命名导图".to_string()
        }
    } else {
        trimmed.chars().take(60).collect()
    };
    let affected = conn
        .execute(
            "UPDATE mind_maps SET title = ?2, data = ?3, updated_at = ?4 WHERE id = ?1",
            rusqlite::params![id, title, data, now],
        )
        .map_err(|err| format!("failed to save mind map: {err}"))?;
    if affected == 0 {
        return Err("导图不存在或已被删除".to_string());
    }
    Ok(now)
}

/// Rename without touching the document (library-view inline rename).
#[tauri::command]
pub async fn mindmap_rename(app: AppHandle, id: String, title: String) -> Result<(), String> {
    use tauri::Manager;

    let now = now_secs();
    let db = app.state::<Db>();
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    let trimmed = title.trim();
    let title = if trimmed.is_empty() {
        let kind: String = conn
            .query_row(
                "SELECT kind FROM mind_maps WHERE id = ?1",
                rusqlite::params![id],
                |row| row.get(0),
            )
            .unwrap_or_else(|_| "mindmap".to_string());
        if kind == "whiteboard" {
            "未命名白板".to_string()
        } else {
            "未命名导图".to_string()
        }
    } else {
        trimmed.chars().take(60).collect()
    };
    let affected = conn
        .execute(
            "UPDATE mind_maps SET title = ?2, updated_at = ?3 WHERE id = ?1",
            rusqlite::params![id, title, now],
        )
        .map_err(|err| format!("failed to rename mind map: {err}"))?;
    if affected == 0 {
        return Err("导图不存在或已被删除".to_string());
    }
    Ok(())
}

/// Delete one map and its document.
#[tauri::command]
pub async fn mindmap_delete(app: AppHandle, id: String) -> Result<(), String> {
    use tauri::Manager;

    let db = app.state::<Db>();
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    conn.execute("DELETE FROM mind_maps WHERE id = ?1", rusqlite::params![id])
        .map_err(|err| format!("failed to delete mind map: {err}"))?;
    Ok(())
}

/// Save one export artifact (PNG / SVG / PDF / MD / HTML) into the shared
/// exports dir so it shows up in the existing 生成记录 view. Content arrives
/// base64-encoded from the webview. Returns the absolute file path.
#[tauri::command]
pub async fn mindmap_export_save(
    app: AppHandle,
    stem: String,
    ext: String,
    content_base64: String,
) -> Result<String, String> {
    use base64::Engine as _;
    use tauri::Manager;

    let ext = ext.trim().to_lowercase();
    if !matches!(
        ext.as_str(),
        "png" | "jpg" | "svg" | "md" | "pdf" | "html" | "xmind"
    ) {
        return Err(format!("不支持的导出类型：{ext}"));
    }
    if content_base64.len() > 40 * 1024 * 1024 {
        return Err("导出内容过大，已拒绝保存".to_string());
    }
    let content = base64::engine::general_purpose::STANDARD
        .decode(content_base64.as_bytes())
        .map_err(|err| format!("导出内容解码失败：{err}"))?;
    if content.is_empty() {
        return Err("导出内容为空".to_string());
    }

    let dir = exports_dir(&{
        let db = app.state::<Db>();
        let guard = db
            .data_dir
            .lock()
            .map_err(|err| format!("failed to acquire database lock: {err}"))?;
        guard.clone()
    });
    let path = tauri::async_runtime::spawn_blocking(move || -> Result<std::path::PathBuf, String> {
        std::fs::create_dir_all(&dir).map_err(|err| format!("创建导出目录失败：{err}"))?;
        let path = dir.join(export_file_name(&stem, &ext));
        std::fs::write(&path, &content)
            .map_err(|err| format!("写入导出文件失败（{}）：{err}", path.display()))?;
        Ok(path)
    })
    .await
    .map_err(|err| format!("task failed: {err}"))??;
    Ok(path.display().to_string())
}
