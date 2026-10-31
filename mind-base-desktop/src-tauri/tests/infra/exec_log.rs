//! infra::exec_log：头尾摘要、按字节分页、配额清理。

use std::path::PathBuf;

use crate::common::temp_dir;

fn write_file(tag: &str, name: &str, body: &[u8]) -> (PathBuf, String) {
    let root = temp_dir(tag);
    let path = root.join(name);
    std::fs::write(&path, body).expect("write fixture");
    let text = String::from_utf8_lossy(body).to_string();
    (root, text)
}

#[test]
fn summarize_keeps_head_and_tail_with_omission_marker() {
    let (root, _) = write_file("infra-exec-log", "big.log", b"");
    let path = root.join("big.log");
    let body = "line-0\n".repeat(1) + &"x".repeat(8 * 1024) + "\nline-tail\n";
    std::fs::write(&path, &body).expect("write big log");
    let total = body.len() as u64;
    let summary = mind_base_desktop_lib::testing::summarize_log(&path, total);
    assert!(summary.contains("line-0"), "head missing: {summary}");
    assert!(summary.contains("line-tail"), "tail missing: {summary}");
    assert!(summary.contains("中间省略"), "no omission marker");
    assert!(summary.len() < 8 * 1024, "summary should be bounded, got {}", summary.len());
    assert!(summary.contains(path.to_string_lossy().as_ref()) || summary.contains("完整输出"));
}

#[test]
fn read_slice_pages_by_byte_offset() {
    let (root, _) = write_file("infra-read-slice", "a.log", b"");
    let path = root.join("a.log");
    std::fs::write(&path, "0123456789abcdef").expect("write");
    let (text, total) = mind_base_desktop_lib::testing::read_log_slice(&path, 4, 6).expect("slice");
    assert_eq!(total, 16);
    assert_eq!(text, "456789");
}

#[test]
fn prune_keeps_directory_under_file_budget() {
    let root = temp_dir("infra-prune");
    for index in 0..205 {
        std::fs::write(root.join(format!("{index:04}.log")), b"x").expect("write");
    }
    mind_base_desktop_lib::testing::prune_logs(&root);
    let remaining = std::fs::read_dir(&root).expect("read dir").count();
    assert!(remaining <= 200, "prune should keep <=200 files, got {remaining}");
    assert!(remaining >= 190, "prune should not delete everything, got {remaining}");
}
