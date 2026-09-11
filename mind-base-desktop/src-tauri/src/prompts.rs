//! Filesystem-backed agent prompts — the desktop port's editable prompt
//! layer, mirroring the skills pack pattern (scan, never join user input).
//!
//! Layout: `<data>/prompts/<agent>/**\*.md` — one directory tree per agent
//! (`chat` / `memory` / `note` / `code` / `search`). Each tree has a
//! mandatory `base.md` (injected into the system prompt every turn); every
//! other `*.md` is a *loadable* prompt the model pulls on demand via the
//! `load_prompt` tool (the system prompt only carries a name + description
//! index — progressive disclosure).
//!
//! Bundled defaults are compiled in with `include_str!` and seeded on
//! startup; user edits win, a deleted file falls back to the bundled content
//! at read time (and is re-seeded on next start). Files are read per turn,
//! so edits apply to the very next message — no restart.

use std::path::{Path, PathBuf};

use crate::agents::AgentKind;

const PROMPTS_DIR_NAME: &str = "prompts";

/// Bundled defaults: `(agent dir, relative path, content)`. The base.md
/// entries must stay in sync with the per-agent prompts in `agents.rs`.
const BUNDLED: &[(&str, &str, &str)] = &[
    ("chat", "base.md", include_str!("../prompts/chat/base.md")),
    (
        "chat",
        "联网委托.md",
        include_str!("../prompts/chat/联网委托.md"),
    ),
    (
        "chat",
        "深度研究.md",
        include_str!("../prompts/chat/深度研究.md"),
    ),
    (
        "chat",
        "快速问答.md",
        include_str!("../prompts/chat/快速问答.md"),
    ),
    (
        "chat",
        "视频解析.md",
        include_str!("../prompts/chat/视频解析.md"),
    ),
    (
        "chat",
        "学习计划.md",
        include_str!("../prompts/chat/学习计划.md"),
    ),
    (
        "memory",
        "base.md",
        include_str!("../prompts/memory/base.md"),
    ),
    (
        "memory",
        "全面回顾.md",
        include_str!("../prompts/memory/全面回顾.md"),
    ),
    ("note", "base.md", include_str!("../prompts/note/base.md")),
    (
        "note",
        "知识整理.md",
        include_str!("../prompts/note/知识整理.md"),
    ),
    (
        "note",
        "笔记修订.md",
        include_str!("../prompts/note/笔记修订.md"),
    ),
    ("code", "base.md", include_str!("../prompts/code/base.md")),
    (
        "code",
        "代码审查.md",
        include_str!("../prompts/code/代码审查.md"),
    ),
    (
        "code",
        "调试指导.md",
        include_str!("../prompts/code/调试指导.md"),
    ),
    (
        "search",
        "base.md",
        include_str!("../prompts/search/base.md"),
    ),
    (
        "search",
        "多源核查.md",
        include_str!("../prompts/search/多源核查.md"),
    ),
    (
        "academic",
        "base.md",
        include_str!("../prompts/academic/base.md"),
    ),
    (
        "academic",
        "写论文.md",
        include_str!("../prompts/academic/写论文.md"),
    ),
    (
        "academic",
        "审查论文.md",
        include_str!("../prompts/academic/审查论文.md"),
    ),
    (
        "academic",
        "修改论文.md",
        include_str!("../prompts/academic/修改论文.md"),
    ),
    (
        "academic",
        "理解论文.md",
        include_str!("../prompts/academic/理解论文.md"),
    ),
];

pub(crate) fn prompts_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(PROMPTS_DIR_NAME)
}

/// Seed missing bundled prompt files into the data directory. Idempotent and
/// non-fatal: any IO failure is logged and skipped (the read paths fall back
/// to the bundled content anyway).
pub(crate) fn seed_defaults(data_dir: &Path) {
    for (agent, rel, content) in BUNDLED {
        let path = prompts_dir(data_dir).join(agent).join(rel);
        if path.exists() {
            continue;
        }
        if let Some(parent) = path.parent() {
            if let Err(err) = std::fs::create_dir_all(parent) {
                eprintln!("[PROMPTS] cannot create {}: {err}", parent.display());
                continue;
            }
        }
        if let Err(err) = std::fs::write(&path, content) {
            eprintln!("[PROMPTS] cannot seed {}: {err}", path.display());
        }
    }
}

/// Strip a leading BOM and the optional `---` frontmatter block, returning
/// `(description, body)`. Frontmatter keys other than `description` are
/// ignored; a file without frontmatter is all body (skills parity).
fn split_frontmatter(raw: &str) -> (Option<String>, &str) {
    let text = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    let text = text.trim_start();
    if let Some(rest) = text.strip_prefix("---") {
        if let Some((front, body)) = rest.split_once("---") {
            let mut description = None;
            for line in front.lines() {
                if let Some((key, value)) = line.split_once(':') {
                    if key.trim() == "description" {
                        description = Some(value.trim().to_string());
                    }
                }
            }
            return (description, body.trim_start());
        }
    }
    (None, text)
}

fn bundled_base(kind: AgentKind) -> &'static str {
    BUNDLED
        .iter()
        .find(|(agent, rel, _)| *agent == kind.name() && *rel == "base.md")
        .map(|(_, _, content)| *content)
        .unwrap_or("")
}

/// The agent's mandatory base prompt: the data-dir `base.md` when readable
/// and non-empty, the bundled default otherwise. Read every turn — edits
/// apply to the next message without a restart.
pub(crate) fn load_base(data_dir: &Path, kind: AgentKind) -> String {
    let path = prompts_dir(data_dir).join(kind.name()).join("base.md");
    if let Ok(raw) = std::fs::read_to_string(&path) {
        let (_, body) = split_frontmatter(&raw);
        let body = body.trim();
        if !body.is_empty() {
            return body.to_string();
        }
    }
    bundled_base(kind).to_string()
}

/// Recursively collect `(relative name, raw content)` for every `*.md` under
/// `root`, separators normalized to `/` so names are stable across platforms.
fn collect_md_files(root: &Path, dir: &Path, out: &mut Vec<(String, String)>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_md_files(root, &path, out);
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("md") {
            let Ok(raw) = std::fs::read_to_string(&path) else {
                continue;
            };
            let Some(rel) = path.strip_prefix(root).ok().and_then(|p| p.to_str()) else {
                continue;
            };
            out.push((rel.replace('\\', "/"), raw));
        }
    }
}

/// Digest of the agent's loadable prompts — relative name + frontmatter
/// description, base.md excluded. Subdirectories become part of the name
/// (`写作/简历`), which is the tree-management story. Empty string when
/// nothing is loadable (callers append nothing).
pub(crate) fn prompts_index(data_dir: &Path, kind: AgentKind) -> String {
    let root = prompts_dir(data_dir).join(kind.name());
    let mut found = Vec::new();
    collect_md_files(&root, &root, &mut found);
    found.retain(|(rel, _)| rel != "base.md");
    found.sort_by(|a, b| a.0.cmp(&b.0));
    if found.is_empty() {
        return String::new();
    }
    let mut lines = Vec::new();
    for (rel, raw) in &found {
        let (description, _) = split_frontmatter(raw);
        let description = description.unwrap_or_else(|| "（无描述）".to_string());
        lines.push(format!(
            "- `{}`：{}",
            rel.trim_end_matches(".md"),
            description
        ));
    }
    format!(
        "以下提示词可用（本 agent 的专门指令）。当任务与某条提示词的描述相关时，\
         先用 load_prompt 载入完整内容并遵循：\n{}",
        lines.join("\n")
    )
}

/// Load one loadable prompt's full body by relative name — the backticked
/// token in the index (`联网委托`, `写作/简历`). Matched against a scan of
/// the agent's tree (user input is never joined into a path, so traversal
/// is structurally impossible); falls back to the bundled default when the
/// file is missing on disk.
pub(crate) fn read_prompt_body(
    data_dir: &Path,
    kind: AgentKind,
    name: &str,
) -> Result<String, String> {
    let wanted = name.trim().trim_end_matches(".md");
    if wanted.is_empty() {
        return Err("提示词名称不能为空".to_string());
    }
    let root = prompts_dir(data_dir).join(kind.name());
    let mut found = Vec::new();
    collect_md_files(&root, &root, &mut found);
    for (rel, raw) in found {
        if rel.trim_end_matches(".md") == wanted {
            let (_, body) = split_frontmatter(&raw);
            return Ok(format!("# 提示词：{wanted}\n\n{}", body.trim()));
        }
    }
    let wanted_file = format!("{wanted}.md");
    for (agent, rel, content) in BUNDLED {
        if *agent == kind.name() && *rel == wanted_file {
            let (_, body) = split_frontmatter(content);
            return Ok(format!("# 提示词：{wanted}\n\n{}", body.trim()));
        }
    }
    Err(format!(
        "未找到提示词 `{name}`；可用清单见系统提示中的「可加载提示词」"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "mb-prompts-test-{}-{}",
                std::process::id(),
                tag
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("create temp dir");
            TempDir(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn frontmatter_split_handles_bom_and_optional_block() {
        let (desc, body) = split_frontmatter("\u{feff}---\ndescription: 检索策略\n---\n\n正文");
        assert_eq!(desc.as_deref(), Some("检索策略"));
        assert_eq!(body.trim(), "正文");

        let (desc, body) = split_frontmatter("没有 frontmatter 的正文");
        assert_eq!(desc, None);
        assert_eq!(body.trim(), "没有 frontmatter 的正文");
    }

    #[test]
    fn seed_creates_missing_files_and_never_overwrites() {
        let temp = TempDir::new("seed");
        seed_defaults(&temp.0);
        let base = temp.0.join("prompts").join("chat").join("base.md");
        assert!(base.is_file(), "bundled base seeded");

        // User edits win: a modified file is left untouched by re-seeding.
        std::fs::write(&base, "用户自定义内容").expect("edit base");
        seed_defaults(&temp.0);
        assert_eq!(
            std::fs::read_to_string(&base).expect("read back"),
            "用户自定义内容"
        );
    }

    #[test]
    fn load_base_reads_user_edit_and_falls_back_to_bundled() {
        let temp = TempDir::new("base");
        // No file → bundled default (contains the citation rule).
        let fallback = load_base(&temp.0, AgentKind::Chat);
        assert!(fallback.contains("【视频标题】"));

        // User edit replaces it verbatim (empty file also falls back).
        let base = prompts_dir(&temp.0).join("chat").join("base.md");
        std::fs::create_dir_all(base.parent().expect("parent")).expect("mkdir");
        std::fs::write(&base, "---\ndescription: 忽略\n---\n自定义核心规则").expect("write");
        assert_eq!(load_base(&temp.0, AgentKind::Chat), "自定义核心规则");
        std::fs::write(&base, "").expect("empty");
        assert!(load_base(&temp.0, AgentKind::Chat).contains("【视频标题】"));
    }

    #[test]
    fn index_lists_nested_prompts_and_excludes_base() {
        let temp = TempDir::new("index");
        let chat_dir = prompts_dir(&temp.0).join("chat");
        std::fs::create_dir_all(chat_dir.join("写作")).expect("mkdir");
        std::fs::write(chat_dir.join("base.md"), "必载核心，不该出现在索引里").expect("write base");
        std::fs::write(
            chat_dir.join("联网委托.md"),
            "---\ndescription: 联网委托细则\n---\n正文",
        )
        .expect("write loadable");
        std::fs::write(
            chat_dir.join("写作").join("简历.md"),
            "无 frontmatter 也应被发现",
        )
        .expect("write nested");

        let index = prompts_index(&temp.0, AgentKind::Chat);
        assert!(index.contains("`联网委托`：联网委托细则"));
        assert!(index.contains("`写作/简历`"), "nested tree path as name");
        assert!(index.contains("（无描述）"));
        assert!(!index.contains("base"), "base.md excluded");

        // An agent without loadable prompts yields an empty digest.
        assert_eq!(prompts_index(&temp.0, AgentKind::Memory), "");
    }

    #[test]
    fn read_prompt_body_scans_tree_and_falls_back_to_bundled() {
        let temp = TempDir::new("read");
        // Bundled fallback without any seeded file.
        assert!(read_prompt_body(&temp.0, AgentKind::Chat, "联网委托")
            .expect("bundled fallback")
            .contains("delegate_to_agent"));
        // Unknown name errors without panicking on traversal-looking input.
        assert!(read_prompt_body(&temp.0, AgentKind::Chat, "../../etc/passwd").is_err());
        assert!(read_prompt_body(&temp.0, AgentKind::Chat, "  ").is_err());

        // Disk content wins over the bundled default once seeded.
        let nested = prompts_dir(&temp.0).join("chat").join("写作");
        std::fs::create_dir_all(&nested).expect("mkdir");
        std::fs::write(nested.join("简历.md"), "自定义简历规则").expect("write");
        let body = read_prompt_body(&temp.0, AgentKind::Chat, "写作/简历.md").expect("nested read");
        assert!(body.contains("自定义简历规则"));
        assert!(body.starts_with("# 提示词：写作/简历"));
    }
}
