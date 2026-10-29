//! Per-skill enabled state: SQLite flags, prompt digest, body loading.

use std::path::Path;

use rusqlite::Connection;

use super::scan_skills;

pub(super) fn load_enabled_map(conn: &Connection) -> Result<std::collections::HashMap<String, bool>, String> {
    let mut statement = conn
        .prepare("SELECT name, enabled FROM skill_settings")
        .map_err(|err| format!("failed to read skill settings: {err}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? != 0))
        })
        .map_err(|err| format!("failed to read skill settings: {err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("failed to read skill settings: {err}"))?;
    Ok(rows.into_iter().collect())
}

/// Name + description digest of every *enabled* skill, formatted for the
/// chat system prompt. Empty string when none — callers append nothing.
pub(crate) fn enabled_skills_digest(conn: &Connection, data_dir: &Path) -> String {
    let enabled_map = match load_enabled_map(conn) {
        Ok(map) => map,
        Err(err) => {
            eprintln!("[SKILLS] settings unavailable, assuming all enabled: {err}");
            std::collections::HashMap::new()
        }
    };
    let mut lines = Vec::new();
    for (folder, parsed) in scan_skills(data_dir) {
        let enabled = enabled_map.get(&folder).copied().unwrap_or(true);
        if !enabled {
            continue;
        }
        let desc = if parsed.description.is_empty() {
            "（无描述）"
        } else {
            &parsed.description
        };
        lines.push(format!("- `{}`：{}", parsed.name, desc));
    }
    if lines.is_empty() {
        return String::new();
    }
    format!(
        "以下技能可用。当用户请求与某个技能描述相关时，先用 load_skill 工具载入该技能的完整指令，再按指令执行：\n{}",
        lines.join("\n")
    )
}

/// Read one skill's full instruction body by name or folder. Name matching
/// accepts the frontmatter `name` or the folder name; path traversal is
/// structurally impossible (we scan, never join user input into a path).
pub(crate) fn read_skill_body(
    conn: &Connection,
    data_dir: &Path,
    name: &str,
) -> Result<String, String> {
    let enabled_map = load_enabled_map(conn)?;
    for (folder, parsed) in scan_skills(data_dir) {
        if parsed.name == name || folder == name {
            let enabled = enabled_map.get(&folder).copied().unwrap_or(true);
            if !enabled {
                return Err(format!("技能 `{name}` 已被禁用，请先在设置中启用"));
            }
            return Ok(format!("# 技能：{}\n\n{}", parsed.name, parsed.body));
        }
    }
    Err(format!("未找到技能 `{name}`；可用技能见系统提示中的清单"))
}
