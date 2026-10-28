//! 文献证据层（Phase 1）。
//!
//! 负责期刊投稿线的文献条目：BibTeX / CSL-JSON 导入（解析器全部手写，不新增
//! 引用解析类 crate）、Crossref 联网核验、BibTeX 文本导出。数据落在 phase 0 已有
//! 的 `literature_refs` 表上（见 `db.rs` 的 SCHEMA_SQL）。
//!
//! 设计约定：
//! - `type` 列统一存 CSL 条目类型（article-journal / paper-conference / book /
//!   thesis / document 等）：BibTeX 条目类型在导入时映射成 CSL，导出时再映射回去。
//! - `authors_json` 存「显示名」JSON 数组（"Given Family"）；BibTeX 的
//!   "Family, Given" 写法在导入时归一化为 "Given Family"。
//! - `csl_json` 保留原始记录：CSL 导入存用户粘贴的对象；BibTeX 导入存按同样
//!   字段拼出的等效 CSL 对象，保证两种来源下游一致。
//! - Crossref 是阻塞 HTTP（ureq），必须放在 spawn_blocking 里，超时 15s。

use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::State;

use crate::db::{self, Db};

/// Crossref 请求上限：网络卡住时不能把「核验」按钮一起卡死。
const CROSSREF_TIMEOUT: Duration = Duration::from_secs(15);
const CROSSREF_WORKS: &str = "https://api.crossref.org/works";
const STATUS_UNVERIFIED: &str = "unverified";
const STATUS_VERIFIED: &str = "verified";
const STATUS_MISSING: &str = "missing";

/// 查询列顺序必须与 `row_to_ref` 的索引一一对应（type 是 SQL 关键字，需加引号）。
const LIT_COLS: &str =
    "id, cite_key, doi, title, authors_json, year, venue, \"type\", url, status, note";

/// 生成 cite_key 时跳过的虚词，避免出现 smith2020the 这类键。
const CITE_STOPWORDS: [&str; 17] = [
    "the", "a", "an", "of", "on", "in", "and", "for", "to", "with", "at", "by", "from", "into",
    "toward", "towards", "using",
];

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|delta| delta.as_secs() as i64)
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

/// 一条文献引用（前端表格行）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteratureRef {
    pub id: String,
    pub cite_key: String,
    pub doi: String,
    pub title: String,
    /// JSON 数组文本，例如 ["张三","Li Si"]。
    pub authors_json: String,
    pub year: Option<i64>,
    pub venue: String,
    /// CSL 条目类型（Rust 侧字段名避开关键字 type）。
    #[serde(rename = "type")]
    pub entry_type: String,
    pub url: String,
    /// unverified / verified / missing。
    pub status: String,
    pub note: String,
}

/// 导入结果：imported + skipped + failed = 解析出的条目数（failed 为解析失败条目）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiteratureImportResult {
    pub imported: usize,
    pub skipped: usize,
    pub failed: usize,
    /// 本次真正写入的行（不含被跳过的重复项）。
    pub refs: Vec<LiteratureRef>,
    /// 逐条失败原因（中文），无失败时为空数组。
    pub errors: Vec<String>,
}

/// 解析器的中间产物：尚未落库的一条引用。
#[derive(Debug, Default, Clone)]
struct ParsedRef {
    cite_key: String,
    doi: String,
    title: String,
    authors: Vec<String>,
    year: Option<i64>,
    venue: String,
    entry_type: String,
    url: String,
    csl: Value,
}

/// Crossref 返回的、用于补全本地记录的子集。
#[derive(Debug, Default, Clone)]
struct CrossrefMeta {
    doi: String,
    title: String,
    year: Option<i64>,
    venue: String,
    url: String,
}

/// 核验结果：命中（带回补全字段）/ 未找到（DOI 404 或标题检索无相似命中）。
enum VerifyOutcome {
    Verified(CrossrefMeta),
    Missing,
}

// ---------------------------------------------------------------------------
// 行映射与数据访问
// ---------------------------------------------------------------------------

fn row_to_ref(row: &Row<'_>) -> rusqlite::Result<LiteratureRef> {
    Ok(LiteratureRef {
        id: row.get(0)?,
        cite_key: row.get(1)?,
        doi: row.get(2)?,
        title: row.get(3)?,
        authors_json: row.get(4)?,
        year: row.get(5)?,
        venue: row.get(6)?,
        entry_type: row.get(7)?,
        url: row.get(8)?,
        status: row.get(9)?,
        note: row.get(10)?,
    })
}

fn project_exists(conn: &Connection, project_id: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM research_projects WHERE id = ?1",
        params![project_id],
        |_| Ok(()),
    )
    .optional()
    .map(|hit| hit.is_some())
    .map_err(|err| format!("读取研究项目失败：{err}"))
}

fn list_refs_conn(conn: &Connection, project_id: &str) -> Result<Vec<LiteratureRef>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {LIT_COLS} FROM literature_refs WHERE project_id = ?1 \
             ORDER BY created_at DESC, rowid DESC"
        ))
        .map_err(|err| format!("准备文献查询失败：{err}"))?;
    let rows = stmt
        .query_map(params![project_id], row_to_ref)
        .map_err(|err| format!("查询文献失败：{err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("读取文献失败：{err}"))
}

fn get_ref_conn(
    conn: &Connection,
    project_id: &str,
    ref_id: &str,
) -> Result<Option<LiteratureRef>, String> {
    conn.query_row(
        &format!("SELECT {LIT_COLS} FROM literature_refs WHERE project_id = ?1 AND id = ?2"),
        params![project_id, ref_id],
        row_to_ref,
    )
    .optional()
    .map_err(|err| format!("读取文献失败：{err}"))
}

/// 批量写入导入条目，返回（新写入数、重复跳过数、新行）。
///
/// cite_key 在项目内唯一：ON CONFLICT DO NOTHING 让重复导入保持幂等，
/// 而不是报错或覆盖已有记录（已有记录可能已被核验/批注）。
fn insert_parsed_conn(
    conn: &mut Connection,
    project_id: &str,
    parsed: Vec<ParsedRef>,
) -> Result<(usize, usize, Vec<LiteratureRef>), String> {
    let now = now_secs();
    let tx = conn
        .transaction()
        .map_err(|err| format!("开启数据库事务失败：{err}"))?;
    let mut imported = 0usize;
    let mut skipped = 0usize;
    let mut refs: Vec<LiteratureRef> = Vec::new();

    for entry in parsed {
        let id = db::local_id();
        let authors_json =
            serde_json::to_string(&entry.authors).unwrap_or_else(|_| "[]".to_string());
        let csl_json = entry.csl.to_string();
        let changed = tx
            .execute(
                "INSERT INTO literature_refs(
                     id, project_id, cite_key, doi, title, authors_json, year, venue,
                     \"type\", url, status, csl_json, note, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'unverified', ?11, '', ?12)
                 ON CONFLICT(project_id, cite_key) DO NOTHING",
                params![
                    id,
                    project_id,
                    entry.cite_key,
                    entry.doi,
                    entry.title,
                    authors_json,
                    entry.year,
                    entry.venue,
                    entry.entry_type,
                    entry.url,
                    csl_json,
                    now,
                ],
            )
            .map_err(|err| format!("写入文献失败：{err}"))?;
        if changed == 0 {
            skipped += 1;
            continue;
        }
        imported += 1;
        refs.push(LiteratureRef {
            id,
            cite_key: entry.cite_key,
            doi: entry.doi,
            title: entry.title,
            authors_json,
            year: entry.year,
            venue: entry.venue,
            entry_type: entry.entry_type,
            url: entry.url,
            status: STATUS_UNVERIFIED.to_string(),
            note: String::new(),
        });
    }

    tx.commit()
        .map_err(|err| format!("提交数据库事务失败：{err}"))?;
    Ok((imported, skipped, refs))
}

/// 删除文献，并级联清理 citations（该表没有外键约束，只能手动清）。
/// 幂等：目标不存在时也返回成功，避免前端重复点击报错。
fn delete_ref_conn(conn: &mut Connection, project_id: &str, ref_id: &str) -> Result<(), String> {
    let tx = conn
        .transaction()
        .map_err(|err| format!("开启数据库事务失败：{err}"))?;
    tx.execute(
        "DELETE FROM citations WHERE project_id = ?1 AND ref_id = ?2",
        params![project_id, ref_id],
    )
    .map_err(|err| format!("清理文献引用失败：{err}"))?;
    tx.execute(
        "DELETE FROM literature_refs WHERE project_id = ?1 AND id = ?2",
        params![project_id, ref_id],
    )
    .map_err(|err| format!("删除文献失败：{err}"))?;
    tx.commit()
        .map_err(|err| format!("提交数据库事务失败：{err}"))?;
    Ok(())
}

fn mark_status_conn(
    conn: &Connection,
    project_id: &str,
    ref_id: &str,
    status: &str,
) -> Result<LiteratureRef, String> {
    conn.execute(
        "UPDATE literature_refs SET status = ?1 WHERE project_id = ?2 AND id = ?3",
        params![status, project_id, ref_id],
    )
    .map_err(|err| format!("更新文献状态失败：{err}"))?;
    get_ref_conn(conn, project_id, ref_id)?.ok_or_else(|| format!("文献不存在：{ref_id}"))
}

/// 用 Crossref 元数据补全并置为 verified。只补空字段/以 Crossref 为准的字段：
/// title 采用 Crossref 的规范标题，DOI 仅在本地为空时回填（用户手填的 DOI 不覆盖）。
fn apply_verified_conn(
    conn: &Connection,
    project_id: &str,
    ref_id: &str,
    existing: &LiteratureRef,
    meta: &CrossrefMeta,
) -> Result<LiteratureRef, String> {
    let title = if meta.title.trim().is_empty() {
        existing.title.clone()
    } else {
        meta.title.trim().to_string()
    };
    let venue = if meta.venue.trim().is_empty() {
        existing.venue.clone()
    } else {
        meta.venue.trim().to_string()
    };
    let url = if meta.url.trim().is_empty() {
        existing.url.clone()
    } else {
        meta.url.trim().to_string()
    };
    let doi = if existing.doi.trim().is_empty() {
        meta.doi.trim().to_string()
    } else {
        existing.doi.trim().to_string()
    };
    let year = meta.year.or(existing.year);

    conn.execute(
        "UPDATE literature_refs SET status = ?1, title = ?2, year = ?3, venue = ?4, url = ?5, \
             doi = ?6 WHERE project_id = ?7 AND id = ?8",
        params![
            STATUS_VERIFIED,
            title,
            year,
            venue,
            url,
            doi,
            project_id,
            ref_id
        ],
    )
    .map_err(|err| format!("更新文献核验结果失败：{err}"))?;
    get_ref_conn(conn, project_id, ref_id)?.ok_or_else(|| format!("文献不存在：{ref_id}"))
}

/// 写项目事件（时间线）。审计属于旁路：写失败不影响主流程。
fn record_event_conn(conn: &Connection, project_id: &str, kind: &str, payload_json: &str) {
    let _ = conn.execute(
        "INSERT INTO project_events(project_id, ts, actor, type, payload_json) \
         VALUES (?1, ?2, 'user', ?3, ?4)",
        params![project_id, now_secs(), kind, payload_json],
    );
}

// ---------------------------------------------------------------------------
// BibTeX 解析（手写）
// ---------------------------------------------------------------------------

/// 解析完整的 BibTeX 文本，返回（条目、逐条错误）。
///
/// 扫描策略：从 @ 开始读条目类型，定位 { 或 ( 后按括号配对找到条目结尾；
/// 条目体再按顶层逗号切字段。@string / @comment / @preamble 直接忽略。
fn parse_bibtex(input: &str) -> (Vec<ParsedRef>, Vec<String>) {
    let chars: Vec<char> = input.chars().collect();
    let mut entries: Vec<ParsedRef> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    let mut i = 0usize;

    while i < chars.len() {
        if chars[i] != '@' {
            i += 1;
            continue;
        }
        // 条目类型：@ 后连续的字母。
        let mut j = i + 1;
        let type_start = j;
        while j < chars.len() && chars[j].is_ascii_alphabetic() {
            j += 1;
        }
        let entry_type: String = chars[type_start..j]
            .iter()
            .collect::<String>()
            .to_ascii_lowercase();
        if entry_type.is_empty() {
            i += 1;
            continue;
        }
        while j < chars.len() && chars[j].is_whitespace() {
            j += 1;
        }
        let (open, close) = match chars.get(j).copied() {
            Some('{') => ('{', '}'),
            Some('(') => ('(', ')'),
            _ => {
                i = j.max(i + 1);
                continue;
            }
        };
        j += 1;
        let body_start = j;
        let mut depth = 1usize;
        while j < chars.len() {
            if chars[j] == open {
                depth += 1;
            } else if chars[j] == close {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            j += 1;
        }
        let body: String = chars[body_start..j.min(chars.len())].iter().collect();
        i = (j + 1).min(chars.len());

        if matches!(entry_type.as_str(), "string" | "comment" | "preamble") {
            continue;
        }
        match parse_bibtex_entry(&entry_type, &body) {
            Some(entry) => entries.push(entry),
            None => errors.push(format!("无法解析 @{entry_type} 条目（缺少 title 字段）")),
        }
    }

    (entries, errors)
}

/// 顶层分隔符切分：只在花括号深度 0 且不在引号内切分（值里的逗号/花括号被保护）。
fn split_top_level(body: &str, separator: char) -> Vec<String> {
    let mut parts: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut depth = 0i32;
    let mut in_quote = false;
    for ch in body.chars() {
        match ch {
            '{' => {
                depth += 1;
                current.push(ch);
            }
            '}' => {
                if depth > 0 {
                    depth -= 1;
                }
                current.push(ch);
            }
            '"' if depth == 0 => {
                in_quote = !in_quote;
                current.push(ch);
            }
            c if c == separator && depth == 0 && !in_quote => {
                parts.push(std::mem::take(&mut current));
            }
            _ => current.push(ch),
        }
    }
    parts.push(current);
    parts
}

/// 去掉字段值最外层的一对花括号或引号（内部花括号保留给作者切分用）。
fn strip_bibtex_delimiters(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.len() >= 2
        && ((trimmed.starts_with('{') && trimmed.ends_with('}'))
            || (trimmed.starts_with('"') && trimmed.ends_with('"')))
    {
        return trimmed[1..trimmed.len() - 1].to_string();
    }
    trimmed.to_string()
}

/// 拆出条目的 cite_key 与（小写字段名, 去外层定界符的原始值）。
fn split_bibtex_fields(body: &str) -> (String, Vec<(String, String)>) {
    let parts = split_top_level(body, ',');
    let mut iter = parts.into_iter();
    let key = iter.next().unwrap_or_default().trim().to_string();
    let mut fields: Vec<(String, String)> = Vec::new();
    for part in iter {
        let Some((name, value)) = part.split_once('=') else {
            continue;
        };
        let name = name.trim().to_ascii_lowercase();
        if name.is_empty() {
            continue;
        }
        fields.push((name, strip_bibtex_delimiters(value.trim())));
    }
    (key, fields)
}

fn parse_bibtex_entry(entry_type: &str, body: &str) -> Option<ParsedRef> {
    let (raw_key, fields) = split_bibtex_fields(body);
    let get = |name: &str| {
        fields
            .iter()
            .find(|(field, _)| field == name)
            .map(|(_, value)| value.clone())
    };

    let title = clean_bibtex_value(&get("title").unwrap_or_default());
    if title.trim().is_empty() {
        return None;
    }
    let authors = get("author")
        .map(|raw| split_bibtex_authors(&raw))
        .unwrap_or_default();
    let year = get("year")
        .and_then(|raw| parse_year(&clean_bibtex_value(&raw)))
        .or_else(|| get("date").and_then(|raw| parse_year(&clean_bibtex_value(&raw))));
    // journal 用于 article，booktitle 用于 inproceedings/book；publisher 兜底。
    let venue = get("journal")
        .or_else(|| get("booktitle"))
        .or_else(|| get("publisher"))
        .map(|raw| clean_bibtex_value(&raw))
        .unwrap_or_default();
    let doi = get("doi")
        .map(|raw| normalize_doi(&clean_bibtex_value(&raw)))
        .unwrap_or_default();
    let url = get("url")
        .map(|raw| clean_bibtex_value(&raw))
        .unwrap_or_default();
    let csl_type = csl_type_from_bibtex(entry_type).to_string();

    let cite_key = sanitize_cite_key(&raw_key);
    let cite_key = if cite_key.is_empty() {
        make_cite_key(&authors, year, &title)
    } else {
        cite_key
    };
    let csl = bibtex_entry_to_csl(
        &cite_key, &csl_type, &title, &authors, year, &venue, &doi, &url,
    );

    Some(ParsedRef {
        cite_key,
        doi,
        title,
        authors,
        year,
        venue,
        entry_type: csl_type,
        url,
        csl,
    })
}

/// BibTeX 条目 → 等效 CSL 对象，写入 csl_json 列（保持两种来源下游一致）。
fn bibtex_entry_to_csl(
    cite_key: &str,
    csl_type: &str,
    title: &str,
    authors: &[String],
    year: Option<i64>,
    venue: &str,
    doi: &str,
    url: &str,
) -> Value {
    let mut record = serde_json::Map::new();
    record.insert("id".to_string(), Value::String(cite_key.to_string()));
    record.insert("type".to_string(), Value::String(csl_type.to_string()));
    if !title.is_empty() {
        record.insert("title".to_string(), Value::String(title.to_string()));
    }
    if !authors.is_empty() {
        let list: Vec<Value> = authors
            .iter()
            .map(|name| {
                let (given, family) = split_display_name(name);
                let mut author = serde_json::Map::new();
                if !family.is_empty() {
                    author.insert("family".to_string(), Value::String(family));
                }
                if !given.is_empty() {
                    author.insert("given".to_string(), Value::String(given));
                }
                Value::Object(author)
            })
            .collect();
        record.insert("author".to_string(), Value::Array(list));
    }
    if let Some(year) = year {
        record.insert("issued".to_string(), json!({ "date-parts": [[year]] }));
    }
    if !venue.is_empty() {
        record.insert(
            "container-title".to_string(),
            Value::String(venue.to_string()),
        );
    }
    if !doi.is_empty() {
        record.insert("DOI".to_string(), Value::String(doi.to_string()));
    }
    if !url.is_empty() {
        record.insert("URL".to_string(), Value::String(url.to_string()));
    }
    Value::Object(record)
}

/// 按顶层（花括号外）的 and 拆分作者列表。
///
/// 被花括号保护的名字（如 {Barnes and Noble}）不会被拆开；"Family, Given"
/// 归一化为 "Given Family"；BibTeX 的 others（et al.）会被丢弃。
fn split_bibtex_authors(raw: &str) -> Vec<String> {
    let chars: Vec<char> = raw.chars().collect();
    let mut terms: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut depth = 0i32;
    let mut i = 0usize;

    while i < chars.len() {
        let ch = chars[i];
        if ch == '{' {
            depth += 1;
            current.push(ch);
            i += 1;
            continue;
        }
        if ch == '}' {
            if depth > 0 {
                depth -= 1;
            }
            current.push(ch);
            i += 1;
            continue;
        }
        if depth == 0 && ch.is_whitespace() {
            let ws_start = i;
            let mut j = i;
            while j < chars.len() && chars[j].is_whitespace() {
                j += 1;
            }
            let word_start = j;
            while j < chars.len() && chars[j].is_alphabetic() {
                j += 1;
            }
            let word: String = chars[word_start..j].iter().collect();
            let trailing_space = j >= chars.len() || chars[j].is_whitespace();
            // 顶层 " and "（含 "... and" 结尾）是作者分隔符。
            if word.eq_ignore_ascii_case("and") && trailing_space {
                if !current.trim().is_empty() {
                    terms.push(current.trim().to_string());
                }
                current.clear();
                let mut k = j;
                while k < chars.len() && chars[k].is_whitespace() {
                    k += 1;
                }
                i = k;
                continue;
            }
            let whitespace: String = chars[ws_start..word_start].iter().collect();
            current.push_str(&whitespace);
            i = word_start;
            continue;
        }
        current.push(ch);
        i += 1;
    }
    if !current.trim().is_empty() {
        terms.push(current.trim().to_string());
    }

    terms
        .into_iter()
        .map(|term| normalize_author_name(&clean_bibtex_value(&term)))
        .filter(|name| !name.is_empty() && !name.eq_ignore_ascii_case("others"))
        .collect()
}

/// "Family, Given" → "Given Family"；单名或已归一化的保持原样。
fn normalize_author_name(cleaned: &str) -> String {
    match cleaned.split_once(',') {
        Some((family, given)) => {
            let family = family.trim();
            let given = given.trim();
            if given.is_empty() {
                family.to_string()
            } else {
                format!("{given} {family}")
            }
        }
        None => cleaned.to_string(),
    }
}

/// 去 LaTeX 花括号与常见转义，并把空白折叠成单个空格。
fn clean_bibtex_value(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '{' | '}' => {}
            '~' => out.push(' '),
            '\\' => match chars.peek().copied() {
                // 原位转义字符直接还原。
                Some(escaped @ ('&' | '%' | '_' | '#' | '$' | '{' | '}')) => {
                    out.push(escaped);
                    chars.next();
                }
                // 其余命令（\"、\'、\emph 等）丢弃：字母命令整段吃掉，避免把
                // 命令名残留在正文里；非字母转义（变音符号）只丢转义本身。
                Some(other) => {
                    chars.next();
                    if other.is_ascii_alphabetic() {
                        while matches!(chars.peek(), Some(next) if next.is_ascii_alphabetic()) {
                            chars.next();
                        }
                    }
                }
                None => {}
            },
            _ => out.push(ch),
        }
    }
    collapse_whitespace(&out)
}

fn collapse_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 保留年份前 4 位数字（"2020"、"2020-05-01"、"2020年" 均可）。
fn parse_year(text: &str) -> Option<i64> {
    let mut digits = String::new();
    for ch in text.chars() {
        if ch.is_ascii_digit() {
            digits.push(ch);
        } else if !digits.is_empty() {
            break;
        }
    }
    if digits.len() < 4 {
        return None;
    }
    let year = digits[..4].parse::<i64>().ok()?;
    if (1000..=2999).contains(&year) {
        Some(year)
    } else {
        None
    }
}

fn normalize_doi(raw: &str) -> String {
    let trimmed = raw.trim();
    let lowered = trimmed.to_ascii_lowercase();
    for prefix in [
        "https://doi.org/",
        "http://doi.org/",
        "https://dx.doi.org/",
        "http://dx.doi.org/",
        "doi:",
    ] {
        if lowered.starts_with(prefix) {
            return trimmed[prefix.len()..].trim().to_string();
        }
    }
    trimmed.to_string()
}

fn csl_type_from_bibtex(entry_type: &str) -> &'static str {
    match entry_type {
        "article" => "article-journal",
        "inproceedings" | "conference" => "paper-conference",
        "book" => "book",
        "phdthesis" | "mastersthesis" | "thesis" => "thesis",
        "incollection" | "inbook" => "chapter",
        "techreport" => "report",
        "online" | "electronic" | "www" => "webpage",
        // 其余类型（含 @misc）统一按 document 存，导出时回到 @misc。
        _ => "document",
    }
}

fn bibtex_type_from_csl(csl_type: &str) -> &'static str {
    match csl_type {
        "article-journal" | "article" | "article-magazine" | "article-newspaper" => "article",
        "paper-conference" | "speech" => "inproceedings",
        "book" => "book",
        "chapter" => "incollection",
        "thesis" => "phdthesis",
        "report" => "techreport",
        "webpage" => "misc",
        _ => "misc",
    }
}

/// (给定名, 姓)：按最后一个空白切分；无空白视为只有姓。
fn split_display_name(name: &str) -> (String, String) {
    let trimmed = name.trim();
    match trimmed.rfind(char::is_whitespace) {
        Some(index) => (
            trimmed[..index].trim().to_string(),
            trimmed[index..].trim().to_string(),
        ),
        None => (String::new(), trimmed.to_string()),
    }
}

fn sanitize_cite_key(raw: &str) -> String {
    let key: String = raw
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_whitespace() || matches!(ch, ',' | '{' | '}' | '\\' | '"' | '#') {
                '_'
            } else {
                ch
            }
        })
        .collect();
    key.trim_matches('_').to_string()
}

/// 缺 cite_key 时按「姓 + 年份 + 标题首个实词」生成，例如 smith2020study。
fn make_cite_key(authors: &[String], year: Option<i64>, title: &str) -> String {
    let family = authors
        .first()
        .map(|name| split_display_name(name).1.to_ascii_lowercase())
        .unwrap_or_default();
    let family: String = family
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect();
    let year_part = year
        .map(|value| value.to_string())
        .unwrap_or_else(|| "nd".to_string());
    let word = title
        .split_whitespace()
        .map(|token| {
            token
                .trim_matches(|ch: char| !ch.is_alphanumeric())
                .to_ascii_lowercase()
        })
        .find(|token| token.len() >= 3 && !CITE_STOPWORDS.contains(&token.as_str()))
        .unwrap_or_default();
    let key = format!("{family}{year_part}{word}");
    if key.is_empty() {
        "ref".to_string()
    } else {
        key
    }
}

// ---------------------------------------------------------------------------
// CSL-JSON 解析
// ---------------------------------------------------------------------------

/// 解析 CSL-JSON。返回（条目、逐条错误）；顶层 JSON 语法错误直接 Err。
fn parse_csl(input: &str) -> Result<(Vec<ParsedRef>, Vec<String>), String> {
    let value: Value =
        serde_json::from_str(input).map_err(|err| format!("CSL-JSON 解析失败：{err}"))?;
    let items = match value {
        Value::Array(items) => items,
        // 单条记录也接受，省得用户为了导入一条自己加方括号。
        other @ Value::Object(_) => vec![other],
        _ => return Err("CSL-JSON 必须是对象数组".to_string()),
    };

    let mut entries: Vec<ParsedRef> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    for (index, item) in items.into_iter().enumerate() {
        if !item.is_object() {
            errors.push(format!("第 {} 条 CSL 记录不是对象，已跳过", index + 1));
            continue;
        }
        let title = item
            .get("title")
            .and_then(first_string)
            .map(|value| collapse_whitespace(&value))
            .unwrap_or_default();
        if title.trim().is_empty() {
            errors.push(format!("第 {} 条 CSL 记录缺少 title，已跳过", index + 1));
            continue;
        }
        let authors = csl_authors(&item);
        let year = csl_year(&item);
        let venue = item
            .get("container-title")
            .and_then(first_string)
            .or_else(|| item.get("publisher").and_then(first_string))
            .map(|value| collapse_whitespace(&value))
            .unwrap_or_default();
        let doi = item
            .get("DOI")
            .and_then(first_string)
            .map(|value| normalize_doi(&value))
            .unwrap_or_default();
        let url = item.get("URL").and_then(first_string).unwrap_or_default();
        let entry_type = item
            .get("type")
            .and_then(first_string)
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "document".to_string());
        let cite_key = item
            .get("id")
            .and_then(csl_id)
            .map(|value| sanitize_cite_key(&value))
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| make_cite_key(&authors, year, &title));

        entries.push(ParsedRef {
            cite_key,
            doi,
            title,
            authors,
            year,
            venue,
            entry_type,
            url,
            // 原始 CSL 记录整体保留（含本地未映射的字段）。
            csl: item,
        });
    }
    Ok((entries, errors))
}

fn csl_id(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

/// CSL 的字符串或字符串数组字段统一取第一个非空串（container-title 常是数组）。
fn first_string(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Value::Array(items) => items.iter().find_map(first_string),
        _ => None,
    }
}

fn csl_authors(item: &Value) -> Vec<String> {
    let Some(Value::Array(list)) = item.get("author") else {
        return Vec::new();
    };
    let mut authors = Vec::new();
    for author in list {
        match author {
            Value::String(name) => {
                let trimmed = name.trim();
                if !trimmed.is_empty() {
                    authors.push(trimmed.to_string());
                }
            }
            Value::Object(_) => {
                if let Some(name) = csl_author_name(author) {
                    authors.push(name);
                }
            }
            _ => {}
        }
    }
    authors
}

/// CSL 作者对象 → 显示名：family/given 拼成 "Given Family"，literal 直接用。
fn csl_author_name(author: &Value) -> Option<String> {
    if let Some(Value::String(literal)) = author.get("literal") {
        let trimmed = literal.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    let family = author
        .get("family")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim();
    let given = author
        .get("given")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim();
    match (family.is_empty(), given.is_empty()) {
        (false, false) => Some(format!("{given} {family}")),
        (false, true) => Some(family.to_string()),
        (true, false) => Some(given.to_string()),
        (true, true) => None,
    }
}

/// 从 CSL/Crossref 的 issued.date-parts[0][0] 取年份，容忍字符串年份。
fn csl_year(item: &Value) -> Option<i64> {
    for key in [
        "issued",
        "published-print",
        "published-online",
        "published",
        "created",
    ] {
        let part = item
            .get(key)
            .and_then(|value| value.get("date-parts"))
            .and_then(|value| value.get(0))
            .and_then(|value| value.get(0));
        let Some(part) = part else { continue };
        if let Some(year) = part.as_i64() {
            return Some(year);
        }
        if let Some(text) = part.as_str() {
            if let Some(year) = parse_year(text) {
                return Some(year);
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Crossref 核验
// ---------------------------------------------------------------------------

/// Crossref 要求可识别的 UA（polite pool），否则高峰期容易被限流。
fn build_crossref_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout(CROSSREF_TIMEOUT)
        .user_agent("mind-base-desktop/0.1 (+https://github.com/atoncooper/MindBase)")
        .build()
}

/// 阻塞式核验（调用方负责 spawn_blocking）。
///
/// 有 DOI 走 /works/{doi}：200 且标题相似 → 命中；404 → 未找到（missing）；
/// 其它 HTTP 错误或网络错误 → Err（前端提示可重试）。
/// 无 DOI 走 /works?query.title=：在前 5 条里找标题相似的第一条，找不到 → missing。
fn verify_blocking(doi: &str, local_title: &str) -> Result<VerifyOutcome, String> {
    let agent = build_crossref_agent();
    let doi = doi.trim();
    let local_title = local_title.trim();

    if !doi.is_empty() {
        let url = format!("{CROSSREF_WORKS}/{}", url_encode(doi, true));
        match agent.get(&url).call() {
            Ok(response) => {
                let payload: Value = response
                    .into_json()
                    .map_err(|err| format!("Crossref 响应解析失败：{err}"))?;
                let item = payload.get("message").cloned().unwrap_or(payload);
                let meta = crossref_meta(&item);
                // 本地标题为空时无法比对，按命中处理（至少能补全元数据）。
                if local_title.is_empty() || titles_match(local_title, &meta.title) {
                    Ok(VerifyOutcome::Verified(meta))
                } else {
                    Ok(VerifyOutcome::Missing)
                }
            }
            Err(ureq::Error::Status(404, _)) => Ok(VerifyOutcome::Missing),
            Err(ureq::Error::Status(code, _)) => {
                Err(format!("Crossref 返回 HTTP {code}，请稍后重试"))
            }
            Err(ureq::Error::Transport(err)) => {
                Err(format!("访问 Crossref 失败：{err}（请检查网络或代理设置）"))
            }
        }
    } else {
        let url = format!(
            "{CROSSREF_WORKS}?query.title={}&rows=5",
            url_encode(local_title, false)
        );
        match agent.get(&url).call() {
            Ok(response) => {
                let payload: Value = response
                    .into_json()
                    .map_err(|err| format!("Crossref 响应解析失败：{err}"))?;
                let items = payload
                    .get("message")
                    .and_then(|message| message.get("items"))
                    .and_then(|value| value.as_array())
                    .cloned()
                    .unwrap_or_default();
                for item in items {
                    let meta = crossref_meta(&item);
                    if !meta.title.is_empty() && titles_match(local_title, &meta.title) {
                        return Ok(VerifyOutcome::Verified(meta));
                    }
                }
                Ok(VerifyOutcome::Missing)
            }
            Err(ureq::Error::Status(code, _)) => {
                Err(format!("Crossref 返回 HTTP {code}，请稍后重试"))
            }
            Err(ureq::Error::Transport(err)) => {
                Err(format!("访问 Crossref 失败：{err}（请检查网络或代理设置）"))
            }
        }
    }
}

fn crossref_meta(item: &Value) -> CrossrefMeta {
    CrossrefMeta {
        doi: item
            .get("DOI")
            .and_then(first_string)
            .map(|value| normalize_doi(&value))
            .unwrap_or_default(),
        title: item
            .get("title")
            .and_then(first_string)
            .map(|value| clean_crossref_text(&value))
            .unwrap_or_default(),
        year: csl_year(item),
        venue: item
            .get("container-title")
            .and_then(first_string)
            .map(|value| clean_crossref_text(&value))
            .unwrap_or_default(),
        url: item.get("URL").and_then(first_string).unwrap_or_default(),
    }
}

/// Crossref 标题里可能夹带 JATS/HTML 标签（i/sub 等），导出前剥掉。
fn clean_crossref_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_tag = false;
    for ch in text.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    collapse_whitespace(&out)
}

fn normalize_title(text: &str) -> String {
    text.chars()
        .filter(|ch| ch.is_alphanumeric())
        .flat_map(|ch| ch.to_lowercase())
        .collect()
}

/// 标题相似判定：忽略大小写/标点后「相等或包含」（容许副标题、翻译差异）。
/// 过短的标题（少于 8 字符）不参与包含判定，避免 AI 之类的词误命中。
fn titles_match(left: &str, right: &str) -> bool {
    let a = normalize_title(left);
    let b = normalize_title(right);
    if a.is_empty() || b.is_empty() {
        return false;
    }
    if a == b {
        return true;
    }
    let (shorter, longer) = if a.chars().count() <= b.chars().count() {
        (&a, &b)
    } else {
        (&b, &a)
    };
    shorter.chars().count() >= 8 && longer.contains(shorter.as_str())
}

fn url_encode(text: &str, keep_slash: bool) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        let unreserved = byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~');
        if unreserved || (keep_slash && byte == b'/') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

// ---------------------------------------------------------------------------
// BibTeX 导出
// ---------------------------------------------------------------------------

/// 项目文献导出为 BibTeX 全文（前端复制到剪贴板，不写文件）。
fn export_bibtex_conn(conn: &Connection, project_id: &str) -> Result<String, String> {
    let refs = list_refs_conn(conn, project_id)?;
    Ok(bibtex_document(&refs))
}

fn bibtex_document(refs: &[LiteratureRef]) -> String {
    if refs.is_empty() {
        return String::new();
    }
    let mut out = String::new();
    out.push_str(&format!(
        "% 由 MindBase 文献库导出（共 {} 条）\n\n",
        refs.len()
    ));
    for reference in refs {
        let entry_type = bibtex_type_from_csl(&reference.entry_type);
        out.push('@');
        out.push_str(entry_type);
        out.push('{');
        out.push_str(&reference.cite_key);
        out.push_str(",\n");
        push_bibtex_field(&mut out, "title", &reference.title);
        let authors = authors_from_json(&reference.authors_json);
        if !authors.is_empty() {
            push_bibtex_field(&mut out, "author", &authors.join(" and "));
        }
        if let Some(year) = reference.year {
            push_bibtex_field(&mut out, "year", &year.to_string());
        }
        if !reference.venue.is_empty() {
            let field = match entry_type {
                "article" => "journal",
                "inproceedings" | "incollection" => "booktitle",
                "book" | "techreport" => "publisher",
                _ => "howpublished",
            };
            push_bibtex_field(&mut out, field, &reference.venue);
        }
        if !reference.doi.is_empty() {
            push_bibtex_field(&mut out, "doi", &reference.doi);
        }
        if !reference.url.is_empty() {
            push_bibtex_field(&mut out, "url", &reference.url);
        }
        out.push_str("}\n\n");
    }
    out
}

fn push_bibtex_field(out: &mut String, name: &str, value: &str) {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return;
    }
    out.push_str("  ");
    out.push_str(name);
    out.push_str(" = {");
    out.push_str(&balanced_braces(trimmed));
    out.push_str("},\n");
}

/// 保证写进花括号包裹的值内部花括号配对（否则会破坏 BibTeX 结构）。
fn balanced_braces(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    let mut depth = 0usize;
    for ch in value.chars() {
        match ch {
            '{' => {
                depth += 1;
                out.push(ch);
            }
            '}' => {
                if depth > 0 {
                    depth -= 1;
                    out.push(ch);
                }
                // 多余右花括号丢弃。
            }
            _ => out.push(ch),
        }
    }
    for _ in 0..depth {
        out.push('}');
    }
    out
}

fn authors_from_json(raw: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(raw).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

/// 列出项目文献（按导入时间倒序）。
#[tauri::command]
pub fn literature_list(
    db: State<'_, Db>,
    project_id: String,
) -> Result<Vec<LiteratureRef>, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("获取数据库锁失败：{err}"))?;
    list_refs_conn(&conn, &project_id)
}

/// 导入 BibTeX / CSL-JSON 文本。
#[tauri::command]
pub fn literature_import(
    db: State<'_, Db>,
    project_id: String,
    format: String,
    content: String,
) -> Result<LiteratureImportResult, String> {
    if content.trim().is_empty() {
        return Err("导入内容不能为空".to_string());
    }
    let format = format.trim().to_ascii_lowercase();
    let (entries, errors) = match format.as_str() {
        "bibtex" | "bib" => parse_bibtex(&content),
        "csl" | "csl-json" | "json" => parse_csl(&content)?,
        other => return Err(format!("不支持的文献格式：{other}（仅支持 bibtex 或 csl）")),
    };
    let failed = errors.len();
    if entries.is_empty() {
        let detail = if errors.is_empty() {
            String::new()
        } else {
            format!("：{}", errors.join("；"))
        };
        return Err(format!("未能从内容中解析出任何文献条目{detail}"));
    }

    let mut conn = db
        .conn
        .lock()
        .map_err(|err| format!("获取数据库锁失败：{err}"))?;
    if !project_exists(&conn, &project_id)? {
        return Err(format!("研究项目不存在：{project_id}"));
    }
    let (imported, skipped, refs) = insert_parsed_conn(&mut conn, &project_id, entries)?;
    record_event_conn(
        &conn,
        &project_id,
        "literature.imported",
        &json!({ "imported": imported, "skipped": skipped, "failed": failed }).to_string(),
    );
    Ok(LiteratureImportResult {
        imported,
        skipped,
        failed,
        refs,
        errors,
    })
}

/// 核验单条文献：DOI 精确查询，或（无 DOI 时）按标题检索 Crossref。
///
/// ureq 是阻塞 IO，必须放到 blocking 线程池；持锁只在读写数据库的瞬间。
#[tauri::command]
pub async fn literature_verify(
    db: State<'_, Db>,
    project_id: String,
    ref_id: String,
) -> Result<LiteratureRef, String> {
    let existing = {
        let conn = db
            .conn
            .lock()
            .map_err(|err| format!("获取数据库锁失败：{err}"))?;
        if !project_exists(&conn, &project_id)? {
            return Err(format!("研究项目不存在：{project_id}"));
        }
        get_ref_conn(&conn, &project_id, &ref_id)?.ok_or_else(|| format!("文献不存在：{ref_id}"))?
    };
    if existing.doi.trim().is_empty() && existing.title.trim().is_empty() {
        return Err("该文献既没有 DOI 也没有标题，无法核验".to_string());
    }

    let doi = existing.doi.clone();
    let title = existing.title.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || verify_blocking(&doi, &title))
        .await
        .map_err(|err| format!("核验任务执行失败：{err}"))?;

    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("获取数据库锁失败：{err}"))?;
    let updated = match outcome? {
        VerifyOutcome::Verified(meta) => {
            apply_verified_conn(&conn, &project_id, &ref_id, &existing, &meta)?
        }
        VerifyOutcome::Missing => mark_status_conn(&conn, &project_id, &ref_id, STATUS_MISSING)?,
    };
    record_event_conn(
        &conn,
        &project_id,
        "literature.verified",
        &json!({ "refId": ref_id, "status": updated.status }).to_string(),
    );
    Ok(updated)
}

/// 删除一条文献（幂等）并清理它的引用锚点。
#[tauri::command]
pub fn literature_delete(
    db: State<'_, Db>,
    project_id: String,
    ref_id: String,
) -> Result<(), String> {
    let mut conn = db
        .conn
        .lock()
        .map_err(|err| format!("获取数据库锁失败：{err}"))?;
    delete_ref_conn(&mut conn, &project_id, &ref_id)?;
    record_event_conn(
        &conn,
        &project_id,
        "literature.deleted",
        &json!({ "refId": ref_id }).to_string(),
    );
    Ok(())
}

/// 导出项目全部文献为 BibTeX 文本（空库返回空串）。
#[tauri::command]
pub fn literature_export_bibtex(db: State<'_, Db>, project_id: String) -> Result<String, String> {
    let conn = db
        .conn
        .lock()
        .map_err(|err| format!("获取数据库锁失败：{err}"))?;
    export_bibtex_conn(&conn, &project_id)
}

// ---------------------------------------------------------------------------
// 单元测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn bibtex_entry(content: &str) -> ParsedRef {
        let (entries, errors) = parse_bibtex(content);
        assert!(errors.is_empty(), "解析不应报错：{errors:?}");
        assert_eq!(entries.len(), 1, "应解析出 1 条");
        entries.into_iter().next().expect("entry")
    }

    #[test]
    fn bibtex_authors_split_on_top_level_and() {
        // "Family, Given" 归一化为 "Given Family"；花括号保护的名字不被 and 拆开。
        let entry = bibtex_entry(
            "@article{smith2020, title={A Study of Things}, \
             author={Smith, John and Doe, Jane and {Barnes and Noble}}, \
             year={2020}, journal={Nature}}",
        );
        assert_eq!(
            entry.authors,
            vec![
                "John Smith".to_string(),
                "Jane Doe".to_string(),
                "Barnes and Noble".to_string()
            ]
        );
        assert_eq!(entry.cite_key, "smith2020");
        assert_eq!(entry.title, "A Study of Things");
        assert_eq!(entry.year, Some(2020));
        assert_eq!(entry.venue, "Nature");
        assert_eq!(entry.entry_type, "article-journal");
    }

    #[test]
    fn bibtex_missing_key_is_generated_and_misc_maps_to_document() {
        let entry =
            bibtex_entry("@misc{, title={The Study of Things}, author={Smith, John}, year={2019}}");
        assert_eq!(entry.cite_key, "smith2019study");
        assert_eq!(entry.entry_type, "document");
    }

    #[test]
    fn csl_items_map_to_reference_fields() {
        let item = json!({
            "id": "smith2020",
            "type": "article-journal",
            "title": "A Study of Things",
            "author": [{"family": "Smith", "given": "John"}, {"literal": "某研究组"}],
            "issued": {"date-parts": [[2020, 5, 1]]},
            "container-title": "Nature",
            "DOI": "https://doi.org/10.1000/xyz",
            "URL": "https://example.org/paper"
        });
        let (entries, errors) = parse_csl(&json!([item]).to_string()).expect("解析 CSL");
        assert!(errors.is_empty());
        assert_eq!(entries.len(), 1);
        let entry = &entries[0];
        assert_eq!(entry.cite_key, "smith2020");
        assert_eq!(entry.title, "A Study of Things");
        assert_eq!(
            entry.authors,
            vec!["John Smith".to_string(), "某研究组".to_string()]
        );
        assert_eq!(entry.year, Some(2020));
        assert_eq!(entry.venue, "Nature");
        assert_eq!(entry.doi, "10.1000/xyz");
        assert_eq!(entry.url, "https://example.org/paper");
        assert_eq!(entry.entry_type, "article-journal");
        // 原始 CSL 记录保留在 csl_json 里。
        assert_eq!(
            entry.csl.get("id").and_then(|value| value.as_str()),
            Some("smith2020")
        );
    }

    #[test]
    fn duplicate_cite_keys_are_skipped() {
        let mut conn = Connection::open_in_memory().expect("内存数据库");
        conn.execute_batch(crate::db::SCHEMA_SQL).expect("建表");

        let entry = ParsedRef {
            cite_key: "smith2020study".to_string(),
            title: "A Study of Things".to_string(),
            entry_type: "article-journal".to_string(),
            year: Some(2020),
            ..Default::default()
        };
        let (imported, skipped, refs) =
            insert_parsed_conn(&mut conn, "project-1", vec![entry.clone()]).expect("首次导入");
        assert_eq!((imported, skipped, refs.len()), (1, 0, 1));

        // 同一批次里的重复 + 与库内已有键重复，都应被跳过（导入幂等）。
        let (imported, skipped, refs) =
            insert_parsed_conn(&mut conn, "project-1", vec![entry.clone(), entry])
                .expect("重复导入");
        assert_eq!((imported, skipped, refs.len()), (0, 2, 0));

        // 换一个项目则不受唯一约束影响。
        let duplicate = ParsedRef {
            cite_key: "smith2020study".to_string(),
            title: "A Study of Things".to_string(),
            entry_type: "article-journal".to_string(),
            ..Default::default()
        };
        let (imported, skipped, _) =
            insert_parsed_conn(&mut conn, "project-2", vec![duplicate]).expect("跨项目导入");
        assert_eq!((imported, skipped), (1, 0));
    }

    #[test]
    fn bibtex_export_roundtrips_through_parser() {
        let entry = bibtex_entry(
            "@article{smith2020, title={A Study of Things}, \
             author={Smith, John and Doe, Jane}, year={2020}, journal={Nature}, \
             doi={10.1000/xyz}, url={https://example.org/paper}}",
        );
        let reference = LiteratureRef {
            id: "ref-1".to_string(),
            cite_key: entry.cite_key.clone(),
            doi: entry.doi.clone(),
            title: entry.title.clone(),
            authors_json: serde_json::to_string(&entry.authors).expect("作者序列化"),
            year: entry.year,
            venue: entry.venue.clone(),
            entry_type: entry.entry_type.clone(),
            url: entry.url.clone(),
            status: STATUS_UNVERIFIED.to_string(),
            note: String::new(),
        };
        let text = bibtex_document(&[reference]);
        assert!(text.contains("@article{smith2020,"), "导出内容：{text}");
        assert!(
            text.contains("author = {John Smith and Jane Doe}"),
            "导出内容：{text}"
        );

        let reparsed = bibtex_entry(&text);
        assert_eq!(reparsed.authors, entry.authors);
        assert_eq!(reparsed.year, Some(2020));
        assert_eq!(reparsed.venue, "Nature");
        assert_eq!(reparsed.doi, "10.1000/xyz");
    }

    #[test]
    fn crossref_titles_match_ignoring_case_and_punctuation() {
        assert!(titles_match(
            "A Study of Things: An Introduction",
            "A Study of Things: An Introduction."
        ));
        assert!(titles_match(
            "Attention Is All You Need",
            "attention is all you need"
        ));
        assert!(!titles_match(
            "A Study of Things",
            "Completely Different Paper"
        ));
        assert!(!titles_match("", "Anything"));
    }
}
