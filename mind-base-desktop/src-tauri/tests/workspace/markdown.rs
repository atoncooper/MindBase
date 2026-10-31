//! workspace::notes::markdown：script/iframe 剔除、危险 URL 协议中和。

use mind_base_desktop_lib::testing::sanitize_markdown;

#[test]
fn script_blocks_are_removed() {
    let sanitized = sanitize_markdown("hello<script>alert(1)</script>world");
    assert!(!sanitized.to_lowercase().contains("<script"), "script block survives");
    assert!(sanitized.contains("hello"));
    assert!(sanitized.contains("world"));
}

#[test]
fn dangerous_link_schemes_collapse_to_hash() {
    let sanitized = sanitize_markdown("[click](javascript:alert(1)) 和 [data](data:text/html,x)");
    assert!(!sanitized.contains("javascript:"), "javascript scheme survives");
    assert!(!sanitized.contains("data:text/html"), "data scheme survives");
    assert!(sanitized.contains("]("), "safe markdown syntax should remain readable");
}

#[test]
fn safe_markdown_is_kept() {
    let source = "# 标题\n\n正文 **加粗** [链接](https://example.com)";
    let sanitized = sanitize_markdown(source);
    assert!(sanitized.contains("# 标题"));
    assert!(sanitized.contains("https://example.com"));
}
