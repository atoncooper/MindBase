//! automation::log_index：日期分区路径、尾部读取、关键字检索。

use crate::common::temp_dir;
use mind_base_desktop_lib::automation::log_index;

#[test]
fn log_paths_are_partitioned_by_date_and_run() {
    // 2026-10-28T10:00:00Z = 1793172000
    let epoch = 1_793_172_000;
    let (stdout, stderr) = log_index::run_log_paths(std::path::Path::new("D:/data"), 7, 12, epoch);
    let stdout_text = stdout.to_string_lossy().replace('\\', "/");
    assert!(stdout_text.contains("automation/7/2026-10-28/"), "bad partition: {stdout_text}");
    assert!(stdout_text.contains("2026-10-28T"), "bad date: {stdout_text}");
    assert!(stdout_text.contains("_run-12.log"), "bad run name: {stdout_text}");
    assert!(stderr.to_string_lossy().ends_with("run-12.err.log"));
}

#[test]
fn read_tail_and_search_find_recent_lines() {
    let root = temp_dir("automation-log-index");
    let path = root.join("run.log");
    let body = format!("start\n{}ERROR CUDA out of memory\ntail line\n", "x".repeat(3000));
    std::fs::write(&path, body).expect("write log");
    let tail = log_index::read_tail(&path, 200);
    assert!(tail.contains("tail line"));
    let matches = log_index::search_lines(&[path.clone()], "cuda out of memory", 10)
        .expect("search should work");
    assert_eq!(matches.len(), 1);
    assert!(matches[0].line.contains("ERROR"));
    assert_eq!(matches[0].line_no, 2);
}
