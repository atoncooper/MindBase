//! General file-system tools (read_file / write_file / list_dir) and the shared path-sandbox helpers.

use std::path::{Component, Path, PathBuf};

use serde_json::{json, Value};

use super::common::spec;
use super::super::registry::{LocalTool, ToolContext, ToolOutput, ToolSpec};

// ---------------------------------------------------------------------------
// General file-system tools (read / write / list — the agent's hands)
// ---------------------------------------------------------------------------

/// 单文件读取上限：简历/文档/代码足够，防误读巨型二进制拖爆上下文。
const FILE_READ_CAP: u64 = 2 * 1024 * 1024;
/// 单次写入上限。
const FILE_WRITE_CAP: usize = 8 * 1024 * 1024;
/// 目录列举条目上限。
const LIST_DIR_CAP: usize = 200;

/// 工具层唯一的文件系统边界（read_file / write_file / list_dir 共用）。
///
/// - 相对路径 → `<data_dir>/agent-files/<agent>/<rel>`（保留原始设计：每个
///   agent 一个落笔区，避免不同 agent 的同名相对路径互相覆盖）；
/// - 绝对路径 → 先做词法规约（`.` / `..`），把已存在的前缀 canonicalize
///   （解析符号链接）后再校验，结果必须仍位于 `<data_dir>` 之内；
/// - 任何越界统一返回中文错误，绝不把路径逃逸交给上层。
fn lexical_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => out.push(prefix.as_os_str()),
            Component::RootDir => out.push(std::path::MAIN_SEPARATOR.to_string()),
            Component::CurDir => {}
            Component::ParentDir => {
                // pop() 在只剩根/前缀时返回 false —— 此时 .. 无处可退，直接丢弃。
                let _ = out.pop();
            }
            Component::Normal(segment) => out.push(segment),
        }
    }
    out
}

/// canonicalize 最近的已存在祖先，再把不存在的尾段拼回去 —— 这样还没落盘的
/// 目标文件也能获得符号链接安全的真实路径。
fn canonicalize_with_missing_tail(path: &Path) -> Result<PathBuf, String> {
    let mut existing = path.to_path_buf();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    loop {
        match std::fs::canonicalize(&existing) {
            Ok(mut resolved) => {
                for segment in tail.iter().rev() {
                    resolved.push(segment);
                }
                return Ok(resolved);
            }
            Err(_) => match existing.file_name().map(|name| name.to_os_string()) {
                Some(name) => {
                    tail.push(name);
                    if !existing.pop() {
                        return Err("无法解析路径（没有可用的祖先目录）".to_string());
                    }
                }
                None => return Err("无法解析路径（没有可用的祖先目录）".to_string()),
            },
        }
    }
}

const PATH_ESCAPE_MESSAGE: &str = "路径越界：只能访问应用数据目录内的文件";

/// Pure half of `resolve_agent_path` — testable without a `Db`.
pub(super) fn resolve_agent_path_in(
    data_dir: &Path,
    agent: &str,
    raw: &str,
) -> Result<PathBuf, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("path 不能为空".to_string());
    }
    let raw_path = Path::new(raw);
    // 两套边界：相对路径锁在本 agent 的落笔区（agent-files/<agent>/），绝对路径锁在 data_dir。
    let (candidate, scope) = if raw_path.is_absolute() {
        (lexical_normalize(raw_path), data_dir.to_path_buf())
    } else {
        let agent_root = data_dir.join("agent-files").join(agent);
        (
            lexical_normalize(&agent_root.join(raw_path)),
            agent_root.to_path_buf(),
        )
    };

    // 边界目录必须存在；不存在时按需建出来，保证 canonicalize 可判定。
    if !data_dir.exists() {
        std::fs::create_dir_all(data_dir)
            .map_err(|err| format!("创建数据目录失败（{}）：{err}", data_dir.display()))?;
    }
    if !scope.exists() {
        std::fs::create_dir_all(&scope)
            .map_err(|err| format!("创建目录失败（{}）：{err}", scope.display()))?;
    }
    let root = std::fs::canonicalize(&scope)
        .map_err(|err| format!("无法解析目录（{}）：{err}", scope.display()))?;
    let resolved = canonicalize_with_missing_tail(&candidate)?;
    if resolved.starts_with(&root) {
        Ok(candidate)
    } else {
        Err(PATH_ESCAPE_MESSAGE.to_string())
    }
}

/// Resolve a tool-supplied path against the app data directory.
fn resolve_agent_path(ctx: &ToolContext, raw: &str) -> Result<PathBuf, String> {
    let data_dir = ctx
        .db
        .data_dir
        .lock()
        .map_err(|err| format!("failed to acquire data dir lock: {err}"))?
        .clone();
    resolve_agent_path_in(&data_dir, ctx.agent.name(), raw)
}

pub(crate) struct ReadFileTool;

impl LocalTool for ReadFileTool {
    fn spec(&self) -> &ToolSpec {
        &SPEC_READ_FILE
    }

    fn execute(&self, ctx: &ToolContext, arguments: &str) -> Result<ToolOutput, String> {
        let value: Value =
            serde_json::from_str(arguments).map_err(|err| format!("工具参数解析失败：{err}"))?;
        let raw_path = value
            .get("path")
            .and_then(|p| p.as_str())
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .ok_or("path 不能为空")?;
        let offset = value.get("offset").and_then(|v| v.as_u64());
        let limit = value.get("limit").and_then(|v| v.as_u64());
        let path = resolve_agent_path(ctx, raw_path)?;
        let path = path.as_path();
        let metadata = std::fs::metadata(path)
            .map_err(|err| format!("无法读取文件信息（{}）：{err}", path.display()))?;
        if !metadata.is_file() {
            return Err(format!("{} 不是文件（目录请用 list_dir）", path.display()));
        }
        // 分段读取（大日志 / 大文件）：offset/limit 均以字节计，limit 上限 64KB。
        if offset.is_some() || limit.is_some() {
            let start = offset.unwrap_or(0);
            let want = limit.unwrap_or(64 * 1024).clamp(1, 64 * 1024);
            if start > metadata.len() {
                return Err(format!("offset {start} 超过文件大小 {}", metadata.len()));
            }
            let (text, total) = crate::infra::exec_log::read_slice(path, start, want as usize)?;
            if text.as_bytes().contains(&0) {
                return Err("这是二进制文件，无法按文本读取".to_string());
            }
            let read_bytes = want.min(total - start) as usize;
            let next = start + read_bytes as u64;
            let mut header = format!(
                "已读取 {}（offset={start}，读取 {read_bytes} 字节，文件共 {total} 字节）",
                path.display()
            );
            if next < total {
                header.push_str(&format!("；下一段 offset={next}"));
            }
            return Ok(ToolOutput::text(format!("{header}：\n{text}")));
        }
        if metadata.len() > FILE_READ_CAP {
            return Err(format!(
                "文件过大（{} 字节，上限 {}）：请带 offset/limit 分段读取，或先用 list_dir 确认目标",
                metadata.len(),
                FILE_READ_CAP
            ));
        }
        let bytes =
            std::fs::read(path).map_err(|err| format!("读取失败（{}）：{err}", path.display()))?;
        if bytes.contains(&0) {
            return Err("这是二进制文件，无法按文本读取".to_string());
        }
        let content = String::from_utf8_lossy(&bytes).to_string();
        let line_count = content.lines().count();
        Ok(ToolOutput::text(format!(
            "已读取 {}（{} 字符 / {line_count} 行）：
{content}",
            path.display(),
            content.chars().count()
        )))
    }
}

static SPEC_READ_FILE: std::sync::LazyLock<ToolSpec> = std::sync::LazyLock::new(|| {
    spec(
        "read_file",
        "读取应用数据目录内的一个文本文件（代码/笔记/文档/配置/执行日志等）。\
         整读上限 2MB；文件更大或只想看某一段时，传 offset/limit（字节，limit ≤ 65536）分段读取——\
         命令输出日志（<data_dir>/logs/exec/*.log）很大时用这种方式翻看，不要把整份日志塞进上下文。\
         path 可为绝对路径（必须位于应用数据目录内），或相对于本 agent 专属目录 agent-files/<agent>/ 的相对路径；目录外的路径（含 .. 越界）会被拒绝。",
        json!({
            "type": "object",
            "required": ["path"],
            "properties": {
                "path": { "type": "string", "description": "文件路径（应用数据目录内的绝对路径，或相对 agent-files 的相对路径）" },
                "offset": { "type": "integer", "minimum": 0, "description": "分段读取的起始字节偏移（默认 0）" },
                "limit": { "type": "integer", "minimum": 1, "maximum": 65536, "description": "本次读取的字节数（默认 65536，上限 65536）" }
            }
        }),
    )
});

pub(crate) struct WriteFileTool;

impl LocalTool for WriteFileTool {
    fn spec(&self) -> &ToolSpec {
        &SPEC_WRITE_FILE
    }

    fn execute(&self, ctx: &ToolContext, arguments: &str) -> Result<ToolOutput, String> {
        let value: Value =
            serde_json::from_str(arguments).map_err(|err| format!("工具参数解析失败：{err}"))?;
        let raw_path = value
            .get("path")
            .and_then(|p| p.as_str())
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .ok_or("path 不能为空")?;
        let content = value
            .get("content")
            .and_then(|c| c.as_str())
            .unwrap_or_default();
        let append = value.get("append").and_then(|a| a.as_bool()) == Some(true);
        if content.len() > FILE_WRITE_CAP {
            return Err(format!(
                "内容过大（{} 字节，上限 {FILE_WRITE_CAP}）",
                content.len()
            ));
        }
        // 路径统一受沙箱约束：相对路径落 <data_dir>/agent-files/，绝对路径
        // 必须仍在 data_dir 内——工具返回的绝对路径可直接用作回复中的文件链接。
        let path = resolve_agent_path(ctx, raw_path)?;
        if path.is_dir() {
            return Err(format!("{} 是目录，请给出完整的文件路径", path.display()));
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|err| format!("创建目录失败（{}）：{err}", parent.display()))?;
        }
        let written = if append {
            use std::io::Write as _;
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .map_err(|err| format!("打开文件失败（{}）：{err}", path.display()))?;
            file.write_all(content.as_bytes())
                .map_err(|err| format!("写入失败：{err}"))?;
            content.len()
        } else {
            std::fs::write(&path, content)
                .map_err(|err| format!("写入失败（{}）：{err}", path.display()))?;
            content.len()
        };
        Ok(ToolOutput::text(format!(
            "已{} {}（{written} 字节）。回复中生成文件链接时使用该绝对路径（反斜杠写成 /）。",
            if append { "追加写入" } else { "写入" },
            path.display()
        )))
    }
}

static SPEC_WRITE_FILE: std::sync::LazyLock<ToolSpec> = std::sync::LazyLock::new(|| {
    spec(
        "write_file",
        "把文本内容写入应用数据目录内的文件（覆盖或追加，自动创建父目录）。\
         相对路径落在本 agent 专属目录 agent-files/<agent>/ 下；绝对路径必须位于应用数据目录内，越界（含 .. 逃逸）会被拒绝。\
         工具返回写入的绝对路径——生成类代码交付用它把代码写入文件，并在回复中输出 \
         [文件名](绝对路径) 形式的链接（路径反斜杠写成 /）。\
         覆盖已有文件前先向用户确认。",
        json!({
            "type": "object",
            "required": ["path", "content"],
            "properties": {
                "path": { "type": "string", "description": "目标文件路径（应用数据目录内的绝对路径，或相对本 agent 专属目录 agent-files/<agent>/ 的相对路径）" },
                "content": { "type": "string", "description": "要写入的完整文本内容" },
                "append": { "type": "boolean", "description": "true=追加到文件末尾（默认覆盖）" }
            }
        }),
    )
});

pub(crate) struct ListDirTool;

impl LocalTool for ListDirTool {
    fn spec(&self) -> &ToolSpec {
        &SPEC_LIST_DIR
    }

    fn execute(&self, ctx: &ToolContext, arguments: &str) -> Result<ToolOutput, String> {
        let value: Value =
            serde_json::from_str(arguments).map_err(|err| format!("工具参数解析失败：{err}"))?;
        let raw_path = value
            .get("path")
            .and_then(|p| p.as_str())
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .ok_or("path 不能为空")?;
        let path = resolve_agent_path(ctx, raw_path)?;
        let entries = std::fs::read_dir(&path)
            .map_err(|err| format!("无法列出目录（{}）：{err}", path.display()))?;
        let mut lines: Vec<String> = Vec::new();
        for entry in entries.take(LIST_DIR_CAP + 1) {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => continue,
            };
            if lines.len() == LIST_DIR_CAP {
                lines.push(format!("…（超过 {LIST_DIR_CAP} 项，已截断）"));
                break;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            match entry.metadata() {
                Ok(meta) if meta.is_dir() => lines.push(format!("[目录] {name}")),
                Ok(meta) => lines.push(format!("[文件] {name}（{} 字节）", meta.len())),
                Err(_) => lines.push(format!("[?] {name}")),
            }
        }
        if lines.is_empty() {
            return Ok(ToolOutput::text(format!("{} 是空目录", path.display())));
        }
        Ok(ToolOutput::text(format!(
            "{}：
{}",
            path.display(),
            lines.join(
                "
"
            )
        )))
    }
}

static SPEC_LIST_DIR: std::sync::LazyLock<ToolSpec> = std::sync::LazyLock::new(|| {
    spec(
        "list_dir",
        "列出应用数据目录内一个目录的文件与子目录（上限 200 项）。                  path 可为绝对路径（必须位于应用数据目录内），或相对于本 agent 专属目录 agent-files/<agent>/ 的相对路径；                  越界路径会被拒绝。用于探测位置、寻找文件，或确认保存路径是否存在。",
        json!({
            "type": "object",
            "required": ["path"],
            "properties": {
                "path": { "type": "string", "description": "目录路径（应用数据目录内的绝对路径，或相对 agent-files 的相对路径）" }
            }
        }),
    )
});

#[cfg(test)]
mod tests {
    use super::*;

    fn test_data_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("mindbase-fs-{tag}-{}", crate::infra::db::local_id()));
        std::fs::create_dir_all(dir.join("agent-files")).expect("create test data dir");
        dir
    }

    #[test]
    fn resolve_agent_path_anchors_relative_and_blocks_escape() {
        let dir = test_data_dir("paths");
        // 相对路径锚定在本 agent 专属目录 agent-files/<agent>/
        assert_eq!(
            resolve_agent_path_in(&dir, "code", "main.py").expect("rel"),
            dir.join("agent-files").join("code").join("main.py")
        );
        assert_eq!(
            resolve_agent_path_in(&dir, "code", "auth/main.py").expect("nested"),
            dir.join("agent-files").join("code").join("auth").join("main.py")
        );
        // 原始隔离语义：不同 agent 的同名相对路径落点不同
        assert_ne!(
            resolve_agent_path_in(&dir, "code", "main.py").expect("code"),
            resolve_agent_path_in(&dir, "chat", "main.py").expect("chat")
        );
        // 相对路径的 .. 不能逃出本 agent 目录
        assert_eq!(
            resolve_agent_path_in(&dir, "code", "../escape.py").unwrap_err(),
            PATH_ESCAPE_MESSAGE
        );
        // data_dir 内的绝对路径放行（exports 是 data_dir 子目录）
        let inside = dir.join("exports").join("report.md");
        assert_eq!(
            resolve_agent_path_in(&dir, "code", inside.to_str().unwrap()).expect("abs inside"),
            inside
        );
        // data_dir 之外的绝对路径（含 .. 逃逸）一律拒绝
        let escaping = dir
            .join("agent-files")
            .join("..")
            .join("..")
            .join("escape.py");
        assert_eq!(
            resolve_agent_path_in(&dir, "code", escaping.to_str().unwrap()).unwrap_err(),
            PATH_ESCAPE_MESSAGE
        );
        let outside = std::env::temp_dir().join("mindbase-outside.txt");
        assert_eq!(
            resolve_agent_path_in(&dir, "code", outside.to_str().unwrap()).unwrap_err(),
            PATH_ESCAPE_MESSAGE
        );
        // 空路径直接拒绝
        assert!(resolve_agent_path_in(&dir, "code", "   ").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn lexical_normalize_folds_dot_segments() {
        let dir = test_data_dir("normalize");
        let normalized =
            lexical_normalize(&dir.join("agent-files").join("a").join("..").join("b.txt"));
        assert_eq!(normalized, dir.join("agent-files").join("b.txt"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
