//! 已有论文导入：抽取文本 → 拆章节 → 建项目写作文档；以及任意项目文件导入。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

use rusqlite::Connection;
use serde::Serialize;
use tauri::State;

use crate::infra::db::Db;
use crate::repositories::research::{events, projects};
use crate::workspace::manuscript;

use super::files::{project_root, ResearchFileEntry};
use super::now_secs;

/// 单文件导入上限（50 MB）。
const MAX_IMPORT_BYTES: u64 = 50 * 1024 * 1024;
/// 论文导入支持的扩展名（小写）。
const PAPER_EXTENSIONS: [&str; 9] = ["md", "markdown", "txt", "tex", "latex", "docx", "pdf", "html", "htm"];
/// 单节正文目标长度（无标题时按段落聚合）。
const SECTION_TARGET_CHARS: usize = 3_000;
/// 章节数上限。
const MAX_SECTIONS: usize = 80;

/// 导入结果（camelCase 直接给前端）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedPaper {
    pub document_id: String,
    pub title: String,
    pub kind: String,
    pub sections: Vec<String>,
    pub source_path: String,
    pub copied_path: String,
    /// 从参考文献段自动解析并入库的文献条数（0=无参考文献/解析失败未阻断导入）。
    pub references_imported: usize,
}

/// 从参考文献段解析出的一条 CSL 条目（纯函数产物，便于单测）。
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CslEntry {
    pub id: String,
    pub title: String,
    pub authors: Vec<String>,
    pub year: Option<i64>,
    pub doi: String,
    pub container_title: String,
    pub raw: String,
}

impl CslEntry {
    fn to_csl_json(&self) -> serde_json::Value {
        let mut record = serde_json::json!({
            "id": self.id,
            "type": "article-journal",
            "title": self.title,
            "note": "从 Word/PDF 导入待核验",
        });
        if !self.authors.is_empty() {
            let list: Vec<serde_json::Value> = self
                .authors
                .iter()
                .map(|name| serde_json::json!({ "literal": name }))
                .collect();
            record["author"] = serde_json::Value::Array(list);
        }
        if let Some(year) = self.year {
            record["issued"] = serde_json::json!({ "date-parts": [[year]] });
        }
        if !self.doi.is_empty() {
            record["DOI"] = serde_json::Value::String(self.doi.clone());
        }
        if !self.container_title.is_empty() {
            record["container-title"] = serde_json::Value::String(self.container_title.clone());
        }
        record
    }
}

fn ensure_project(conn: &Connection, project_id: &str) -> Result<(), String> {
    if project_id.trim().is_empty() {
        return Err("研究项目 ID 不能为空".to_string());
    }
    if projects::exists(conn, project_id)? {
        Ok(())
    } else {
        Err(format!("研究项目不存在：{project_id}"))
    }
}

fn lower_extension(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_lowercase())
        .unwrap_or_default()
}

/// 校验源文件：绝对路径、存在、普通文件、≤50MB。
fn validate_source_file(source_path: &str) -> Result<PathBuf, String> {
    let trimmed = source_path.trim();
    if trimmed.is_empty() {
        return Err("源文件路径不能为空".to_string());
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err("源文件路径必须是绝对路径".to_string());
    }
    let metadata = std::fs::metadata(&path)
        .map_err(|_| format!("源文件不存在：{}", path.display()))?;
    if metadata.is_dir() {
        return Err(format!("不支持导入目录：{}", path.display()));
    }
    if !metadata.is_file() {
        return Err(format!("源路径不是普通文件：{}", path.display()));
    }
    if metadata.len() > MAX_IMPORT_BYTES {
        return Err(format!(
            "文件过大（上限 50 MB，当前 {} MB）",
            metadata.len() / (1024 * 1024)
        ));
    }
    Ok(path)
}

/// 论文导入允许的扩展名校验。
fn validate_paper_extension(path: &Path) -> Result<String, String> {
    let ext = lower_extension(path);
    if PAPER_EXTENSIONS.contains(&ext.as_str()) {
        Ok(ext)
    } else {
        Err(format!(
            "不支持的论文格式：{}（仅支持 {}）",
            if ext.is_empty() { "无扩展名" } else { ext.as_str() },
            PAPER_EXTENSIONS.join(" / ")
        ))
    }
}

/// 标题清洗：去换行/控制字符、压缩空白、截断 120 字符；空则给定回退。
fn clean_title(raw: &str, fallback: &str) -> String {
    let mut cleaned = String::new();
    let mut last_space = false;
    for ch in raw.chars() {
        let ch = if ch.is_control() { ' ' } else { ch };
        if ch.is_whitespace() {
            if !last_space && !cleaned.is_empty() {
                cleaned.push(' ');
                last_space = true;
            }
        } else {
            cleaned.push(ch);
            last_space = false;
        }
    }
    let trimmed = cleaned.trim().trim_matches(['"', '\'', '#']);
    let result: String = trimmed.chars().take(120).collect();
    if result.trim().is_empty() {
        fallback.to_string()
    } else {
        result.trim().to_string()
    }
}

/// 从文件路径取标题（去扩展名）。
fn title_from_path(path: &Path) -> String {
    let stem = path
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();
    clean_title(&stem, "导入论文")
}

/// 从正文第一行（或前几行）推断标题。
fn title_from_text(path: &Path, text: &str) -> String {
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let cleaned = clean_title(trimmed, "");
        if !cleaned.is_empty() {
            return cleaned;
        }
        break;
    }
    title_from_path(path)
}

/// 章节名称清洗：去掉 Markdown/LaTeX 标记、压缩空白、截断 120 字符。
fn clean_section_name(raw: &str) -> String {
    let mut text = raw.trim();
    // Markdown 标题的 #。
    text = text.trim_start_matches('#').trim();
    // LaTeX 命令残留的星号/花括号。
    text = text.trim_end_matches('*').trim();
    text = text.trim_start_matches('{').trim_end_matches('}').trim();
    // 尾部冒号。
    text = text.trim_end_matches([':', '：']).trim();
    let collapsed: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let name: String = collapsed.chars().take(120).collect();
    if name.trim().is_empty() {
        "正文".to_string()
    } else {
        name.trim().to_string()
    }
}

/// 判断一行是否是章节标题：Markdown / LaTeX / 中文编号 / 数字编号 / 常见论文标题。
fn heading_of(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 120 {
        return None;
    }
    // Markdown 标题。
    let hashes = trimmed.chars().take_while(|ch| *ch == '#').count();
    if (1..=6).contains(&hashes) {
        let rest = trimmed[hashes..].trim();
        if !rest.is_empty() {
            return Some(rest.to_string());
        }
    }
    // LaTeX section / subsection（含星号版）。
    for command in ["\\section", "\\subsection"] {
        if let Some(rest) = trimmed.strip_prefix(command) {
            let rest = rest.trim_start_matches('*').trim();
            if let Some(inner) = rest.strip_prefix('{') {
                if let Some(end) = inner.find('}') {
                    return Some(inner[..end].to_string());
                }
            }
        }
    }
    // 中文编号：一、 / （一） / (一)
    let mut chars = trimmed.chars();
    if let Some(first) = chars.next() {
        if "一二三四五六七八九十".contains(first) {
            let rest = chars.as_str();
            let rest = rest.trim_start_matches(['、', '.', ' ', '．', '：', ':']);
            if rest.len() < chars.as_str().len() && !rest.trim().is_empty() {
                return Some(clean_section_name(rest));
            }
        }
        if first == '（' || first == '(' {
            let rest = chars.as_str();
            if let Some(end) = rest.find(['）', ')']) {
                let number = &rest[..end];
                if !number.is_empty()
                    && number.chars().all(|ch| "一二三四五六七八九十".contains(ch))
                {
                    let body = rest[end + number.len()..].trim_start_matches(['）', ')']).trim();
                    if !body.is_empty() {
                        return Some(clean_section_name(body));
                    }
                }
            }
        }
    }
    // 数字编号：1 / 1. / 1.1 / 2.3.1 后跟空格或中文。
    let mut number_end = 0usize;
    let bytes = trimmed.as_bytes();
    while number_end < bytes.len() && (bytes[number_end].is_ascii_digit() || bytes[number_end] == b'.') {
        number_end += 1;
    }
    if number_end > 0 {
        let prefix = &trimmed[..number_end];
        let mut rest = trimmed[number_end..].trim_start_matches([' ', '\t', '、', '.', '．']);
        let has_dot = prefix.contains('.');
        let numbered = has_dot
            || prefix.len() <= 3
                && (trimmed[number_end..].starts_with(' ') || trimmed[number_end..].starts_with('、'));
        // "2. 1 实验设计" 这类点号后还跟数字的编号：跳过后续编号前缀。
        if has_dot {
            rest = rest
                .trim_start_matches(|ch: char| ch.is_ascii_digit() || ch == '.')
                .trim();
        }
        if numbered
            && !rest.is_empty()
            && rest.chars().count() <= 60
            && !rest.ends_with('。')
            && !rest.ends_with('.')
        {
            return Some(clean_section_name(rest));
        }
    }
    // 常见论文标题（中/英，允许末尾冒号）。
    let lower = trimmed
        .trim_end_matches([':', '：'])
        .trim()
        .to_lowercase();
    const COMMON: [&str; 26] = [
        "摘要", "abstract", "引言", "introduction", "绪论",
        "相关工作", "related work", "方法", "method", "methods", "方法论",
        "实验", "experiment", "experiments", "结果", "results",
        "讨论", "discussion", "结论", "conclusion", "参考文献", "references",
        "背景", "background", "总结", "总结与展望",
    ];
    if COMMON.contains(&lower.as_str()) {
        return Some(clean_section_name(trimmed));
    }
    None
}

/// 把纯文本按空行段落聚合成不超过目标长度的「正文」章节（无标题文档）。
fn chunk_paragraphs(text: &str) -> Vec<(String, String)> {
    let mut sections: Vec<(String, String)> = Vec::new();
    let mut buffer = String::new();
    let mut index = 1usize;
    let name_for = |index: usize| -> String {
        if index <= 1 {
            "正文".to_string()
        } else {
            format!("正文（续 {index}）")
        }
    };
    let flush = |buffer: &mut String, sections: &mut Vec<(String, String)>, index: &mut usize| {
        let body = buffer.trim().to_string();
        buffer.clear();
        if body.is_empty() {
            return;
        }
        sections.push((name_for(*index), body));
        *index += 1;
    };
    for paragraph in text.split("\n\n") {
        let paragraph = paragraph.trim();
        if paragraph.is_empty() {
            continue;
        }
        let para_len = paragraph.chars().count();
        if para_len > SECTION_TARGET_CHARS {
            flush(&mut buffer, &mut sections, &mut index);
            let chars: Vec<char> = paragraph.chars().collect();
            for chunk in chars.chunks(SECTION_TARGET_CHARS) {
                let body: String = chunk.iter().collect();
                sections.push((name_for(index), body));
                index += 1;
            }
            continue;
        }
        if buffer.chars().count() + para_len > SECTION_TARGET_CHARS && !buffer.is_empty() {
            flush(&mut buffer, &mut sections, &mut index);
        }
        if !buffer.is_empty() {
            buffer.push('\n');
            buffer.push('\n');
        }
        buffer.push_str(paragraph);
    }
    flush(&mut buffer, &mut sections, &mut index);
    sections
}

/// 拆分论文文本为 (章节名, 正文) 列表（纯函数，可单测）。
pub(crate) fn split_paper_sections(text: &str) -> Vec<(String, String)> {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut raw: Vec<(String, String)> = Vec::new();
    let mut current: Option<(String, String)> = None;
    let mut preamble = String::new();
    for line in normalized.lines() {
        if let Some(title) = heading_of(line) {
            if let Some((name, body)) = current.take() {
                let body = body.trim().to_string();
                if !body.is_empty() {
                    raw.push((name, body));
                }
            }
            current = Some((title, String::new()));
        } else if let Some((_, body)) = current.as_mut() {
            if !body.is_empty() {
                body.push('\n');
            }
            body.push_str(line);
        } else {
            if !preamble.is_empty() {
                preamble.push('\n');
            }
            preamble.push_str(line);
        }
    }
    if let Some((name, body)) = current {
        let body = body.trim().to_string();
        if !body.is_empty() {
            raw.push((name, body));
        }
    }
    if raw.is_empty() {
        return chunk_paragraphs(&normalized);
    }
    // 首个标题之前的内容并入第一节正文（通常是标题/作者信息）。
    let preamble = preamble.trim();
    if !preamble.is_empty() {
        if let Some(first) = raw.first_mut() {
            if first.1.is_empty() {
                first.1 = preamble.to_string();
            } else {
                first.1 = format!("{preamble}\n\n{}", first.1);
            }
        }
    }
    // 名称清洗 + 去重 + ≤80 节（超出并入最后一节）。
    let mut result: Vec<(String, String)> = Vec::new();
    for (name, body) in raw {
        let name = clean_section_name(&name);
        if result.len() >= MAX_SECTIONS {
            if let Some(last) = result.last_mut() {
                last.1.push_str("\n\n");
                last.1.push_str(&body);
            }
            continue;
        }
        let mut unique = name.clone();
        let mut suffix = 2;
        while result.iter().any(|(existing, _)| existing == &unique) {
            let base: String = name.chars().take(110).collect();
            unique = format!("{base}（{suffix}）");
            suffix += 1;
        }
        result.push((unique, body));
    }
    result
}

/// 项目根内的相对路径（'/' 分隔）。
fn relative_to_root(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .map(|component| component.as_os_str().to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join("/")
}

/// 复制到目标目录：重名自动加 -2 / -3 …；返回实际路径。
fn copy_into_dir(dir: &Path, source: &Path, file_name: &str) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir)
        .map_err(|err| format!("创建项目文件目录失败（{}）：{err}", dir.display()))?;
    let original = Path::new(file_name);
    let stem = original
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "imported".to_string());
    let ext = original
        .extension()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut index = 1usize;
    loop {
        let name = if index == 1 {
            if ext.is_empty() {
                stem.clone()
            } else {
                format!("{stem}.{ext}")
            }
        } else if ext.is_empty() {
            format!("{stem}-{index}")
        } else {
            format!("{stem}-{index}.{ext}")
        };
        let target = dir.join(&name);
        if !target.exists() {
            std::fs::copy(source, &target)
                .map_err(|err| format!("复制文件失败（{}）：{err}", target.display()))?;
            return Ok(target);
        }
        index += 1;
        if index > 9999 {
            return Err("同名文件过多，无法生成唯一文件名".to_string());
        }
    }
}

/// 读取论文正文：md/txt 优先 Rust UTF-8，失败时交给 doc_extract.py（容忍 GBK）；
/// tex 直接读（UTF-8 lossy）；pdf/docx/html 走 doc_extract.py。
fn read_paper_text(data_dir: &Path, path: &Path, ext: &str) -> Result<(String, String), String> {
    match ext {
        "md" | "markdown" | "txt" => match std::fs::read(path) {
            Ok(bytes) => match String::from_utf8(bytes) {
                Ok(text) => {
                    let title = title_from_text(path, &text);
                    Ok((title, text))
                }
                // 非 UTF-8（常见 GBK）：交给 doc_extract.py 的编码容错。
                Err(_) => crate::knowledge::file_ingest::extract_document_text(data_dir, path),
            },
            Err(err) => Err(format!("读取源文件失败（{}）：{err}", path.display())),
        },
        "tex" | "latex" => {
            let bytes = std::fs::read(path)
                .map_err(|err| format!("读取源文件失败（{}）：{err}", path.display()))?;
            match String::from_utf8(bytes) {
                Ok(text) => {
                    let title = title_from_text(path, &text);
                    Ok((title, text))
                }
                // 非 UTF-8（GBK 等）：借 doc_extract.py 的纯文本编码容错解码。
                Err(err) => {
                    let bytes = err.into_bytes();
                    let temp = data_dir.join(format!("tex-import-{}.txt", crate::infra::db::local_id()));
                    std::fs::write(&temp, &bytes)
                        .map_err(|err| format!("写入临时文件失败：{err}"))?;
                    let result = crate::knowledge::file_ingest::extract_document_text(data_dir, &temp);
                    let _ = std::fs::remove_file(&temp);
                    let (title, text) = result?;
                    let title = clean_title(&title, &title_from_path(path));
                    Ok((title, text))
                }
            }
        }
        "docx" | "pdf" | "html" | "htm" => {
            crate::knowledge::file_ingest::extract_document_text(data_dir, path)
        }
        other => Err(format!("不支持的论文格式：{other}")),
    }
}

fn modified_secs(metadata: &std::fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|delta| delta.as_secs() as i64)
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// 参考文献解析（纯函数）
// ---------------------------------------------------------------------------

fn is_reference_heading(line: &str) -> bool {
    let cleaned = line
        .trim()
        .trim_start_matches('#')
        .trim()
        .trim_end_matches([':', '：', '.', '．'])
        .trim()
        .to_lowercase();
    matches!(
        cleaned.as_str(),
        "参考文献" | "references" | "bibliography" | "reference"
    )
}

/// 最后一个「参考文献 / References / Bibliography」标题之后的正文。
fn reference_section(text: &str) -> Option<&str> {
    let mut offset = 0usize;
    let mut start = None;
    for line in text.split_inclusive('\n') {
        if is_reference_heading(line) {
            start = Some(offset + line.len());
        }
        offset += line.len();
    }
    start.map(|position| &text[position..])
}

/// 去掉条目编号前缀（[1] / 1. / 1、 / 1)），返回（正文, 是否带编号）。
fn strip_entry_number(line: &str) -> (&str, bool) {
    let trimmed = line.trim_start();
    if let Some(rest) = trimmed.strip_prefix('[') {
        if let Some(end) = rest.find(']') {
            let number = &rest[..end];
            if !number.is_empty() && number.chars().all(|ch| ch.is_ascii_digit()) {
                let body = rest[end + 1..]
                    .trim_start_matches(['.', '、', ')', ' ', '．'])
                    .trim_start();
                return (body, true);
            }
        }
    }
    let digits_end = trimmed
        .chars()
        .take_while(|ch| ch.is_ascii_digit())
        .count();
    if digits_end > 0 && digits_end <= 3 {
        let after = &trimmed[digits_end..];
        if let Some(body) = after.strip_prefix(['.', '、', ')', '．']) {
            return (body.trim_start(), true);
        }
    }
    (trimmed, false)
}

/// 切分参考文献条目：优先行首编号，否则按空行；续行合并。
fn split_reference_entries(section: &str) -> Vec<String> {
    let lines: Vec<&str> = section.lines().collect();
    let numbered = lines
        .iter()
        .filter(|line| !line.trim().is_empty() && strip_entry_number(line).1)
        .count();
    let mut entries: Vec<String> = Vec::new();
    let mut current = String::new();
    if numbered >= 2 {
        for line in lines {
            if line.trim().is_empty() {
                continue;
            }
            let (body, is_numbered) = strip_entry_number(line);
            if is_numbered {
                if !current.trim().is_empty() {
                    entries.push(current.trim().to_string());
                }
                current = body.trim().to_string();
            } else if !current.is_empty() {
                if !body.is_empty() {
                    current.push(' ');
                    current.push_str(body.trim());
                }
            }
        }
        if !current.trim().is_empty() {
            entries.push(current.trim().to_string());
        }
        return entries;
    }
    // 无编号：空行分段（续行拼回同一段）。
    for line in lines {
        if line.trim().is_empty() {
            if !current.trim().is_empty() {
                entries.push(current.trim().to_string());
                current.clear();
            }
        } else {
            if !current.is_empty() {
                current.push(' ');
            }
            current.push_str(line.trim());
        }
    }
    if !current.trim().is_empty() {
        entries.push(current.trim().to_string());
    }
    entries
}

fn trim_doi_punctuation(text: &str) -> &str {
    text.trim_matches(|ch: char| matches!(ch, '.' | ',' | ';' | ')' | ']' | '}' | '>' | '<'))
}

/// 提取 DOI（10.<4-9位注册号>/<后缀>）。
fn extract_doi(text: &str) -> String {
    for token in text.split_whitespace() {
        let cleaned = trim_doi_punctuation(token);
        let lowered = cleaned.to_ascii_lowercase();
        for prefix in ["https://doi.org/", "http://doi.org/", "doi:", "doi "] {
            if lowered.starts_with(prefix) {
                let rest = trim_doi_punctuation(&cleaned[prefix.len()..]);
                if rest.starts_with("10.") && rest.contains('/') {
                    return rest.to_string();
                }
            }
        }
        if lowered.starts_with("10.") && lowered.contains('/') {
            return cleaned.to_string();
        }
    }
    String::new()
}

/// 提取年份（19xx / 20xx 的四位数字）。
fn extract_year(text: &str) -> Option<i64> {
    for token in text.split_whitespace() {
        let cleaned = token.trim_matches(|ch: char| ch.is_ascii_punctuation());
        if cleaned.len() == 4 && cleaned.chars().all(|ch| ch.is_ascii_digit()) {
            if let Ok(year) = cleaned.parse::<i64>() {
                if (1900..=2099).contains(&year) {
                    return Some(year);
                }
            }
        }
    }
    None
}

/// 按句点切片段（仅句点后为空白/结尾/中文句点时分段）。
fn split_sentence_segments(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut segments: Vec<String> = Vec::new();
    let mut current = String::new();
    for (index, ch) in chars.iter().enumerate() {
        let boundary = *ch == '．'
            || (*ch == '.'
                && (index + 1 >= chars.len() || chars[index + 1].is_whitespace()));
        if boundary {
            if !current.trim().is_empty() {
                segments.push(current.trim().to_string());
            }
            current.clear();
        } else {
            current.push(*ch);
        }
    }
    if !current.trim().is_empty() {
        segments.push(current.trim().to_string());
    }
    segments
}

fn quoted_title(text: &str) -> Option<String> {
    for (open, close) in [('"', '"'), ('“', '”'), ('《', '》')] {
        if let Some(start) = text.find(open) {
            let rest = &text[start + open.len_utf8()..];
            if let Some(end) = rest.find(close) {
                let inner = rest[..end].trim();
                if inner.chars().count() > 4 {
                    return Some(inner.to_string());
                }
            }
        }
    }
    None
}

fn parse_reference_entry(raw: &str, index: usize) -> Option<CslEntry> {
    let (body, _) = strip_entry_number(raw);
    let body = body.trim();
    if body.chars().count() < 20 {
        return None;
    }
    let doi = extract_doi(body);
    let mut work = body.to_string();
    if !doi.is_empty() {
        work = work.replace(&doi, " ");
    }
    let year = extract_year(&work);
    let mut authors: Vec<String> = Vec::new();
    let mut title = String::new();
    let mut source = String::new();
    if let Some(year) = year {
        let year_text = year.to_string();
        if let Some(position) = work.find(&year_text) {
            let prefix = work[..position]
                .trim()
                .trim_end_matches(['.', ',', ';', '，', '；', '：', '、'])
                .trim();
            let suffix = work[position + year_text.len()..]
                .trim()
                .trim_start_matches([',', ';', ':', '，', '；', '：', '.', '、'])
                .trim();
            let segments = split_sentence_segments(prefix);
            if let Some(first) = segments.first() {
                authors.push(first.clone());
            }
            if segments.len() >= 2 {
                title = segments[1].clone();
                if segments.len() >= 3 {
                    source = segments[2..].join(". ");
                }
            } else {
                title = prefix.to_string();
            }
            if source.is_empty() {
                source = suffix.trim_end_matches('.').trim().to_string();
            }
        }
    }
    if title.is_empty() {
        let segments = split_sentence_segments(body);
        title = segments
            .into_iter()
            .max_by_key(|segment| segment.chars().count())
            .unwrap_or_default();
    }
    if let Some(quoted) = quoted_title(body) {
        title = quoted;
    }
    let title = title
        .trim()
        .trim_matches(['"', '“', '”', '《', '》'])
        .trim()
        .chars()
        .take(300)
        .collect::<String>();
    if title.is_empty() {
        return None;
    }
    let source = source
        .trim()
        .trim_matches(['"', '“', '”'])
        .trim()
        .chars()
        .take(300)
        .collect::<String>();
    Some(CslEntry {
        id: format!("word-ref-{}", index + 1),
        title,
        authors,
        year,
        doi,
        container_title: source,
        raw: raw.trim().to_string(),
    })
}

/// 解析文本中「参考文献」段为 CSL 条目（最多 200 条；无该段返回空）。
pub(crate) fn parse_reference_entries(text: &str) -> Vec<CslEntry> {
    let Some(section) = reference_section(text) else {
        return Vec::new();
    };
    let mut entries: Vec<CslEntry> = Vec::new();
    for raw in split_reference_entries(section) {
        if entries.len() >= 200 {
            break;
        }
        if let Some(entry) = parse_reference_entry(&raw, entries.len()) {
            entries.push(entry);
        }
    }
    entries
}

/// 同步导入实现（命令层放到 spawn_blocking 里跑）。
pub(super) fn import_paper_blocking(
    conn: &Arc<Mutex<Connection>>,
    data_dir: &Path,
    project_id: &str,
    source_path: &str,
    title: Option<&str>,
) -> Result<ImportedPaper, String> {
    {
        let guard = conn.lock().map_err(|_| "数据库锁失败".to_string())?;
        ensure_project(&guard, project_id)?;
    }
    let source = validate_source_file(source_path)?;
    let ext = validate_paper_extension(&source)?;
    let (extracted_title, text) = read_paper_text(data_dir, &source, &ext)?;
    if text.trim().is_empty() {
        return Err("没有从文件中提取到可用文本（可能是扫描件或空文件）".to_string());
    }
    let title = match title.map(|value| clean_title(value, "")).filter(|value| !value.is_empty()) {
        Some(value) => value,
        None => clean_title(&extracted_title, &title_from_path(&source)),
    };
    let sections = split_paper_sections(&text);
    if sections.is_empty() {
        return Err("没有从文件中拆分出可用章节".to_string());
    }
    let names: Vec<String> = sections.iter().map(|(name, _)| name.clone()).collect();

    let root = project_root(data_dir, project_id)?;
    let imported_dir = root.join("imported");
    let file_name = source
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "paper.md".to_string());
    let copied = copy_into_dir(&imported_dir, &source, &file_name)?;
    let source_relative = relative_to_root(&root, &copied);

    let mut guard = conn.lock().map_err(|_| "数据库锁失败".to_string())?;
    let document = manuscript::create_document(
        &guard,
        data_dir,
        project_id,
        "draft",
        &title,
        &names,
    )?;
    for (name, body) in &sections {
        manuscript::save_section(&guard, data_dir, project_id, &document.id, name, body)?;
    }
    // 记录来源文件，前端可据此原样展示 Word/PDF。
    manuscript::set_document_source(&guard, project_id, &document.id, &source_relative)?;

    // 自动解析参考文献段并入库（待核验）；失败只记事件，不影响论文导入。
    let reference_entries = parse_reference_entries(&text);
    let mut references_imported = 0usize;
    if !reference_entries.is_empty() {
        let csl_json = serde_json::Value::Array(
            reference_entries
                .iter()
                .map(|entry| entry.to_csl_json())
                .collect(),
        )
        .to_string();
        match crate::workspace::literature::import_text(
            &mut guard,
            project_id,
            "csl",
            &csl_json,
        ) {
            Ok(result) => references_imported = result.imported,
            Err(err) => {
                eprintln!("[import] 参考文献自动入库失败：{err}");
                let _ = events::append(
                    &guard,
                    project_id,
                    "user",
                    "literature.import_failed",
                    &serde_json::json!({
                        "error": err,
                        "sourcePath": source_path.trim(),
                    })
                    .to_string(),
                    now_secs(),
                );
            }
        }
    }

    let _ = events::append(
        &guard,
        project_id,
        "user",
        "manuscript.paper_imported",
        &serde_json::json!({
            "documentId": document.id,
            "title": title,
            "sections": names.len(),
            "sourcePath": source_path.trim(),
            "referencesImported": references_imported,
        })
        .to_string(),
        now_secs(),
    );
    Ok(ImportedPaper {
        document_id: document.id,
        title,
        kind: "draft".to_string(),
        sections: names,
        source_path: source_path.trim().to_string(),
        copied_path: copied.to_string_lossy().to_string(),
        references_imported,
    })
}

/// 同步文件导入实现（命令层放到 spawn_blocking 里跑）。
pub(super) fn import_file_blocking(
    conn: &Arc<Mutex<Connection>>,
    data_dir: &Path,
    project_id: &str,
    source_path: &str,
) -> Result<ResearchFileEntry, String> {
    {
        let guard = conn.lock().map_err(|_| "数据库锁失败".to_string())?;
        ensure_project(&guard, project_id)?;
    }
    let source = validate_source_file(source_path)?;
    let root = project_root(data_dir, project_id)?;
    let file_name = source
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "源文件名无效".to_string())?;
    let copied = copy_into_dir(&root, &source, &file_name)?;
    let metadata = std::fs::metadata(&copied)
        .map_err(|err| format!("读取导入文件信息失败：{err}"))?;
    let name = copied
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| file_name.clone());
    Ok(ResearchFileEntry {
        path: name.clone(),
        name,
        is_dir: false,
        size: metadata.len(),
        modified_at: modified_secs(&metadata),
    })
}

/// 导入已有论文（PDF/DOCX/MD/TEX/TXT/HTML）为项目写作文档（draft）。
#[tauri::command]
pub async fn research_import_paper(
    db: State<'_, Db>,
    project_id: String,
    source_path: String,
    title: Option<String>,
) -> Result<ImportedPaper, String> {
    let conn = db.conn.clone();
    let data_dir = db
        .data_dir
        .lock()
        .map_err(|err| format!("无法获取数据目录锁：{err}"))?
        .clone();
    tauri::async_runtime::spawn_blocking(move || {
        import_paper_blocking(&conn, &data_dir, &project_id, &source_path, title.as_deref())
    })
    .await
    .map_err(|err| format!("论文导入任务执行失败：{err}"))?
}

/// 任意文件导入到项目文件根目录（重名自动加后缀，≤50MB）。
#[tauri::command]
pub async fn research_file_import(
    db: State<'_, Db>,
    project_id: String,
    source_path: String,
) -> Result<ResearchFileEntry, String> {
    let conn = db.conn.clone();
    let data_dir = db
        .data_dir
        .lock()
        .map_err(|err| format!("无法获取数据目录锁：{err}"))?
        .clone();
    tauri::async_runtime::spawn_blocking(move || {
        import_file_blocking(&conn, &data_dir, &project_id, &source_path)
    })
    .await
    .map_err(|err| format!("文件导入任务执行失败：{err}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mindbase-import-{tag}-{}",
            crate::infra::db::local_id()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn seed_project(conn: &Connection, project_id: &str) {
        let project = crate::workspace::research::ResearchProject {
            id: project_id.to_string(),
            title: "导入测试".to_string(),
            paper_kind: "journal".to_string(),
            field: String::new(),
            language: "zh".to_string(),
            target_venue: String::new(),
            current_stage: "topic".to_string(),
            privacy: "local".to_string(),
            deadline: String::new(),
            meta_json: "{}".to_string(),
            created_at: 1,
            updated_at: 1,
        };
        projects::insert(conn, &project).expect("insert project");
    }

    #[test]
    fn paper_extension_validation_accepts_supported_and_rejects_others() {
        assert_eq!(
            validate_paper_extension(Path::new("paper.MD")).expect("md"),
            "md"
        );
        assert_eq!(
            validate_paper_extension(Path::new("paper.tex")).expect("tex"),
            "tex"
        );
        assert!(validate_paper_extension(Path::new("paper.exe")).is_err());
        assert!(validate_paper_extension(Path::new("paper")).is_err());
    }

    #[test]
    fn file_import_copies_into_project_root_and_returns_entry() {
        let data_dir = temp_dir("file");
        let conn = Arc::new(Mutex::new(crate::repositories::research::in_memory_conn()));
        let project_id = "file-import-project";
        seed_project(&conn.lock().expect("db lock"), project_id);

        let source = data_dir.join("实验数据.csv");
        std::fs::write(&source, "a,b\n1,2\n").expect("write source");
        let entry = import_file_blocking(
            &conn,
            &data_dir,
            project_id,
            &source.to_string_lossy(),
        )
        .expect("import file");
        assert_eq!(entry.name, "实验数据.csv");
        assert!(!entry.is_dir);
        assert!(entry.size > 0);
        let root = crate::workspace::research::project_root(&data_dir, project_id)
            .expect("project root");
        assert!(root.join(&entry.path).is_file());
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn markdown_headings_split_into_sections() {
        let text = "# 摘要\n这是摘要。\n\n## 1 引言\n引言正文。\n\n### 1.1 背景\n背景正文。";
        let sections = split_paper_sections(text);
        let names: Vec<&str> = sections.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(names, vec!["摘要", "1 引言", "1.1 背景"]);
        assert_eq!(sections[0].1, "这是摘要。");
        assert!(sections[1].1.contains("引言正文"));
    }

    #[test]
    fn latex_and_chinese_headings_are_recognized() {
        let latex = "\\section{Introduction}\nSome text.\n\\subsection{Method}\nMethod text.";
        let names: Vec<String> = split_paper_sections(latex)
            .into_iter()
            .map(|(name, _)| name)
            .collect();
        assert_eq!(names, vec!["Introduction", "Method"]);

        let chinese = "一、绪论\n绪论内容。\n（二）研究方法\n方法内容。\n2. 1 实验设计\n实验内容。";
        let names: Vec<String> = split_paper_sections(chinese)
            .into_iter()
            .map(|(name, _)| name)
            .collect();
        assert_eq!(names, vec!["绪论", "研究方法", "实验设计"]);
    }

    #[test]
    fn common_paper_headings_without_numbering_are_recognized() {
        let text = "Abstract\nEnglish abstract.\n\n参考文献\n[1] 某文献。";
        let names: Vec<String> = split_paper_sections(text)
            .into_iter()
            .map(|(name, _)| name)
            .collect();
        assert_eq!(names, vec!["Abstract", "参考文献"]);
    }

    #[test]
    fn headingless_text_is_chunked_into_bounded_body_sections() {
        let paragraph = "段落内容。".repeat(400); // 2000 字符
        let text = format!("{paragraph}\n\n{paragraph}\n\n{paragraph}\n\n{paragraph}");
        let sections = split_paper_sections(&text);
        assert!(sections.len() >= 2, "{sections:?}");
        assert_eq!(sections[0].0, "正文");
        assert!(sections[1].0.contains("续"));
        for (_, body) in &sections {
            assert!(body.chars().count() <= SECTION_TARGET_CHARS + 10);
        }
    }

    #[test]
    fn duplicate_section_names_are_deduplicated() {
        let text = "# 方法\nA.\n# 方法\nB.";
        let names: Vec<String> = split_paper_sections(text)
            .into_iter()
            .map(|(name, _)| name)
            .collect();
        assert_eq!(names, vec!["方法", "方法（2）"]);
    }

    #[test]
    fn titles_are_cleaned_and_fallen_back() {
        assert_eq!(clean_title("  我的 论文\n标题  ", "fallback"), "我的 论文 标题");
        assert_eq!(clean_title("   ", "导入论文"), "导入论文");
        assert_eq!(
            clean_title(&"长".repeat(200), "fallback").chars().count(),
            120
        );
        assert_eq!(clean_section_name("### 3 方法：" ), "3 方法");
    }

    #[test]
    fn copy_into_dir_adds_suffix_for_duplicates() {
        let dir = temp_dir("copy");
        let source = dir.join("paper.md");
        std::fs::write(&source, b"content").expect("write source");
        let target_dir = dir.join("imported");
        let first = copy_into_dir(&target_dir, &source, "paper.md").expect("first copy");
        let second = copy_into_dir(&target_dir, &source, "paper.md").expect("second copy");
        assert!(first.ends_with("paper.md"));
        assert!(second.ends_with("paper-2.md"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn paper_import_creates_document_sections_files_and_event() {
        let data_dir = temp_dir("paper");
        let conn = crate::repositories::research::in_memory_conn();
        let project_id = "import-project".to_string();
        let project = crate::workspace::research::ResearchProject {
            id: project_id.clone(),
            title: "导入测试".to_string(),
            paper_kind: "journal".to_string(),
            field: String::new(),
            language: "zh".to_string(),
            target_venue: String::new(),
            current_stage: "topic".to_string(),
            privacy: "local".to_string(),
            deadline: String::new(),
            meta_json: "{}".to_string(),
            created_at: 1,
            updated_at: 1,
        };
        projects::insert(&conn, &project).expect("insert project");

        let source = data_dir.join("论文草稿.md");
        std::fs::write(
            &source,
            "# 摘要\n这是导入的摘要。\n\n# 引言\n这是引言正文。\n\n# 方法\n这是方法正文。",
        )
        .expect("write paper");

        let conn = Arc::new(Mutex::new(conn));
        let imported = import_paper_blocking(
            &conn,
            &data_dir,
            &project_id,
            &source.to_string_lossy(),
            Some("导入论文标题"),
        )
        .expect("import paper");
        assert_eq!(imported.title, "导入论文标题");
        assert_eq!(imported.kind, "draft");
        assert_eq!(imported.sections, vec!["摘要", "引言", "方法"]);
        assert!(Path::new(&imported.copied_path).is_file());
        assert!(imported.copied_path.contains("imported"));

        let guard = conn.lock().expect("db lock");
        let document_count: i64 = guard
            .query_row(
                "SELECT COUNT(*) FROM manuscript_documents WHERE project_id = ?1",
                rusqlite::params![project_id],
                |row| row.get(0),
            )
            .expect("document count");
        assert_eq!(document_count, 1);
        let documents = crate::workspace::manuscript::document_list(&guard, &project_id)
            .expect("documents");
        assert_eq!(documents.len(), 1);
        let expected_source = format!(
            "imported/{}",
            source.file_name().unwrap().to_string_lossy()
        );
        assert_eq!(documents[0].source_path, expected_source);
        let sections = crate::repositories::manuscript::list(&guard, &project_id, &imported.document_id)
            .expect("sections");
        assert_eq!(sections.len(), 3);
        let body = std::fs::read_to_string(&sections[0].path).expect("section body");
        assert!(body.contains("这是导入的摘要"));
        let event_count: i64 = guard
            .query_row(
                "SELECT COUNT(*) FROM project_events WHERE project_id = ?1 AND type = 'manuscript.paper_imported'",
                rusqlite::params![project_id],
                |row| row.get(0),
            )
            .expect("event count");
        assert_eq!(event_count, 1);
        assert_eq!(imported.references_imported, 0, "无参考文献段时数量为 0");
        drop(guard);
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn paper_import_parses_references_into_literature_library() {
        let data_dir = temp_dir("refs");
        let conn = crate::repositories::research::in_memory_conn();
        let project_id = "refs-project";
        seed_project(&conn, project_id);

        let source = data_dir.join("带参考文献.md");
        std::fs::write(
            &source,
            "# 摘要
这是摘要。

# 参考文献
[1] 张三, 李四. 深度学习综述. 计算机学报, 2020, 43(1): 1-20. doi:10.1000/xyz
[2] Smith J. Graph neural networks. Nature, 2021, 10(2): 1-10.
",
        )
        .expect("write paper");

        let conn = Arc::new(Mutex::new(conn));
        let imported = import_paper_blocking(
            &conn,
            &data_dir,
            project_id,
            &source.to_string_lossy(),
            Some("带参考文献的论文"),
        )
        .expect("import paper");
        assert!(imported.references_imported >= 2, "应自动导入参考文献");

        let guard = conn.lock().expect("db lock");
        let total: i64 = guard
            .query_row(
                "SELECT COUNT(*) FROM literature_refs WHERE project_id = ?1",
                rusqlite::params![project_id],
                |row| row.get(0),
            )
            .expect("literature count");
        assert_eq!(total, imported.references_imported as i64);
        let unverified: i64 = guard
            .query_row(
                "SELECT COUNT(*) FROM literature_refs WHERE project_id = ?1 AND status = 'unverified'",
                rusqlite::params![project_id],
                |row| row.get(0),
            )
            .expect("unverified count");
        assert_eq!(unverified, total, "导入的文献默认待核验");
        let payload: String = guard
            .query_row(
                "SELECT payload_json FROM project_events WHERE project_id = ?1 AND type = 'manuscript.paper_imported'",
                rusqlite::params![project_id],
                |row| row.get(0),
            )
            .expect("import event payload");
        assert!(payload.contains(r#""referencesImported":"#), "{payload}");
        drop(guard);
        let _ = std::fs::remove_dir_all(&data_dir);
    }

    #[test]
    fn reference_entries_parse_numbered_with_doi_year_and_continuation() {
        let text = "# 摘要

正文。

## 参考文献
[1] 张三, 李四. 深度学习综述. 计算机学报, 2020, 43(1): 1-20. doi:10.1000/xyz
    这是一段续行说明，应当并回上一条。
[2] Smith J. Graph neural networks. Nature, 2021, 10(2): 1-10.
";
        let entries = parse_reference_entries(text);
        assert_eq!(entries.len(), 2, "{entries:?}");
        assert_eq!(entries[0].id, "word-ref-1");
        assert!(entries[0].title.contains("深度学习"), "{:?}", entries[0]);
        assert_eq!(entries[0].year, Some(2020));
        assert_eq!(entries[0].doi, "10.1000/xyz");
        assert!(entries[0].authors[0].contains("张三"), "{:?}", entries[0].authors);
        assert!(entries[0].container_title.contains("计算机学报"), "{:?}", entries[0]);
        assert!(entries[0].raw.contains("续行"), "续行必须合并");

        assert_eq!(entries[1].id, "word-ref-2");
        assert!(entries[1].title.contains("Graph neural networks"), "{:?}", entries[1]);
        assert_eq!(entries[1].year, Some(2021));
    }

    #[test]
    fn reference_entries_split_by_blank_lines() {
        let text = "## Bibliography
Smith J. A study of things. Journal X, 2018, 5(1): 1-9. doi:10.1234/abc

Doe A. Another study. Journal Y, 2019, 6(2): 10-19.
";
        let entries = parse_reference_entries(text);
        assert_eq!(entries.len(), 2, "{entries:?}");
        assert!(entries[0].title.contains("study of things"), "{:?}", entries[0]);
        assert_eq!(entries[0].year, Some(2018));
        assert_eq!(entries[0].doi, "10.1234/abc");
        assert!(entries[1].title.contains("Another study"), "{:?}", entries[1]);
    }

    #[test]
    fn reference_entries_require_heading_and_skip_short_lines() {
        assert!(parse_reference_entries("正文没有参考文献段落。").is_empty());
        let short = "## 参考文献\n[1] 短文";
        assert!(parse_reference_entries(short).is_empty(), "过短条目应过滤");
    }

    #[test]
    fn reference_entries_are_capped_at_200() {
        let mut text = String::from("## References\n");
        for index in 1..=250 {
            text.push_str(&format!(
                "[{index}] Author {index}. A sufficiently long paper title {index}. Journal, 2020, 1(1): 1-10.\n"
            ));
        }
        let entries = parse_reference_entries(&text);
        assert_eq!(entries.len(), 200);
        assert_eq!(entries[199].id, "word-ref-200");
    }
}
