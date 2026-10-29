//! URL-scheme sanitizer: strips HTML blocks and neutralizes dangerous link targets.

/// Neutralize dangerous link targets inside markdown.
///
/// Mirrors the spirit of app/services/notes/markdown.py scaled to plain
/// markdown text: script/iframe blocks are dropped entirely and any link or
/// autolink target carrying `javascript:` / `vbscript:` / `data:` collapses
/// to `#`. BlockNote-free markdown rarely contains raw HTML, but pasted
/// content is attacker-controlled by definition.
pub(crate) fn sanitize_markdown(markdown: &str) -> String {
    let mut text = remove_html_blocks(markdown);
    text = sanitize_link_targets(&text);
    text
}

/// Drop `<script …>…</script>` / `<iframe …>…</iframe>` blocks wholesale,
/// repeatedly, case-insensitive.
fn remove_html_blocks(text: &str) -> String {
    const PAIRS: [(&str, &str); 2] = [
        ("<script", "</script>"),
        ("<iframe", "</iframe>"),
    ];
    let mut current = text.to_string();
    for (open_tag, close_tag) in PAIRS {
        while let Some(start) = find_case_insensitive(&current, open_tag) {
            let Some(rel_end) = find_case_insensitive(&current[start..], close_tag) else {
                // Unterminated block: strip to the end of the document.
                current.truncate(start);
                break;
            };
            let end = start + rel_end + close_tag.len();
            current.replace_range(start..end, "");
        }
    }
    current
}

/// Case-insensitive substring search over UTF-8 (ASCII pattern).
fn find_case_insensitive(haystack: &str, needle: &str) -> Option<usize> {
    let lower = haystack.to_lowercase();
    lower.find(&needle.to_lowercase())
}

/// True when a URL target starts with a scheme we refuse to keep.
fn is_dangerous_target(target: &str) -> bool {
    let trimmed = target.trim().to_lowercase();
    ["javascript:", "vbscript:", "data:"]
        .iter()
        .any(|scheme| trimmed.starts_with(scheme))
}

/// Rewrite `[text](target)` links whose target carries a dangerous scheme —
/// the target collapses to `#`. Targets are collected with paren balancing so
/// payloads like `(javascript:alert(1))` are consumed in full.
fn sanitize_link_targets(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let bytes = text.as_bytes();
    let mut search_from = 0usize;
    loop {
        let Some(rel) = text[search_from..].find("](") else {
            output.push_str(&text[search_from..]);
            break;
        };
        let open_paren = search_from + rel + 1;
        output.push_str(&text[search_from..=open_paren]);

        // Collect the balanced target region.
        let mut pos = open_paren + 1;
        let mut depth = 0i32;
        let mut closed = false;
        while pos < bytes.len() {
            match bytes[pos] {
                b'(' => depth += 1,
                b')' => {
                    if depth == 0 {
                        closed = true;
                        pos += 1;
                        break;
                    }
                    depth -= 1;
                }
                _ => {}
            }
            pos += 1;
        }
        let end_target = if closed { pos - 1 } else { pos };
        let raw_target = &text[open_paren + 1..end_target];
        if is_dangerous_target(raw_target.trim()) {
            output.push('#');
        } else {
            output.push_str(raw_target);
        }
        if closed {
            output.push(')');
        }
        search_from = pos;
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    // -- sanitizer ----------------------------------------------------------

    #[test]
    fn dangerous_schemes_collapse_to_hash() {
        assert_eq!(
            sanitize_markdown("[点我](javascript:alert(1))"),
            "[点我](#)"
        );
        assert_eq!(sanitize_markdown("[x](data:text/html;base64,xxx)"), "[x](#)");
        assert_eq!(sanitize_markdown("[x](vbscript:x)"), "[x](#)");
        // Safe targets survive untouched, case preserved.
        assert_eq!(
            sanitize_markdown("[b站](https://www.bilibili.com/video/BVxx)"),
            "[b站](https://www.bilibili.com/video/BVxx)"
        );
    }

    #[test]
    fn script_and_iframe_blocks_are_removed_case_insensitive() {
        let payload = "<SCRIPT>alert(1)</script>正文继续";
        assert_eq!(sanitize_markdown(payload), "正文继续");
        let unterminated = "开头<iframe src=\"x\" 永远不结束";
        assert_eq!(sanitize_markdown(unterminated), "开头");
    }

    #[test]
    fn benign_markdown_passes_through_unchanged() {
        let md = "# 标题\n\n- 列表项\n- **加粗** 与 `代码`\n";
        assert_eq!(sanitize_markdown(md), md);
    }
}
