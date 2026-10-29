//! 我的模板：把当前导图存成可复用骨架。每个模板一个 JSON 文件存
//! `<数据目录>/mindmap-templates/`，与图形包同一套文件存储模式。

use tauri::AppHandle;

use crate::infra::db::Db;

use super::{normalize_title, MindMapTemplate};

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
            key: crate::infra::db::local_id(),
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
