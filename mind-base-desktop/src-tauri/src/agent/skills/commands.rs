//! Settings-UI commands: list / toggle / reveal / uninstall skills.

use rusqlite::params;
use tauri::{AppHandle, Manager};

use super::paths::{skills_dir, SAMPLE_DIR_NAME, SKILL_FILE};
use super::state::load_enabled_map;
use super::{scan_skills, SkillMeta};
use crate::infra::db::Db;

// ---------------------------------------------------------------------------
// Tauri commands (settings UI)
// ---------------------------------------------------------------------------

/// Snapshot every discovered skill with its persisted enabled flag.
#[tauri::command]
pub fn skills_list(app: AppHandle) -> Result<Vec<SkillMeta>, String> {
    let db = app.state::<Db>();
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    let enabled_map = load_enabled_map(&conn)?;
    let dir = db
        .data_dir
        .lock()
        .map_err(|err| format!("failed to acquire data dir lock: {err}"))?;
    Ok(scan_skills(&dir)
        .into_iter()
        .map(|(folder, parsed)| SkillMeta {
            enabled: enabled_map.get(&folder).copied().unwrap_or(true),
            name: parsed.name,
            description: parsed.description,
            folder,
        })
        .collect())
}

/// Persist one skill's enabled flag (upsert; unknown names allowed — the
/// flag simply applies once the folder reappears).
#[tauri::command]
pub fn skills_set_enabled(app: AppHandle, name: String, enabled: bool) -> Result<(), String> {
    let db = app.state::<Db>();
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    conn.execute(
        "INSERT INTO skill_settings(name, enabled) VALUES(?1, ?2)
         ON CONFLICT(name) DO UPDATE SET enabled = excluded.enabled",
        params![name, i64::from(enabled)],
    )
    .map_err(|err| format!("failed to save skill setting: {err}"))?;
    Ok(())
}

/// Create the skills dir (with a sample skill when empty) and reveal it in
/// the OS file manager so the user can drop SKILL.md packs in.
#[tauri::command]
pub fn skills_open_dir(app: AppHandle) -> Result<String, String> {
    let db = app.state::<Db>();
    let dir = {
        let guard = db
            .data_dir
            .lock()
            .map_err(|err| format!("failed to acquire data dir lock: {err}"))?;
        guard.clone()
    };
    let skills = skills_dir(&dir);
    std::fs::create_dir_all(&skills)
        .map_err(|err| format!("failed to create skills dir: {err}"))?;
    let sample = skills.join(SAMPLE_DIR_NAME);
    if !sample.exists() {
        std::fs::create_dir_all(&sample)
            .map_err(|err| format!("failed to create sample skill dir: {err}"))?;
        std::fs::write(
            sample.join(SKILL_FILE),
            r#"---
name: example-note-taking
description: 示例技能——按固定结构整理笔记。可参考本文件编写你自己的技能。
---

# 笔记整理技能（示例）

当用户要求「整理笔记」时，按以下结构输出：

1. **一句话摘要**：整篇笔记的核心结论
2. **要点清单**：每条一行，保留数字与专有名词
3. **待办**：笔记中提到但未完成的事项

## 约束

- 只依据笔记原文，不引入外部知识
- 输出为合法 Markdown
"#,
        )
        .map_err(|err| format!("failed to write sample skill: {err}"))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&skills)
            .spawn()
            .map_err(|err| format!("failed to open skills dir: {err}"))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = &skills;
        eprintln!("[SKILLS] open dir not implemented for this platform");
    }
    Ok(skills.to_string_lossy().to_string())
}

/// Uninstall one skill: delete its folder and drop the persisted flag.
#[tauri::command]
pub fn skills_uninstall(app: AppHandle, folder: String) -> Result<(), String> {
    if !folder
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        || folder.starts_with('.')
    {
        return Err(format!("非法的技能目录名：{folder:?}"));
    }
    let db = app.state::<Db>();
    let target = {
        let dir = db
            .data_dir
            .lock()
            .map_err(|err| format!("failed to acquire data dir lock: {err}"))?;
        skills_dir(&dir).join(&folder)
    };
    if !target.is_dir() {
        return Err("技能不存在或已被删除".to_string());
    }
    std::fs::remove_dir_all(&target).map_err(|err| format!("删除技能文件夹失败：{err}"))?;
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("failed to acquire database lock: {err}"))?;
    conn.execute(
        "DELETE FROM skill_settings WHERE name = ?1",
        params![folder],
    )
    .map_err(|err| format!("failed to clean skill setting: {err}"))?;
    Ok(())
}
