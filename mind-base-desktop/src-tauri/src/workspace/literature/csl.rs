//! CSL-JSON 解析与 BibTeX 条目→等效 CSL 对象的转换。

use serde_json::{json, Value};

use super::types::ParsedRef;
use super::util::{collapse_whitespace, make_cite_key, normalize_doi, parse_year, sanitize_cite_key, split_display_name};

/// BibTeX 条目 → 等效 CSL 对象，写入 csl_json 列（保持两种来源下游一致）。
pub(super) fn bibtex_entry_to_csl(
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

// ---------------------------------------------------------------------------
// CSL-JSON 解析
// ---------------------------------------------------------------------------

/// 解析 CSL-JSON。返回（条目、逐条错误）；顶层 JSON 语法错误直接 Err。
pub(super) fn parse_csl(input: &str) -> Result<(Vec<ParsedRef>, Vec<String>), String> {
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
pub(super) fn first_string(value: &Value) -> Option<String> {
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
pub(super) fn csl_year(item: &Value) -> Option<i64> {
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
