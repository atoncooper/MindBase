//! BibTeX 文本导出（前端复制到剪贴板，不写文件）。

use rusqlite::Connection;

use super::bibtex_type_from_csl;
use super::super::store::list_refs_conn;
use super::super::types::LiteratureRef;

// ---------------------------------------------------------------------------
// BibTeX 导出
// ---------------------------------------------------------------------------

/// 项目文献导出为 BibTeX 全文（前端复制到剪贴板，不写文件）。
pub(crate) fn export_bibtex_conn(conn: &Connection, project_id: &str) -> Result<String, String> {
    let refs = list_refs_conn(conn, project_id)?;
    Ok(bibtex_document(&refs))
}

pub(crate) fn bibtex_document(refs: &[LiteratureRef]) -> String {
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
