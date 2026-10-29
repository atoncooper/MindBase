//! 图形包（右侧图形库的自定义分组：用户从网上下载的 SVG/PNG 图标集）

use tauri::AppHandle;

use crate::infra::db::Db;

use super::{normalize_title, MindMapIconPack, MindMapIconPackItem};

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
            key: crate::infra::db::local_id(),
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
