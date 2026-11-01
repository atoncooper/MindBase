//! Manuscript → LaTeX (.tex) export.
//!
//! Word export goes through the bundled Python pipeline; LaTeX is generated
//! here in pure Rust so a project can be handed off as a real .tex
//! deliverable without a TeX toolchain: ctexart preamble, one \section per
//! manuscript section, and a references.bib when the project has literature.
//!
//! Markdown support is intentionally small (headings / lists / emphasis /
//! inline code / fenced code / $math$ passthrough / pipe tables) because the
//! body is written by the research agent, not arbitrary Markdown.

use std::path::Path;

use rusqlite::Connection;
use serde::Serialize;

use crate::repositories::manuscript as manuscript_repo;

/// Result of a LaTeX export (paths + counts for the UI / agent).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatexExport {
    pub path: String,
    /// Empty when the project has no literature refs.
    pub bib_path: String,
    pub sections: i64,
    pub words: i64,
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|delta| delta.as_secs() as i64)
        .unwrap_or_default()
}

/// 把某份写作文档的章节导出成 .tex（+ 可选 references.bib），并登记为写作产物。
/// 标题取文档 title（文件命名也用文档 title），项目元信息只提供 paperKind/venue。
pub(crate) fn export_latex(
    conn: &Connection,
    data_dir: &Path,
    project_id: &str,
    document_id: &str,
) -> Result<LatexExport, String> {
    let document = manuscript_repo::documents_find(conn, project_id, document_id)?
        .ok_or_else(|| format!("写作文档不存在：{document_id}"))?;
    let meta = manuscript_repo::project_meta(conn, project_id)?
        .ok_or_else(|| format!("研究项目不存在：{project_id}"))?;
    let title = document.title;
    let (paper_kind, venue) = (meta.paper_kind, meta.target_venue);

    let mut sections: Vec<(String, String)> = Vec::new();
    let mut words: i64 = 0;
    for (heading, path, _ord) in
        manuscript_repo::export_sections(conn, project_id, document_id)?
    {
        let body = if path.is_empty() {
            String::new()
        } else {
            std::fs::read_to_string(&path).unwrap_or_default()
        };
        if body.trim().is_empty() {
            continue;
        }
        words += body.chars().count() as i64;
        sections.push((heading, body));
    }

    let bibtex = crate::workspace::literature::export_bibtex(conn, project_id).unwrap_or_default();
    let has_bib = !bibtex.trim().is_empty();

    let exports = data_dir.join("exports").join("research");
    std::fs::create_dir_all(&exports)
        .map_err(|err| format!("failed to create exports dir: {err}"))?;
    let stamp = file_stamp();
    let base = format!("{}-{stamp}", safe_name(&title));
    let tex_path = exports.join(format!("{base}.tex"));
    let bib_name = format!("{base}.references");
    let bib_path = exports.join(format!("{bib_name}.bib"));

    let mut tex = String::new();
    tex.push_str("\\documentclass[UTF8,a4paper,12pt]{ctexart}\n");
    tex.push_str("\\usepackage{amsmath,amssymb}\n");
    tex.push_str("\\usepackage{graphicx}\n");
    tex.push_str("\\usepackage{booktabs}\n");
    tex.push_str(
        "\\usepackage[colorlinks=true,linkcolor=blue,citecolor=blue,urlcolor=blue]{hyperref}\n",
    );
    tex.push_str(&format!("\\title{{{}}}\n", escape_latex(&title)));
    tex.push_str("\\author{}\n");
    let meta = [paper_kind.trim(), venue.trim()]
        .iter()
        .filter(|item| !item.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join(" · ");
    if meta.is_empty() {
        tex.push_str("\\date{}\n");
    } else {
        tex.push_str(&format!("\\date{{{}}}\n", escape_latex(&meta)));
    }
    tex.push_str("\\begin{document}\n\\maketitle\n");
    if sections.is_empty() {
        tex.push_str("\n% 还没有章节正文，先在「写作」里生成章节。\n");
    }
    for (heading, body) in &sections {
        let clean = strip_section_number(heading);
        tex.push_str(&format!("\n\\section{{{}}}\n", escape_latex(&clean)));
        let body = strip_duplicate_heading(body, &clean);
        tex.push_str(&markdown_to_latex(&body));
        tex.push('\n');
    }
    if has_bib {
        tex.push_str(&format!(
            "\n\\bibliographystyle{{plain}}\n\\bibliography{{{bib_name}}}\n"
        ));
    }
    tex.push_str("\\end{document}\n");

    std::fs::write(&tex_path, tex.as_bytes())
        .map_err(|err| format!("写入 LaTeX 失败（{}）：{err}", tex_path.display()))?;
    if has_bib {
        std::fs::write(&bib_path, bibtex.as_bytes())
            .map_err(|err| format!("写入参考文献 BibTeX 失败（{}）：{err}", bib_path.display()))?;
    }

    // Best effort: register the export as a writing artifact (like DOCX export).
    let artifact_title = tex_path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "manuscript.tex".to_string());
    let now = now_secs();
    let _ = manuscript_repo::insert_export_artifact(
        conn,
        project_id,
        &artifact_title,
        &tex_path.to_string_lossy(),
        now,
    );
    let _ = manuscript_repo::touch_project(conn, project_id, now);

    Ok(LatexExport {
        path: tex_path.to_string_lossy().to_string(),
        bib_path: if has_bib {
            bib_path.to_string_lossy().to_string()
        } else {
            String::new()
        },
        sections: sections.len() as i64,
        words,
    })
}

// ---------------------------------------------------------------------------
// Markdown → LaTeX
// ---------------------------------------------------------------------------

/// 把稿件正文（Markdown + $math$）转成 LaTeX 片段。
pub(crate) fn markdown_to_latex(markdown: &str) -> String {
    let lines: Vec<&str> = markdown.lines().collect();
    let mut out = String::new();
    let mut list_kind: Option<&'static str> = None;
    let mut index = 0usize;

    while index < lines.len() {
        let line = lines[index];
        let trimmed = line.trim();

        // Fenced code block.
        if trimmed.starts_with("```") {
            close_list(&mut out, &mut list_kind);
            let fence = &trimmed[..3];
            index += 1;
            let mut code = String::new();
            while index < lines.len() && !lines[index].trim().starts_with(fence) {
                code.push_str(lines[index]);
                code.push('\n');
                index += 1;
            }
            index += 1; // skip closing fence
            out.push_str("\\begin{verbatim}\n");
            out.push_str(&code);
            out.push_str("\\end{verbatim}\n");
            continue;
        }

        // Blank line: paragraph break.
        if trimmed.is_empty() {
            close_list(&mut out, &mut list_kind);
            ensure_blank_line(&mut out);
            index += 1;
            continue;
        }

        // Headings.
        if let Some((level, text)) = heading(trimmed) {
            close_list(&mut out, &mut list_kind);
            let command = match level {
                1 => "section",
                2 => "subsection",
                3 => "subsubsection",
                _ => "paragraph",
            };
            out.push_str(&format!(
                "\\{command}{{{}}}\n",
                inline_to_latex(&strip_section_number(text))
            ));
            index += 1;
            continue;
        }

        // Pipe table.
        if trimmed.starts_with('|') {
            close_list(&mut out, &mut list_kind);
            let mut rows: Vec<&str> = Vec::new();
            while index < lines.len() && lines[index].trim().starts_with('|') {
                rows.push(lines[index].trim());
                index += 1;
            }
            out.push_str(&render_table(&rows));
            continue;
        }

        // Unordered list.
        if let Some(text) = trimmed
            .strip_prefix("- ")
            .or_else(|| trimmed.strip_prefix("* "))
        {
            open_list(&mut out, &mut list_kind, "itemize");
            out.push_str(&format!("\\item {}\n", inline_to_latex(text.trim())));
            index += 1;
            continue;
        }

        // Ordered list.
        if let Some(text) = ordered_item(trimmed) {
            open_list(&mut out, &mut list_kind, "enumerate");
            out.push_str(&format!("\\item {}\n", inline_to_latex(text)));
            index += 1;
            continue;
        }

        // Paragraph: join consecutive plain lines with spaces.
        close_list(&mut out, &mut list_kind);
        let mut paragraph: Vec<&str> = Vec::new();
        while index < lines.len() {
            let current = lines[index].trim();
            if current.is_empty()
                || current.starts_with('|')
                || current.starts_with("```")
                || heading(current).is_some()
                || current.strip_prefix("- ").is_some()
                || current.strip_prefix("* ").is_some()
                || ordered_item(current).is_some()
            {
                break;
            }
            paragraph.push(current);
            index += 1;
        }
        out.push_str(&inline_to_latex(&paragraph.join(" ")));
        out.push_str("\n\n");
    }

    close_list(&mut out, &mut list_kind);
    out
}

fn close_list(out: &mut String, kind: &mut Option<&'static str>) {
    if let Some(name) = kind.take() {
        out.push_str(&format!("\\end{{{name}}}\n"));
    }
}

fn open_list(out: &mut String, kind: &mut Option<&'static str>, wanted: &'static str) {
    if *kind != Some(wanted) {
        close_list(out, kind);
        out.push_str(&format!("\\begin{{{wanted}}}\n"));
        *kind = Some(wanted);
    }
}

fn ensure_blank_line(out: &mut String) {
    if !out.is_empty() && !out.ends_with("\n\n") {
        out.push('\n');
    }
}

fn heading(line: &str) -> Option<(usize, &str)> {
    let level = line.chars().take_while(|ch| *ch == '#').count();
    if level == 0 || level > 4 {
        return None;
    }
    let text = line[level..].trim();
    if text.is_empty() {
        None
    } else {
        Some((level, text))
    }
}

fn ordered_item(line: &str) -> Option<&str> {
    let digits = line.chars().take_while(char::is_ascii_digit).count();
    if digits == 0 || digits > 3 {
        return None;
    }
    let rest = line[digits..].strip_prefix(". ")?;
    Some(rest.trim())
}

fn strip_section_number(heading: &str) -> String {
    let text = heading.trim();
    let digits = text.chars().take_while(char::is_ascii_digit).count();
    if digits == 0 {
        return text.to_string();
    }
    let rest = text[digits..].trim_start();
    if let Some(stripped) = rest.strip_prefix('.') {
        return stripped.trim_start().to_string();
    }
    if let Some(stripped) = rest.strip_prefix('、') {
        return stripped.trim_start().to_string();
    }
    if rest.len() < text.len() {
        return rest.to_string();
    }
    text.to_string()
}

/// 正文首行若重复了章节标题（AI 常把 "## 3 方法" 也写进正文），去掉这一行。
fn strip_duplicate_heading(body: &str, section_heading: &str) -> String {
    let mut lines: Vec<&str> = body.lines().collect();
    if let Some(position) = lines.iter().position(|line| !line.trim().is_empty()) {
        if let Some((_, text)) = heading(lines[position].trim()) {
            if strip_section_number(text) == section_heading.trim() {
                lines.remove(position);
            }
        }
    }
    lines.join("\n")
}

fn render_table(lines: &[&str]) -> String {
    let mut rows: Vec<Vec<String>> = Vec::new();
    for line in lines {
        let cells: Vec<String> = line
            .trim_matches('|')
            .split('|')
            .map(|cell| cell.trim().to_string())
            .collect();
        if cells.iter().all(|cell| is_table_separator(cell)) {
            continue;
        }
        rows.push(cells);
    }
    if rows.is_empty() {
        return String::new();
    }
    let columns = rows.iter().map(|row| row.len()).max().unwrap_or(0);
    let mut out = String::from("\\begin{table}[htbp]\n\\centering\n");
    out.push_str(&format!(
        "\\begin{{tabular}}{{{}}}\n",
        "l".repeat(columns.max(1))
    ));
    out.push_str("\\toprule\n");
    for (row_index, row) in rows.iter().enumerate() {
        let cells: Vec<String> = (0..columns)
            .map(|column| {
                row.get(column)
                    .map(|cell| inline_to_latex(cell))
                    .unwrap_or_default()
            })
            .collect();
        out.push_str(&cells.join(" & "));
        out.push_str(" \\\\\n");
        if row_index == 0 {
            out.push_str("\\midrule\n");
        }
    }
    out.push_str("\\bottomrule\n\\end{tabular}\n\\end{table}\n");
    out
}

fn is_table_separator(cell: &str) -> bool {
    let trimmed = cell.trim_matches(':');
    !trimmed.is_empty() && trimmed.chars().all(|ch| ch == '-')
}

/// 行内 Markdown → LaTeX：$math$ 原样保留，`code` → \texttt，
/// **bold** → \textbf，*em* → \emph，其余字符转义。
pub(crate) fn inline_to_latex(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::new();
    let mut index = 0usize;
    while index < chars.len() {
        match chars[index] {
            '$' => {
                if let Some(end) = find_char(&chars, index + 1, '$') {
                    out.extend(&chars[index..=end]);
                    index = end + 1;
                } else {
                    out.push_str("\\$");
                    index += 1;
                }
            }
            '`' => {
                if let Some(end) = find_char(&chars, index + 1, '`') {
                    let raw: String = chars[index + 1..end].iter().collect();
                    out.push_str(&format!("\\texttt{{{}}}", escape_latex(&raw)));
                    index = end + 1;
                } else {
                    out.push('`');
                    index += 1;
                }
            }
            '*' if chars.get(index + 1) == Some(&'*') => {
                if let Some(end) = find_double_star(&chars, index + 2) {
                    let inner: String = chars[index + 2..end].iter().collect();
                    out.push_str(&format!("\\textbf{{{}}}", inline_to_latex(&inner)));
                    index = end + 2;
                } else {
                    out.push('*');
                    index += 1;
                }
            }
            '*' => {
                if let Some(end) = find_char(&chars, index + 1, '*') {
                    let inner: String = chars[index + 1..end].iter().collect();
                    out.push_str(&format!("\\emph{{{}}}", inline_to_latex(&inner)));
                    index = end + 1;
                } else {
                    out.push('*');
                    index += 1;
                }
            }
            other => {
                escape_char(other, &mut out);
                index += 1;
            }
        }
    }
    out
}

fn find_char(chars: &[char], from: usize, needle: char) -> Option<usize> {
    (from..chars.len()).find(|index| chars[*index] == needle)
}

fn find_double_star(chars: &[char], from: usize) -> Option<usize> {
    let mut index = from;
    while index + 1 < chars.len() {
        if chars[index] == '*' && chars[index + 1] == '*' {
            return Some(index);
        }
        index += 1;
    }
    None
}

fn escape_latex(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        escape_char(ch, &mut out);
    }
    out
}

fn escape_char(ch: char, out: &mut String) {
    match ch {
        '\\' => out.push_str("\\textbackslash{}"),
        '&' => out.push_str("\\&"),
        '%' => out.push_str("\\%"),
        '#' => out.push_str("\\#"),
        '_' => out.push_str("\\_"),
        '{' => out.push_str("\\{"),
        '}' => out.push_str("\\}"),
        '~' => out.push_str("\\textasciitilde{}"),
        '^' => out.push_str("\\textasciicircum{}"),
        _ => out.push(ch),
    }
}

// ---------------------------------------------------------------------------
// File naming helpers
// ---------------------------------------------------------------------------

fn safe_name(text: &str) -> String {
    let mut out = String::new();
    for ch in text.chars() {
        if ch.is_alphanumeric() || ch == '-' || ch == '_' || ch == ' ' {
            out.push(ch);
        } else {
            out.push('-');
        }
    }
    let trimmed = out.trim().trim_matches('-').to_string();
    if trimmed.is_empty() {
        "manuscript".to_string()
    } else {
        trimmed
    }
}

fn file_stamp() -> String {
    let secs = now_secs();
    let days = secs / 86_400;
    let (year, month, day) = civil_from_days(days);
    let rem = secs % 86_400;
    format!(
        "{year:04}{month:02}{day:02}-{:02}{:02}",
        rem / 3600,
        (rem % 3600) / 60
    )
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_converts_headings_lists_emphasis_and_math() {
        let md = "# 1 引言\n\n这是 **重点** 与 $E=mc^2$ 以及 50% 的样本。\n\n- 第一条\n- 第二条\n\n1. 步骤一\n2. 步骤二\n";
        let tex = markdown_to_latex(md);
        assert!(tex.contains("\\section{引言}"), "heading: {tex}");
        assert!(tex.contains("\\textbf{重点}"), "bold: {tex}");
        assert!(tex.contains("$E=mc^2$"), "math must pass through: {tex}");
        assert!(tex.contains("50\\%"), "percent must be escaped: {tex}");
        assert!(tex.contains("\\begin{itemize}"), "bullets: {tex}");
        assert!(tex.contains("\\begin{enumerate}"), "ordered list: {tex}");
        assert!(tex.contains("\\item 第一条"), "item text: {tex}");
    }

    #[test]
    fn inline_escapes_special_characters() {
        let tex = inline_to_latex("a_b & c#d {e} ~f^g \\h");
        assert!(tex.contains("a\\_b"), "{tex}");
        assert!(tex.contains("\\&"), "{tex}");
        assert!(tex.contains("\\#"), "{tex}");
        assert!(tex.contains("\\{e\\}"), "{tex}");
        assert!(tex.contains("\\textasciitilde{}"), "{tex}");
        assert!(tex.contains("\\textasciicircum{}"), "{tex}");
        assert!(tex.contains("\\textbackslash{}"), "{tex}");
    }

    #[test]
    fn export_latex_writes_tex_and_bib() {
        let mut conn = crate::repositories::manuscript::open_test_connection();
        let project_id = "latex-test";
        let now = now_secs();
        crate::repositories::manuscript::insert_project_for_test(
            &conn,
            project_id,
            "测试论文",
            "writing",
            now,
        )
        .expect("insert project");
        let document_id = "doc-1";
        crate::repositories::manuscript::documents_insert(
            &conn,
            document_id,
            project_id,
            "draft",
            "初稿",
            now,
            now,
        )
        .expect("insert document");
        let dir = std::env::temp_dir().join(format!(
            "mb-latex-test-{}",
            crate::infra::db::local_id()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let section_path = dir.join("method.md");
        std::fs::write(&section_path, "# 3 方法\n\n- 步骤一\n- 步骤二\n\n正文段落。\n")
            .expect("write section");
        crate::repositories::manuscript::insert(
            &conn,
            "sec-1",
            project_id,
            document_id,
            "3 方法",
            3,
            20,
            "draft",
            now,
        )
        .expect("insert section");
        crate::repositories::manuscript::set_path(
            &conn,
            "sec-1",
            &section_path.to_string_lossy(),
        )
        .expect("set section path");
        crate::workspace::literature::import_text(
            &mut conn,
            project_id,
            "bibtex",
            "@article{smith2020, title={A Study}, year={2020}}",
        )
        .expect("insert ref");

        let result =
            export_latex(&conn, &dir, project_id, document_id).expect("export latex");
        let tex = std::fs::read_to_string(&result.path).expect("read tex");
        assert!(tex.contains("\\documentclass"), "preamble: {tex}");
        assert!(tex.contains("\\section{方法}"), "section heading: {tex}");
        assert!(tex.contains("\\begin{itemize}"), "list: {tex}");
        assert!(tex.contains("\\bibliography{"), "bibliography hook: {tex}");
        assert!(Path::new(&result.bib_path).is_file(), "bib file must exist");
        assert_eq!(result.sections, 1);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
