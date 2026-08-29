//! Skills — local SKILL.md packs the chat agent can load on demand.
//!
//! Format mirrors Claude Code: `<data_dir>/skills/<name>/SKILL.md` with a
//! tiny YAML frontmatter (`name` / `description`) followed by Markdown
//! instructions. Discovery is directory-driven: drop a folder in, it shows
//! up on the next scan — no restart, no registration. Per-skill enabled
//! flags persist in SQLite `skill_settings` (default ON) and survive
//! renames of the folder only by name match.
//!
//! Progressive disclosure (same shape as the reference implementation):
//! the chat system prompt carries only the name+description digest; the
//! model pulls the full body through the `load_skill` tool when relevant.

use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::db::Db;

const SKILLS_DIR_NAME: &str = "skills";
const SKILL_FILE: &str = "SKILL.md";
const SAMPLE_DIR_NAME: &str = "example-note-taking";
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

/// Skills directory under the active data dir.
fn skills_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(SKILLS_DIR_NAME)
}

/// Locate the skill file of one installed folder: `<folder>/SKILL.md` first;
/// when absent (legacy installs of GitHub zipballs kept their inner prefix
/// dir, and multi-skill collection repos nest deeply), fall back to the
/// *shortest-path* SKILL.md anywhere inside — mirroring the backend's
/// `_find_entry` semantics. Bounded walk (dirs cap) so a hostile tree can't
/// spin the scan.
fn find_skill_file(folder_dir: &Path) -> Option<PathBuf> {
    const MAX_DIRS: usize = 500;
    let mut best: Option<PathBuf> = None;
    let mut stack = vec![folder_dir.to_path_buf()];
    let mut visited = 0usize;
    while let Some(current) = stack.pop() {
        visited += 1;
        if visited > MAX_DIRS {
            break;
        }
        let Ok(entries) = std::fs::read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.file_name().map(|n| n == SKILL_FILE).unwrap_or(false)
                && best
                    .as_ref()
                    .map_or(true, |best| path.components().count() < best.components().count())
            {
                best = Some(path);
            }
        }
    }
    best
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

fn load_enabled_map(conn: &Connection) -> Result<std::collections::HashMap<String, bool>, String> {
    let mut statement = conn
        .prepare("SELECT name, enabled FROM skill_settings")
        .map_err(|err| format!("failed to read skill settings: {err}"))?;
    let rows = statement
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? != 0)))
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
            return Ok(format!(
                "# 技能：{}\n\n{}",
                parsed.name, parsed.body
            ));
        }
    }
    Err(format!("未找到技能 `{name}`；可用技能见系统提示中的清单"))
}

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
    std::fs::create_dir_all(&skills).map_err(|err| format!("failed to create skills dir: {err}"))?;
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

// ---------------------------------------------------------------------------
// GitHub skill store — same protocol as app/skills/store/client.py: search
// repositories by query/topic, install by downloading the zipball (the repo
// is ONE skill pack). Direct connection first, then a fallback local proxy
// (GitHub is unreachable from some networks without it).
// ---------------------------------------------------------------------------

const GITHUB_API: &str = "https://api.github.com";
/// Default search topic when the query is empty (backend parity).
const STORE_TOPIC: &str = "mindbase-skill";
const STORE_TIMEOUT: Duration = Duration::from_secs(30);
const FALLBACK_PROXY: &str = "http://127.0.0.1:10808";

/// One GitHub repository returned by the store search.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreRepo {
    pub full_name: String,
    pub description: String,
    pub stargazers_count: u64,
    pub default_branch: String,
    pub html_url: String,
}

fn store_agent(proxy: Option<&str>) -> Result<ureq::Agent, String> {
    let builder = ureq::AgentBuilder::new().timeout(STORE_TIMEOUT);
    let builder = match proxy {
        Some(url) => builder
            .proxy(ureq::Proxy::new(url).map_err(|err| format!("invalid proxy url: {err}"))?),
        None => builder,
    };
    Ok(builder.build())
}

/// GET `{GITHUB_API}{path}`. Proxy-first attempt order (env HTTPS_PROXY →
/// local fallback proxy → direct): with the proxy off, a refused connection
/// fails in milliseconds, while a *direct* attempt to GitHub can hang for
/// the full timeout (os error 10060) — so direct is the last resort, not
/// the first try. Read-phase errors participate in the same fallback (a
/// TCP handshake may "succeed" through GFW interference and still stall on
/// read). 4xx/5xx statuses fail fast — proxying won't change them.
fn github_get(path: &str) -> Result<Vec<u8>, String> {
    let env_proxy = std::env::var("HTTPS_PROXY")
        .or_else(|_| std::env::var("https_proxy"))
        .ok()
        .filter(|v| !v.trim().is_empty());
    let attempts: [Option<String>; 3] = [
        env_proxy,
        Some(FALLBACK_PROXY.to_string()),
        None,
    ];
    let mut last_error = String::from("GitHub 无法访问");
    for proxy in attempts.into_iter().flatten() {
        let agent = match store_agent(Some(&proxy)) {
            Ok(agent) => agent,
            Err(err) => {
                last_error = err;
                continue;
            }
        };
        let url = format!("{GITHUB_API}{path}");
        let attempt = (|| -> Result<Vec<u8>, String> {
            use std::io::Read;
            let response = agent
                .get(&url)
                .set("User-Agent", "mindbase-desktop-skills")
                .set("Accept", "application/vnd.github+json")
                .call()
                .map_err(|err| match err {
                    ureq::Error::Status(code, _) => format!("HTTP {code}"),
                    other => format!("连接失败：{other}"),
                })?;
            let mut bytes = Vec::new();
            response
                .into_reader()
                .take(64 * 1024 * 1024)
                .read_to_end(&mut bytes)
                .map_err(|err| format!("读取响应失败：{err}"))?;
            Ok(bytes)
        })();
        match attempt {
            Ok(bytes) => return Ok(bytes),
            Err(err) if err.starts_with("HTTP ") => return Err(format!("GitHub {err}")),
            Err(err) => {
                last_error = format!("{proxy} → {err}");
                continue;
            }
        }
    }
    Err(format!(
        "{last_error}\n（已尝试本地代理与直连均失败；请确认代理软件已开启，或切换到可访问 GitHub 的网络后重试）"
    ))
}

/// Minimal percent-encoding for GitHub search queries.
fn url_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Search GitHub repositories for installable skills. Empty query falls back
/// to the `mindbase-skill` topic (backend parity).
#[tauri::command]
pub fn skills_store_search(query: Option<String>) -> Result<Vec<StoreRepo>, String> {
    let q = match query.as_deref().map(str::trim) {
        Some(text) if !text.is_empty() => text.to_string(),
        _ => format!("topic:{STORE_TOPIC}"),
    };
    let body = github_get(&format!("/search/repositories?q={}&per_page=30", url_encode(&q)))?;
    let value: serde_json::Value =
        serde_json::from_slice(&body).map_err(|err| format!("GitHub 响应解析失败：{err}"))?;
    let items = value
        .get("items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(items
        .iter()
        .filter_map(|item| {
            let full_name = item.get("full_name")?.as_str()?.to_string();
            if full_name.is_empty() {
                return None;
            }
            Some(StoreRepo {
                full_name,
                description: item
                    .get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                stargazers_count: item.get("stargazers_count").and_then(|v| v.as_u64()).unwrap_or(0),
                default_branch: item
                    .get("default_branch")
                    .and_then(|v| v.as_str())
                    .unwrap_or("main")
                    .to_string(),
                html_url: item
                    .get("html_url")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
            })
        })
        .collect())
}

/// Install one skill pack from GitHub by downloading the repo zipball.
/// `repo` must be `owner/repo`; empty branch = repo default.
#[tauri::command]
pub fn skills_store_install(
    app: AppHandle,
    repo: String,
    branch: Option<String>,
) -> Result<SkillMeta, String> {
    let repo = repo.trim().trim_matches('/').to_string();
    let parts: Vec<&str> = repo.split('/').collect();
    if parts.len() != 2 || parts.iter().any(|p| p.is_empty() || *p == "." || *p == "..") {
        return Err("仓库格式应为 owner/repo".to_string());
    }
    let branch = branch
        .as_deref()
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .map(|b| format!("/{b}"))
        .unwrap_or_default();
    let bytes = github_get(&format!("/repos/{repo}/zipball{branch}"))?;
    let repo_name = parts[1];
    let safe_repo_name: String = repo_name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '-'
            }
        })
        .collect();
    let db = app.state::<Db>();
    let target_root = {
        let dir = db
            .data_dir
            .lock()
            .map_err(|err| format!("failed to acquire data dir lock: {err}"))?;
        skills_dir(&dir)
    };
    install_zip_bytes(&target_root, Path::new(&format!("{safe_repo_name}.zip")), &bytes)
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
    conn.execute("DELETE FROM skill_settings WHERE name = ?1", params![folder])
        .map_err(|err| format!("failed to clean skill setting: {err}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build an in-memory zip (deflate) from (path, bytes) pairs.
    fn build_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let buf = std::io::Cursor::new(Vec::new());
        let mut zip = zip::ZipWriter::new(buf);
        let options =
            zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, data) in entries {
            zip.start_file(*name, options).unwrap();
            std::io::Write::write_all(&mut zip, data).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }
    const SKILL_MD: &str = "---\nname: front-name\ndescription: front desc\n---\n\n# 正文\n\n按步骤执行。";

    #[test]
    fn flat_zip_manifest_wins_and_extracts_all_files() {
        let bytes = build_zip(&[
            ("SKILL.md", SKILL_MD.as_bytes()),
            (
                "manifest.json",
                br#"{"name":"manifest-name","description":"manifest desc","version":"1.2"}"#,
            ),
            ("resources/guide.md", b"# guide"),
        ]);
        let tmp = std::env::temp_dir().join(format!("mb-skills-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let meta = install_zip_bytes(&tmp, Path::new("any.zip"), &bytes).unwrap();
        assert_eq!(meta.name, "manifest-name", "manifest beats frontmatter");
        assert_eq!(meta.description, "manifest desc");
        assert_eq!(meta.folder, "manifest-name");
        assert!(meta.enabled);
        assert!(tmp.join("manifest-name").join("SKILL.md").is_file());
        assert!(tmp.join("manifest-name").join("resources").join("guide.md").is_file());
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn zipball_prefix_layout_resolves_and_falls_back_to_frontmatter() {
        // GitHub zipball: everything under owner-repo-sha/.
        let bytes = build_zip(&[
            ("atoncooper-skillx-ab12f/SKILL.md", SKILL_MD.as_bytes()),
            ("atoncooper-skillx-ab12f/resources/a.txt", b"a"),
        ]);
        let tmp = std::env::temp_dir().join(format!("mb-skills-test-zb-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let meta = install_zip_bytes(&tmp, Path::new("atoncooper-skillx-ab12f.zip"), &bytes).unwrap();
        assert_eq!(meta.name, "front-name", "no manifest → frontmatter name");
        assert_eq!(meta.description, "front desc");
        assert_eq!(meta.folder, "front-name");
        // 前缀目录必须被剥离：SKILL.md 直接落在 folder 根（扫描约定）。
        assert!(
            tmp.join("front-name").join("SKILL.md").is_file(),
            "zipball prefix must be stripped so SKILL.md lands at folder root"
        );
        assert!(!tmp.join("front-name").join("atoncooper-skillx-ab12f").exists());
        std::fs::remove_dir_all(&tmp).ok();
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

    #[test]
    fn duplicate_install_is_rejected_and_zip_slip_aborts() {
        let bytes = build_zip(&[("SKILL.md", SKILL_MD.as_bytes())]);
        let tmp = std::env::temp_dir().join(format!("mb-skills-test-dup-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        install_zip_bytes(&tmp, Path::new("dup.zip"), &bytes).unwrap();
        let second = install_zip_bytes(&tmp, Path::new("dup.zip"), &bytes);
        assert!(second.is_err(), "second install must fail on existing folder");

        // zip-slip: an entry escaping the target aborts and cleans up.
        let mut evil_zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options =
            zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        evil_zip.start_file("../evil.txt", options).unwrap();
        std::io::Write::write_all(&mut evil_zip, b"x").unwrap();
        let evil_bytes = evil_zip.finish().unwrap().into_inner();
        let tmp2 = std::env::temp_dir().join(format!("mb-skills-test-slip-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp2);
        let result = install_zip_bytes(&tmp2, Path::new("evil.zip"), &evil_bytes);
        assert!(result.is_err(), "zip-slip entry must abort");
        std::fs::remove_dir_all(&tmp).ok();
        std::fs::remove_dir_all(&tmp2).ok();
    }

    #[test]
    fn zip_without_skill_md_is_rejected() {
        let bytes = build_zip(&[("readme.txt", b"not a skill".as_slice())]);
        let tmp = std::env::temp_dir().join(format!("mb-skills-test-empty-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let result = install_zip_bytes(&tmp, Path::new("x.zip"), &bytes);
        assert!(result.unwrap_err().contains("SKILL.md"));
        std::fs::remove_dir_all(&tmp).ok();
    }

    /// 回归：无 frontmatter 的 SKILL.md（app/ zip 格式合法形态）必须能被发现，
    /// 否则出现「安装成功但列表不显示」。
    #[test]
    fn skill_md_without_frontmatter_is_discovered() {
        let parsed = parse_skill("# 我的技能\n\n按步骤执行。", "my-skill").expect("plain body is a valid skill");
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

    /// Live-network check (needs GitHub reachability): `cargo test -- --ignored skills::`
    #[test]
    #[ignore = "requires network access to api.github.com"]
    fn store_search_live_returns_repos() {
        // 普通关键词搜索必有结果；topic:mindbase-skill 目前生态为空，空结果合法。
        let repos = skills_store_search(Some("rust cli".to_string())).expect("store search should succeed");
        assert!(!repos.is_empty(), "keyword search should return results");
        assert!(repos[0].full_name.contains('/'));
        // 空查询走 topic 回落，协议应同样成功（可能为空列表）。
        let _ = skills_store_search(None).expect("topic fallback should succeed");
    }
}

/// Install a skill from a local folder (picked via the native dialog):
/// validate `<source>/SKILL.md` parses, then deep-copy the folder into
/// `<data_dir>/skills/<folder>/`. Refuses to silently overwrite an existing
/// skill with the same folder name.
#[tauri::command]
pub fn skills_install_from_path(app: AppHandle, source: String) -> Result<SkillMeta, String> {
    let source_path = PathBuf::from(source.trim());
    if !source_path.is_dir() {
        return Err("所选路径不是文件夹".to_string());
    }
    let raw = std::fs::read_to_string(source_path.join(SKILL_FILE))
        .map_err(|_| format!("所选文件夹缺少 {SKILL_FILE}，无法作为技能安装"))?;
    let Some(parsed) = parse_skill(&raw, "") else {
        return Err("SKILL.md 解析失败：需要 frontmatter（name / description）与指令正文".to_string());
    };
    let Some(folder) = source_path.file_name().and_then(|n| n.to_str()) else {
        return Err("无法读取文件夹名称".to_string());
    };
    if !folder
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        || folder.starts_with('.')
    {
        return Err(format!(
            "文件夹名 `{folder}` 含不支持字符（仅允许字母 / 数字 / - _ .）"
        ));
    }

    let db = app.state::<Db>();
    let target_root = {
        let dir = db
            .data_dir
            .lock()
            .map_err(|err| format!("failed to acquire data dir lock: {err}"))?;
        skills_dir(&dir)
    };
    let target = target_root.join(folder);
    if target.exists() {
        return Err(format!(
            "技能 `{folder}` 已存在；请先在技能文件夹中删除或重命名后再安装"
        ));
    }
    copy_dir_recursive(&source_path, &target)
        .map_err(|err| format!("安装失败：{err}"))?;
    Ok(SkillMeta {
        name: if parsed.name.is_empty() {
            folder.to_string()
        } else {
            parsed.name
        },
        description: parsed.description,
        enabled: true,
        folder: folder.to_string(),
    })
}

/// Deep-copy a directory tree (files + nested dirs).
fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let entry_path = entry.path();
        let entry_dst = dst.join(entry.file_name());
        if entry_path.is_dir() {
            copy_dir_recursive(&entry_path, &entry_dst)?;
        } else {
            std::fs::copy(&entry_path, &entry_dst)?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Zip install — same archive format as the app/ skill store
// (SKILL.md + optional manifest.json; GitHub-zipball top-level prefix ok).
// ---------------------------------------------------------------------------

/// Per-file and total decompression caps — skill packs are small text
/// bundles; anything larger is hostile or corrupt.
const ZIP_MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
const ZIP_MAX_TOTAL_BYTES: u64 = 16 * 1024 * 1024;

/// Find the archive entry closest to the root matching `target` (root
/// preferred over GitHub-zipball's `owner-repo-sha/` prefix), mirroring
/// app/skills/zip_parser._find_entry.
fn find_entry<'a>(names: &[&'a str], target: &str) -> Option<&'a str> {
    names
        .iter()
        .filter(|n| **n == target || n.ends_with(&format!("/{target}")))
        .min_by_key(|n| n.len())
        .copied()
}

/// ASCII-safe folder name from a zip filename (extension stripped).
fn folder_from_zip_name(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    let safe: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = safe.trim_matches('-');
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// Install a skill pack from a `.zip` file on disk. Thin shell over
/// [`install_zip_bytes`] — all logic lives there for testability.
#[tauri::command]
pub fn skills_install_zip(app: AppHandle, path: String) -> Result<SkillMeta, String> {
    let bytes = std::fs::read(&path).map_err(|err| format!("无法读取 zip 文件：{err}"))?;
    let zip_path = PathBuf::from(&path);
    let db = app.state::<Db>();
    let target_root = {
        let dir = db
            .data_dir
            .lock()
            .map_err(|err| format!("failed to acquire data dir lock: {err}"))?;
        skills_dir(&dir)
    };
    install_zip_bytes(&target_root, &zip_path, &bytes)
}

/// Core zip install: metadata priority mirrors the backend (manifest.json >
/// SKILL.md frontmatter > zip filename); rejects an existing target folder
/// (no silent overwrite) and enforces zip-slip + size caps.
fn install_zip_bytes(
    target_root: &Path,
    zip_display_path: &Path,
    bytes: &[u8],
) -> Result<SkillMeta, String> {
    let cursor = std::io::Cursor::new(bytes);
    let mut archive =
        zip::ZipArchive::new(cursor).map_err(|err| format!("zip 解析失败：{err}"))?;

    let names_owned: Vec<String> = (0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().map(|f| f.name().to_string()))
        .collect();
    let names: Vec<&str> = names_owned.iter().map(String::as_str).collect();

    // Metadata resolution.
    let mut manifest_name = String::new();
    let mut manifest_description = String::new();
    if let Some(entry) = find_entry(&names, "manifest.json") {
        if let Ok(mut file) = archive.by_name(entry) {
            let mut text = String::new();
            use std::io::Read;
            if file.read_to_string(&mut text).is_ok() {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                    manifest_name = value
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string();
                    manifest_description = value
                        .get("description")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string();
                }
            }
        }
    }

    let skill_entry =
        find_entry(&names, SKILL_FILE).ok_or_else(|| format!("zip 中缺少 {SKILL_FILE}，无法作为技能安装"))?;
    let (front_name, front_description, body_nonempty) = {
        let mut file = archive
            .by_name(skill_entry)
            .map_err(|err| format!("读取 {SKILL_FILE} 失败：{err}"))?;
        let mut text = String::new();
        use std::io::Read;
        file.read_to_string(&mut text)
            .map_err(|err| format!("{SKILL_FILE} 不是有效的 UTF-8 文本：{err}"))?;
        match parse_skill(&text, "") {
            Some(parsed) => (parsed.name, parsed.description, !parsed.body.is_empty()),
            None => (String::new(), String::new(), false),
        }
    };
    if !body_nonempty && manifest_description.is_empty() {
        return Err(format!("{SKILL_FILE} 为空或无法解析，无法作为技能安装"));
    }

    // Folder name: manifest name → frontmatter name → zip filename, made
    // ASCII-safe either way.
    let raw_folder = if !manifest_name.is_empty() {
        manifest_name.clone()
    } else if !front_name.is_empty() {
        front_name.clone()
    } else {
        folder_from_zip_name(zip_display_path).ok_or("无法确定技能目录名（zip 文件名不合法）")?
    };
    let folder: String = raw_folder
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '-'
            }
        })
        .collect();
    let folder = folder.trim_matches('-').to_string();
    if folder.is_empty() {
        return Err("无法确定技能目录名（名称不含可用字符）".to_string());
    }

    let target = target_root.join(&folder);
    if target.exists() {
        return Err(format!(
            "技能 `{folder}` 已存在；请先在技能文件夹中删除或重命名后再安装"
        ));
    }

    // Extract everything except directory entries; zip-slip guard: every
    // resolved path must stay under the target dir. GitHub zipballs put all
    // entries under one `owner-repo-sha/` prefix dir — strip it so the
    // on-disk layout is `skills/<folder>/SKILL.md` (what the scanner expects).
    let top_prefix: Option<String> = {
        let tops: std::collections::HashSet<&str> = names
            .iter()
            .filter_map(|n| n.split('/').next())
            .filter(|t| !t.is_empty())
            .collect();
        let all_nested = names.iter().all(|n| n.contains('/'));
        if tops.len() == 1 && all_nested {
            tops.into_iter().next().map(|t| format!("{t}/"))
        } else {
            None
        }
    };
    std::fs::create_dir_all(&target).map_err(|err| format!("创建技能目录失败：{err}"))?;
    let mut total: u64 = 0;
    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|err| format!("zip 读取失败：{err}"))?;
        if file.is_dir() {
            continue;
        }
        let Some(rel) = file.enclosed_name() else {
            let _ = std::fs::remove_dir_all(&target);
            return Err(format!("zip 含不安全路径（{}），已中止安装", file.name()));
        };
        let rel = match &top_prefix {
            Some(prefix) => {
                let stripped = rel
                    .to_string_lossy()
                    .strip_prefix(prefix.as_str())
                    .map(PathBuf::from);
                match stripped {
                    Some(stripped) if !stripped.as_os_str().is_empty() => stripped,
                    _ => continue,
                }
            }
            None => rel.to_path_buf(),
        };
        total += file.size();
        if file.size() > ZIP_MAX_FILE_BYTES || total > ZIP_MAX_TOTAL_BYTES {
            let _ = std::fs::remove_dir_all(&target);
            return Err("zip 解压后过大（上限 16MB），已中止安装".to_string());
        }
        let out_path = target.join(&rel);
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|err| format!("创建子目录失败：{err}"))?;
        }
        let mut out_file = std::fs::File::create(&out_path)
            .map_err(|err| format!("写入文件失败：{err}"))?;
        std::io::copy(&mut file, &mut out_file)
            .map_err(|err| format!("解压失败：{err}"))?;
    }

    Ok(SkillMeta {
        name: if !manifest_name.is_empty() {
            manifest_name
        } else if !front_name.is_empty() {
            front_name
        } else {
            folder.clone()
        },
        description: if !manifest_description.is_empty() {
            manifest_description
        } else {
            front_description
        },
        enabled: true,
        folder,
    })
}
