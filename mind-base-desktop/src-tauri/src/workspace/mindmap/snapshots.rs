//! 版本历史（快照）：自动定时 + 手动"存一版"，保留最近 30 版，回滚前当前
//! 内容先自动存一版防丢。

use tauri::AppHandle;

use crate::infra::db::Db;

use super::{now_secs, MindMapSnapshotMeta};

/// 快照保留上限（超出时按时间淘汰最旧的）。
const SNAPSHOT_KEEP: usize = 30;

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
    let id = crate::infra::db::local_id();
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
            crate::infra::db::local_id(),
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
