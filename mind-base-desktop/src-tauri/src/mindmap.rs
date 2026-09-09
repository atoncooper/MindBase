//! 知识导图（mind maps）— 手绘思维导图的本地持久层。
//!
//! 每张导图是一行 SQLite：标题 + 整棵树的 JSON 文档（simple-mind-map
//! `getData(true)` 的输出：root / layout / theme / view）。桌面单用户，
//! 保存一律整卡覆盖，不做修订历史。导出的 PNG / SVG / MD 落到共享的
//! `exports/` 目录，自动进入现有生成记录（exports_list）展示与打开。

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::db::Db;
use crate::resume::{export_file_name, exports_dir};

/// One mind map as listed in the library view.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MindMapMeta {
    pub id: String,
    pub title: String,
    /// Object kind: `mindmap`（simple-mind-map 树）或 `whiteboard`（Excalidraw 场景）。
    pub kind: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// One mind map in full (editor load).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MindMapDetail {
    pub id: String,
    pub title: String,
    /// Object kind: `mindmap` 或 `whiteboard`（编辑器据此分发渲染）。
    pub kind: String,
    /// Document JSON: 导图树（`{root, layout, theme, view}`）或白板场景
    /// （`{type: "excalidraw", version, elements, appState}`）；空串 = 尚未首次保存。
    pub data: String,
    pub created_at: i64,
    pub updated_at: i64,
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}

/// Normalize a user-supplied title: trim, fall back to a default, cap length.
fn normalize_title(title: &str) -> String {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return "未命名导图".to_string();
    }
    trimmed.chars().take(60).collect()
}

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
    let id = crate::db::local_id();
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

// ---------------------------------------------------------------------------
// 版本历史（快照）：自动定时 + 手动"存一版"，保留最近 30 版，回滚前当前
// 内容先自动存一版防丢。
// ---------------------------------------------------------------------------

/// 快照保留上限（超出时按时间淘汰最旧的）。
const SNAPSHOT_KEEP: usize = 30;

/// One snapshot as listed in the history panel (data body excluded).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MindMapSnapshotMeta {
    pub id: String,
    pub map_id: String,
    pub title: String,
    pub data_len: usize,
    pub created_at: i64,
}

/// 快照名缺省值：前端手动"存一版"会显式传名，None 视为自动快照。
const AUTO_SNAPSHOT_TITLE: &str = "自动快照";

/// Create one snapshot from the map's current content; prunes old ones.
#[tauri::command]
pub async fn mindmap_snapshot_create(
    app: AppHandle,
    map_id: String,
    title: Option<String>,
) -> Result<MindMapSnapshotMeta, String> {
    use tauri::Manager;

    let title = match title.as_deref().map(str::trim) {
        Some(trimmed) if !trimmed.is_empty() => trimmed.to_string(),
        _ => AUTO_SNAPSHOT_TITLE.to_string(),
    };
    let id = crate::db::local_id();
    let now = now_secs();
    let db = app.state::<Db>();
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    let (row_title, data): (String, String) = conn
        .query_row(
            "SELECT title, data FROM mind_maps WHERE id = ?1",
            rusqlite::params![map_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|err| format!("导图不存在或读取失败：{err}"))?;
    conn.execute(
        "INSERT INTO mind_map_snapshots(id, map_id, title, data, created_at)
         VALUES(?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![id, map_id, title, data, now],
    )
    .map_err(|err| format!("failed to create snapshot: {err}"))?;
    // 只保留最近 SNAPSHOT_KEEP 版。
    conn.execute(
        "DELETE FROM mind_map_snapshots WHERE map_id = ?1 AND id NOT IN (
             SELECT id FROM mind_map_snapshots WHERE map_id = ?1
             ORDER BY created_at DESC, rowid DESC LIMIT ?2
         )",
        rusqlite::params![map_id, SNAPSHOT_KEEP as i64],
    )
    .map_err(|err| format!("failed to prune snapshots: {err}"))?;
    Ok(MindMapSnapshotMeta {
        id,
        map_id,
        title: if title == AUTO_SNAPSHOT_TITLE {
            format!("{AUTO_SNAPSHOT_TITLE} · {row_title}")
        } else {
            title
        },
        data_len: data.len(),
        created_at: now,
    })
}

/// List snapshots of one map, newest first.
#[tauri::command]
pub async fn mindmap_snapshot_list(
    app: AppHandle,
    map_id: String,
) -> Result<Vec<MindMapSnapshotMeta>, String> {
    use tauri::Manager;

    let db = app.state::<Db>();
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    let mut statement = conn
        .prepare(
            "SELECT id, map_id, title, length(data), created_at
             FROM mind_map_snapshots WHERE map_id = ?1
             ORDER BY created_at DESC, rowid DESC",
        )
        .map_err(|err| format!("failed to list snapshots: {err}"))?;
    let rows = statement
        .query_map(rusqlite::params![map_id], |row| {
            Ok(MindMapSnapshotMeta {
                id: row.get(0)?,
                map_id: row.get(1)?,
                title: row.get(2)?,
                data_len: row.get::<_, i64>(3).unwrap_or(0).max(0) as usize,
                created_at: row.get(4)?,
            })
        })
        .map_err(|err| format!("failed to list snapshots: {err}"))?;
    let mut snapshots = Vec::new();
    for row in rows {
        snapshots.push(row.map_err(|err| format!("failed to read snapshot: {err}"))?);
    }
    Ok(snapshots)
}

/// Restore one snapshot: the map's CURRENT content is snapshotted first
/// ("回滚备份"), then the snapshot's title + data overwrite the map row.
/// Returns the new updated_at.
#[tauri::command]
pub async fn mindmap_snapshot_restore(
    app: AppHandle,
    snapshot_id: String,
) -> Result<i64, String> {
    use tauri::Manager;

    let db = app.state::<Db>();
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    let (map_id, snap_title, snap_data, snap_created): (String, String, String, i64) = conn
        .query_row(
            "SELECT map_id, title, data, created_at FROM mind_map_snapshots WHERE id = ?1",
            rusqlite::params![snapshot_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|err| format!("快照不存在或读取失败：{err}"))?;
    // 回滚前把当前内容存一版，防止误恢复后无处可退。
    let (cur_title, cur_data): (String, String) = conn
        .query_row(
            "SELECT title, data FROM mind_maps WHERE id = ?1",
            rusqlite::params![map_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|err| format!("导图不存在或读取失败：{err}"))?;
    let now = now_secs();
    conn.execute(
        "INSERT INTO mind_map_snapshots(id, map_id, title, data, created_at)
         VALUES(?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![
            crate::db::local_id(),
            map_id,
            format!("回滚备份 · {cur_title}"),
            cur_data,
            now
        ],
    )
    .map_err(|err| format!("failed to back up before restore: {err}"))?;
    conn.execute(
        "UPDATE mind_maps SET title = ?2, data = ?3, updated_at = ?4 WHERE id = ?1",
        rusqlite::params![map_id, snap_title, snap_data, now],
    )
    .map_err(|err| format!("failed to restore snapshot: {err}"))?;
    let _ = snap_created;
    Ok(now)
}

// ---------------------------------------------------------------------------
// 我的模板：把当前导图存成可复用骨架。每个模板一个 JSON 文件存
// `<数据目录>/mindmap-templates/`，与图形包同一套文件存储模式。
// ---------------------------------------------------------------------------

/// 一个用户模板（data 为整卡导图 JSON）。
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MindMapTemplate {
    pub key: String,
    pub name: String,
    pub data: String,
}

fn templates_dir(data_dir: &std::path::Path) -> std::path::PathBuf {
    data_dir.join("mindmap-templates")
}

/// Save one user template; returns the stored record.
#[tauri::command]
pub async fn mindmap_template_save(
    app: AppHandle,
    name: String,
    data: String,
) -> Result<MindMapTemplate, String> {
    use tauri::Manager;

    if data.is_empty() {
        return Err("模板内容为空".to_string());
    }
    if data.len() > 30 * 1024 * 1024 {
        return Err("模板过大，已拒绝保存".to_string());
    }
    let name = normalize_title(&name);
    let dir = templates_dir(&{
        let db = app.state::<Db>();
        let guard = db
            .data_dir
            .lock()
            .map_err(|err| format!("failed to acquire database lock: {err}"))?;
        guard.clone()
    });
    let template = tauri::async_runtime::spawn_blocking(move || -> Result<MindMapTemplate, String> {
        std::fs::create_dir_all(&dir).map_err(|err| format!("创建模板目录失败：{err}"))?;
        let template = MindMapTemplate {
            key: crate::db::local_id(),
            name,
            data,
        };
        let payload =
            serde_json::to_vec(&template).map_err(|err| format!("序列化模板失败：{err}"))?;
        let path = dir.join(format!("{}.json", template.key));
        std::fs::write(&path, payload)
            .map_err(|err| format!("写入模板失败（{}）：{err}", path.display()))?;
        Ok(template)
    })
    .await
    .map_err(|err| format!("task failed: {err}"))??;
    Ok(template)
}

/// List user templates, load order = file name order.
#[tauri::command]
pub async fn mindmap_template_list(app: AppHandle) -> Result<Vec<MindMapTemplate>, String> {
    use tauri::Manager;

    let dir = templates_dir(&{
        let db = app.state::<Db>();
        let guard = db
            .data_dir
            .lock()
            .map_err(|err| format!("failed to acquire database lock: {err}"))?;
        guard.clone()
    });
    let templates = tauri::async_runtime::spawn_blocking(
        move || -> Result<Vec<MindMapTemplate>, String> {
            let mut templates = Vec::new();
            let Ok(read) = std::fs::read_dir(&dir) else {
                return Ok(templates);
            };
            let mut paths: Vec<_> = read
                .filter_map(|entry| entry.ok())
                .map(|entry| entry.path())
                .filter(|path| path.extension().map(|ext| ext == "json").unwrap_or(false))
                .collect();
            paths.sort();
            for path in paths {
                let Ok(content) = std::fs::read(&path) else {
                    continue;
                };
                if let Ok(template) = serde_json::from_slice::<MindMapTemplate>(&content) {
                    if !template.key.is_empty() {
                        templates.push(template);
                    }
                }
            }
            Ok(templates)
        },
    )
    .await
    .map_err(|err| format!("task failed: {err}"))??;
    Ok(templates)
}

/// Delete one user template by key.
#[tauri::command]
pub async fn mindmap_template_delete(app: AppHandle, key: String) -> Result<(), String> {
    use tauri::Manager;

    // key 是本地生成的 32-hex，杜绝路径拼接注入。
    if !key.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err("非法的模板标识".to_string());
    }
    let dir = templates_dir(&{
        let db = app.state::<Db>();
        let guard = db
            .data_dir
            .lock()
            .map_err(|err| format!("failed to acquire database lock: {err}"))?;
        guard.clone()
    });
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let path = dir.join(format!("{key}.json"));
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(format!("删除模板失败（{}）：{err}", path.display())),
        }
    })
    .await
    .map_err(|err| format!("task failed: {err}"))??;
    Ok(())
}

// ---------------------------------------------------------------------------
// 图形包（右侧图形库的自定义分组：用户从网上下载的 SVG/PNG 图标集）
// ---------------------------------------------------------------------------

/// One graphic inside a user icon pack (icon = svg 文本或 dataURL/URL)。
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MindMapIconPackItem {
    pub name: String,
    pub icon: String,
}

/// A persisted user icon pack.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MindMapIconPack {
    pub key: String,
    pub name: String,
    pub items: Vec<MindMapIconPackItem>,
}

fn icon_packs_dir(data_dir: &std::path::Path) -> std::path::PathBuf {
    data_dir.join("mindmap-icons")
}

/// Save a user icon pack (one JSON file per pack); returns the stored pack.
#[tauri::command]
pub async fn mindmap_icon_pack_save(
    app: AppHandle,
    name: String,
    items: Vec<MindMapIconPackItem>,
) -> Result<MindMapIconPack, String> {
    use tauri::Manager;

    if items.is_empty() {
        return Err("图形包没有内容".to_string());
    }
    let name = normalize_title(&name);
    let total: usize = items.iter().map(|item| item.icon.len()).sum();
    if total > 8 * 1024 * 1024 {
        return Err("图形包过大（上限 8MB），已拒绝保存".to_string());
    }

    let dir = icon_packs_dir(&{
        let db = app.state::<Db>();
        let guard = db
            .data_dir
            .lock()
            .map_err(|err| format!("failed to acquire database lock: {err}"))?;
        guard.clone()
    });
    let name_for_file = name;
    let pack = tauri::async_runtime::spawn_blocking(move || -> Result<MindMapIconPack, String> {
        std::fs::create_dir_all(&dir).map_err(|err| format!("创建图形包目录失败：{err}"))?;
        let pack = MindMapIconPack {
            key: crate::db::local_id(),
            name: name_for_file,
            items,
        };
        let payload =
            serde_json::to_vec(&pack).map_err(|err| format!("序列化图形包失败：{err}"))?;
        let path = dir.join(format!("{}.json", pack.key));
        std::fs::write(&path, payload)
            .map_err(|err| format!("写入图形包失败（{}）：{err}", path.display()))?;
        Ok(pack)
    })
    .await
    .map_err(|err| format!("task failed: {err}"))??;
    Ok(pack)
}

/// List all user icon packs, load order = file name order.
#[tauri::command]
pub async fn mindmap_icon_pack_list(app: AppHandle) -> Result<Vec<MindMapIconPack>, String> {
    use tauri::Manager;

    let dir = icon_packs_dir(&{
        let db = app.state::<Db>();
        let guard = db
            .data_dir
            .lock()
            .map_err(|err| format!("failed to acquire database lock: {err}"))?;
        guard.clone()
    });
    let packs = tauri::async_runtime::spawn_blocking(move || -> Vec<MindMapIconPack> {
        let mut packs = Vec::new();
        let Ok(read) = std::fs::read_dir(&dir) else {
            return packs;
        };
        let mut paths: Vec<_> = read
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| path.extension().map(|ext| ext == "json").unwrap_or(false))
            .collect();
        paths.sort();
        for path in paths {
            let Ok(content) = std::fs::read(&path) else {
                continue;
            };
            if let Ok(pack) = serde_json::from_slice::<MindMapIconPack>(&content) {
                if !pack.key.is_empty() {
                    packs.push(pack);
                }
            }
        }
        packs
    })
    .await
    .map_err(|err| format!("task failed: {err}"))?;
    Ok(packs)
}

/// Delete one user icon pack by key.
#[tauri::command]
pub async fn mindmap_icon_pack_delete(app: AppHandle, key: String) -> Result<(), String> {
    use tauri::Manager;

    // key 是本地生成的 32-hex，杜绝路径拼接注入。
    if !key.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err("非法的图形包标识".to_string());
    }
    let dir = icon_packs_dir(&{
        let db = app.state::<Db>();
        let guard = db
            .data_dir
            .lock()
            .map_err(|err| format!("failed to acquire database lock: {err}"))?;
        guard.clone()
    });
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let path = dir.join(format!("{key}.json"));
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(format!("删除图形包失败（{}）：{err}", path.display())),
        }
    })
    .await
    .map_err(|err| format!("task failed: {err}"))??;
    Ok(())
}
