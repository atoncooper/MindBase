//! 手写 BibTeX 解析：条目 / 字段 / 作者拆分与 BibTeX→CSL 条目类型映射。

mod export;

pub(crate) use export::export_bibtex_conn;

use super::csl::bibtex_entry_to_csl;
use super::types::ParsedRef;
use super::util::{clean_bibtex_value, make_cite_key, normalize_doi, parse_year, sanitize_cite_key};

// ---------------------------------------------------------------------------
// BibTeX 解析（手写）
// ---------------------------------------------------------------------------

/// 解析完整的 BibTeX 文本，返回（条目、逐条错误）。
///
/// 扫描策略：从 @ 开始读条目类型，定位 { 或 ( 后按括号配对找到条目结尾；
/// 条目体再按顶层逗号切字段。@string / @comment / @preamble 直接忽略。
pub(super) fn parse_bibtex(input: &str) -> (Vec<ParsedRef>, Vec<String>) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use super::export::bibtex_document;
    use super::super::types::{LiteratureRef, STATUS_UNVERIFIED};

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
}
