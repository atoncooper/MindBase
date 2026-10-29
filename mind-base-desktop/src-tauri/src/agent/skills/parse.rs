//! SKILL.md parsing + directory scan (SKILL.md -> ParsedSkill).

use std::path::Path;

use serde::Serialize;

use super::paths::{find_skill_file, skills_dir, SKILL_FILE};

/// Cap per-skill body so a runaway file can't blow the model context.
const MAX_SKILL_CHARS: usize = 12_000;

/// Non-secret view of one discovered skill, safe for the UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillMeta {
    pub name: String,
    pub description: String,
    pub enabled: bool,
    /// Folder name on disk (the identity `load_skill` accepts).
    pub folder: String,
}

/// One parsed SKILL.md: metadata plus the instruction body.
pub(crate) struct ParsedSkill {
    pub name: String,
    pub description: String,
    pub body: String,
}

/// Parse a SKILL.md: optional `---\nkey: value\n---` frontmatter + Markdown
/// body. Frontmatter is OPTIONAL (backend parity: "manifest wins" packs ship
/// plain SKILL.md bodies) — a file without one is treated as all body, with
/// the name falling back to the folder. A leading UTF-8 BOM is tolerated
/// (common on Windows-authored files; BOM is not `char::is_whitespace`).
pub(crate) fn parse_skill(raw: &str, fallback_name: &str) -> Option<ParsedSkill> {
    let text = raw.trim_start();
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    if let Some(rest) = text.strip_prefix("---") {
        if let Some((front, body)) = rest.split_once("---") {
            let mut name = String::new();
            let mut description = String::new();
            for line in front.lines() {
                let Some((key, value)) = line.split_once(':') else {
                    continue;
                };
                match key.trim() {
                    "name" => name = value.trim().to_string(),
                    "description" => description = value.trim().to_string(),
                    _ => {}
                }
            }
            if name.is_empty() {
                name = fallback_name.to_string();
            }
            let body = body.trim();
            if body.is_empty() && description.is_empty() {
                return None;
            }
            return Some(ParsedSkill {
                name,
                description,
                body: clamp_chars(body, MAX_SKILL_CHARS),
            });
        }
    }
    // No frontmatter: the whole file is the instruction body.
    let body = text.trim();
    if body.is_empty() {
        return None;
    }
    Some(ParsedSkill {
        name: fallback_name.to_string(),
        description: String::new(),
        body: clamp_chars(body, MAX_SKILL_CHARS),
    })
}

fn clamp_chars(text: &str, cap: usize) -> String {
    if text.chars().count() <= cap {
        return text.to_string();
    }
    let cut: String = text.chars().take(cap).collect();
    format!("{cut}\n\n（内容过长，已截断）")
}

/// Scan every skill folder under the skills dir; missing dir = empty list
/// (scanning is read-only; creation happens on `skills_open_dir`).
pub(crate) fn scan_skills(data_dir: &Path) -> Vec<(String, ParsedSkill)> {
    let mut found = Vec::new();
    let Ok(entries) = std::fs::read_dir(skills_dir(data_dir)) else {
        return found;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(folder) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        // Root SKILL.md fast path; nested fallback for legacy layouts.
        let root_file = path.join(SKILL_FILE);
        let skill_file = if root_file.is_file() {
            root_file
        } else {
            match find_skill_file(&path) {
                Some(nested) => nested,
                None => {
                    eprintln!("[SKILLS] folder `{folder}` has no SKILL.md anywhere; skipped");
                    continue;
                }
            }
        };
        let Ok(raw) = std::fs::read_to_string(&skill_file) else {
            eprintln!(
                "[SKILLS] folder `{folder}`: {} is not valid UTF-8; skipped",
                skill_file.display()
            );
            continue;
        };
        if let Some(parsed) = parse_skill(&raw, folder) {
            found.push((folder.to_string(), parsed));
        } else {
            eprintln!("[SKILLS] folder `{folder}`: SKILL.md parsed empty; skipped");
        }
    }
    found.sort_by(|a, b| a.0.cmp(&b.0));
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 回归：无 frontmatter 的 SKILL.md（app/ zip 格式合法形态）必须能被发现，
    /// 否则出现「安装成功但列表不显示」。
    #[test]
    fn skill_md_without_frontmatter_is_discovered() {
        let parsed = parse_skill("# 我的技能\n\n按步骤执行。", "my-skill")
            .expect("plain body is a valid skill");
        assert_eq!(parsed.name, "my-skill", "name falls back to folder");
        assert_eq!(parsed.description, "");
        assert!(parsed.body.contains("按步骤执行"));
    }

    /// 回归：UTF-8 BOM 开头的 frontmatter（Windows 常见）不能被漏掉。
    #[test]
    fn skill_md_with_bom_is_parsed() {
        let raw = format!("\u{feff}---\nname: bom-skill\ndescription: 带BOM\n---\n\n正文");
        let parsed = parse_skill(&raw, "folder").expect("BOM must be tolerated");
        assert_eq!(parsed.name, "bom-skill");
        assert_eq!(parsed.description, "带BOM");
        assert!(parsed.body.contains("正文"));
    }

    /// 空文件仍应拒绝。
    #[test]
    fn empty_skill_md_is_rejected() {
        assert!(parse_skill("", "x").is_none());
        assert!(parse_skill("   \n  ", "x").is_none());
    }

    /// 回归：旧版本安装的嵌套布局（zipball 前缀未剥离）扫描时仍能发现——
    /// 向下递归找最短路径的 SKILL.md（对齐后端 _find_entry 语义）。
    #[test]
    fn scan_discovers_legacy_nested_layout() {
        let root = std::env::temp_dir().join(format!("mb-skills-test-scan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let skills_dir = root.join("skills");
        let nested = skills_dir
            .join("legacy-skill")
            .join("owner-repo-sha")
            .join("skills")
            .join("deep");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(
            nested.join("SKILL.md"),
            "---\nname: legacy\ndescription: 旧布局\n---\n\n正文内容",
        )
        .unwrap();
        // scan_skills 接收的是数据目录（内部自行 join "skills"）。
        let found = scan_skills(&root);
        assert_eq!(found.len(), 1, "nested legacy layout must be discovered");
        assert_eq!(found[0].0, "legacy-skill");
        assert_eq!(found[0].1.name, "legacy");
        assert!(found[0].1.body.contains("正文内容"));
        std::fs::remove_dir_all(&root).ok();
    }
}
